import express from 'express'
import cors from 'cors'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import ytdl from '@distube/ytdl-core'
import YTDlpWrapModule from 'yt-dlp-wrap'
const YTDlpWrap = YTDlpWrapModule.default || YTDlpWrapModule
import ffmpegStaticPath from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import { spawn, execFile } from 'node:child_process'
import { scoreVideo, detectSilences, buildKeepSegments, remapWords } from './scoring.js'
import { selectClipsWithLlm, LLM_PROVIDERS } from './llm-selection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ffmpegPath = ffmpegStaticPath.includes('app.asar' + path.sep) ? ffmpegStaticPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : ffmpegStaticPath
const ffprobePath = ffprobe.path.includes('app.asar' + path.sep) ? ffprobe.path.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep) : ffprobe.path
const faceScript = path.join(__dirname, 'face_track.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
const rootDir = path.resolve(__dirname, '..')
const dataDir = process.env.CLIPFORGE_DATA_DIR || path.join(rootDir, 'storage')
const jobsDir = path.join(dataDir, 'jobs')
const binaryDir = path.join(dataDir, 'bin')
const modelDir = path.join(dataDir, 'models')
const faceModelPath = path.join(modelDir, 'yunet.onnx')
const faceModelUrl = 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'
const ytDlpBinary = path.join(binaryDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
const port = Number(process.env.PORT || 8787)
const jobs = new Map()

await fs.mkdir(jobsDir, { recursive: true })
await fs.mkdir(binaryDir, { recursive: true })

async function getYtDlp() {
  try {
    await fs.access(ytDlpBinary)
  } catch {
    console.log('Downloading yt-dlp standalone binary...')
    const [release] = await YTDlpWrap.getGithubReleases(1, 1)
    const asset = process.platform === 'darwin' ? 'yt-dlp_macos' : process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux'
    await YTDlpWrap.downloadFile(`https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}/${asset}`, ytDlpBinary)
    if (process.platform !== 'win32') await fs.chmod(ytDlpBinary, 0o755)
  }
  return new YTDlpWrap(ytDlpBinary)
}

const ytDlp = await getYtDlp()

const app = express()
app.use(cors())
app.use(express.json({ limit: '50kb' }))
app.use('/media', express.static(jobsDir, { maxAge: '1h' }))

function isYoutubeUrl(value) {
  try {
    const url = new URL(value)
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(url.hostname)
  } catch {
    return false
  }
}

function runCommand(command, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.on('data', (chunk) => onLine?.(chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-1200) || `Command failed with code ${code}`)))
  })
}

async function probeVideo(input) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input])
    let value = ''
    let error = ''
    child.stdout.on('data', (chunk) => { value += chunk.toString() })
    child.stderr.on('data', (chunk) => { error += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(value.trim()) : reject(new Error(error)))
  })
  const duration = Number(output)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durasi video tidak dapat dibaca')
  return duration
}

// Longer videos are fetched at lower resolution so the download and later analysis stay manageable.
async function pickMaxHeight(url) {
  try {
    const seconds = Number((await ytDlp.execPromise([url, '--no-playlist', '--no-warnings', '--skip-download', '--print', '%(duration)s'])).trim().split('\n').pop())
    if (seconds > 3600) return { height: 360, seconds }
    if (seconds > 1200) return { height: 480, seconds }
    return { height: 720, seconds }
  } catch {
    return { height: 720, seconds: null }
  }
}

async function downloadYoutubeVideo(url, target, job) {
  try {
    const { height, seconds } = await pickMaxHeight(url)
    if (job && seconds) job.message = `Mengambil video (${Math.round(seconds / 60)} menit, maks ${height}p)`
    // Abort only when the download stalls, not when a long video simply takes a while.
    await new Promise((resolve, reject) => {
      const emitter = ytDlp.exec([
        url,
        '--no-playlist',
        '--no-warnings',
        '--format', `bv*[height<=${height}]+ba/b[height<=${height}]/b`,
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegPath,
        '--output', target,
      ])
      let stall
      const arm = () => {
        clearTimeout(stall)
        stall = setTimeout(() => {
          emitter.ytDlpProcess?.kill()
          reject(new Error('Download YouTube timeout: tidak ada kemajuan selama 5 menit'))
        }, 300_000)
      }
      arm()
      emitter.on('progress', (progress) => {
        arm()
        if (job && Number.isFinite(progress.percent)) job.progress = Math.min(14, Math.round(progress.percent * 0.14))
      })
      emitter.on('error', (error) => { clearTimeout(stall); reject(error) })
      emitter.on('close', (code) => { clearTimeout(stall); code === 0 || code === null ? resolve() : reject(new Error(`yt-dlp keluar dengan kode ${code}`)) })
    })
    return
  } catch (ytDlpError) {
    if (ytDlpError.message.includes('timeout')) throw ytDlpError
    try {
      const info = await ytdl.getInfo(url)
      const format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: (candidate) => candidate.hasVideo && candidate.hasAudio && candidate.container === 'mp4' })
      if (!format?.url) throw new Error('Format video MP4 dengan audio tidak tersedia')
      await pipeline(ytdl.downloadFromInfo(info, { format }), createWriteStream(target))
    } catch (fallbackError) {
      throw new Error(fallbackError.message || ytDlpError.message)
    }
  }
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${remainder}`
}

function parseTimestamp(value) {
  const parts = value.trim().replace(',', '.').split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
}

// Returns words with timings. YouTube auto-captions carry per-word timestamps; manual subtitles are spread evenly.
function parseCaptionFile(contents) {
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/)
  const blocks = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/)
    if (!match) continue
    const start = parseTimestamp(match[1])
    const end = parseTimestamp(match[2])
    const text = []
    for (index += 1; index < lines.length && lines[index] !== ''; index += 1) text.push(lines[index])
    if (start !== null && end !== null && end > start) blocks.push({ start, end, lines: text })
  }
  const hasWordTimes = blocks.some((block) => block.lines.some((line) => /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(line)))
  const words = []
  for (const block of blocks) {
    if (hasWordTimes) {
      const line = block.lines.find((candidate) => /<\d{2}:\d{2}:\d{2}\.\d{3}>/.test(candidate))
      if (!line) continue
      const parts = line.split(/<(\d{2}:\d{2}:\d{2}\.\d{3})>/)
      let time = block.start
      for (let i = 0; i < parts.length; i += 1) {
        if (i % 2 === 1) { time = parseTimestamp(parts[i]); continue }
        const text = decodeEntities(parts[i].replace(/<[^>]*>/g, '')).trim()
        for (const word of text.split(/\s+/).filter(Boolean)) words.push({ start: time, end: time, text: word })
      }
    } else {
      const text = decodeEntities(block.lines.join(' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
      const list = text.split(' ').filter(Boolean)
      const step = (block.end - block.start) / Math.max(1, list.length)
      list.forEach((word, i) => words.push({ start: block.start + i * step, end: block.start + (i + 1) * step, text: word }))
    }
  }
  words.sort((a, b) => a.start - b.start)
  for (let i = 0; i < words.length; i += 1) {
    const next = words[i + 1]
    const limit = words[i].start + 0.8
    if (words[i].end <= words[i].start) words[i].end = next ? Math.min(next.start, limit) : limit
  }
  return words.filter((word, i) => !(i > 0 && word.start === words[i - 1].start && word.text === words[i - 1].text))
}

function assTime(seconds) {
  const centiseconds = Math.floor((seconds % 1) * 100)
  const wholeSeconds = Math.floor(seconds)
  return `${Math.floor(wholeSeconds / 3600)}:${String(Math.floor((wholeSeconds % 3600) / 60)).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

function assEscape(text) {
  return text.replace(/[{}]/g, '').replace(/\\/g, '\\\\').replace(/\n/g, '\\N')
}

function chunkWords(words, maxChars, maxWords) {
  const chunks = []
  let current = []
  const length = (list) => list.reduce((sum, word) => sum + word.text.length + 1, 0)
  for (const word of words) {
    const previous = current.at(-1)
    const gap = previous ? word.start - previous.end : 0
    if (current.length && (current.length >= maxWords || length(current) + word.text.length > maxChars || gap > 0.7 || /[.!?,]$/.test(previous.text))) {
      chunks.push(current)
      current = []
    }
    current.push(word)
  }
  if (current.length) chunks.push(current)
  return chunks
}

function pickKeyWord(chunk) {
  let best = -1
  let bestLength = 3
  chunk.forEach((word, i) => {
    const length = word.text.replace(/[^\p{L}\p{N}]/gu, '').length
    if (length >= bestLength) { best = i; bestLength = length }
  })
  return best
}

const captionTemplates = {
  clean: {
    font: 'Helvetica Neue', size: [60, 82], bold: -1, italic: 0, upper: false, chunk: [[30, 4], [22, 3]], y: [0.84, 0.64],
    spoken: { c: '&H00FFFFFF', a: '&H00&' }, active: { c: '&H00FFFFFF', a: '&H00&' }, upcoming: '&H8C&',
    outline: 2, shadow: 3, outlineColor: '&H00000000', pop: 100, spacing: -1,
  },
  neon: {
    font: 'Helvetica Neue', size: [52, 64], bold: -1, italic: 0, upper: false, chunk: [[34, 4], [24, 4]], y: [0.8, 0.6], anchor: 5, stack: true,
    spoken: { c: '&H0033FFC8&', a: '&H00&' }, active: { c: '&H0033FFC8&', a: '&H00&' }, upcoming: '&H8C&',
    outline: 0, shadow: 0, outlineColor: '&H0010C890&', pop: 100, spacing: -2, keyScale: 2.1, smallScale: 0.8, glow: { bord: 9, blur: 7, a: '&H78&' },
  },
  blurstack: {
    font: 'Helvetica Neue', size: [58, 80], bold: -1, italic: 0, upper: false, chunk: [[24, 3], [18, 3]], y: [0.82, 0.62], anchor: 5, stack: true, blurIn: true,
    spoken: { c: '&H00FFFFFF', a: '&H00&' }, active: { c: '&H00FFFFFF', a: '&H00&' }, upcoming: '&H59&',
    outline: 0, shadow: 4, outlineColor: '&H00000000', pop: 100, spacing: -1, keyScale: 1.7, smallScale: 0.85,
  },
  kinetic: {
    font: 'Helvetica Neue', size: [78, 110], bold: -1, italic: 0, upper: true, chunk: [[16, 2], [12, 2]], y: [0.7, 0.55],
    spoken: { c: '&H00FFFFFF', a: '&H00&' }, active: { c: '&H0000E6FF&', a: '&H00&' }, upcoming: '&H00&',
    outline: 6, shadow: 0, outlineColor: '&H00000000', pop: 120, spacing: -2,
  },
  retro: {
    font: 'Impact', size: [66, 92], bold: 0, italic: 0, upper: true, chunk: [[20, 2], [14, 2]], y: [0.8, 0.6],
    spoken: { c: '&H00C8E9F5&', a: '&H00&' }, active: { c: '&H00C8E9F5&', a: '&H00&' }, upcoming: '&H00&',
    outline: 7, shadow: 3, outlineColor: '&H00182030&', pop: 100, spacing: 1,
  },
  offer: {
    font: 'Helvetica Neue', size: [64, 88], bold: -1, italic: 0, upper: false, chunk: [[22, 3], [16, 3]], y: [0.8, 0.6],
    spoken: { c: '&H00FF6B1E&', a: '&H00&' }, active: { c: '&H00FF6B1E&', a: '&H00&' }, upcoming: '&H00&',
    outline: 4, shadow: 0, outlineColor: '&H00FFFFFF&', pop: 110, spacing: 0,
  },
}

async function writeAssCaptions(clip, words, target, outputFormat, template) {
  const portrait = outputFormat === 'portrait'
  const width = portrait ? 1080 : 1280
  const height = portrait ? 1920 : 720
  const style = captionTemplates[template] || captionTemplates.clean
  const mode = portrait ? 1 : 0
  const size = style.size[mode]
  const [maxChars, maxWords] = style.chunk[mode]
  const clipEnd = clip.start + clip.duration
  const inClip = words
    .filter((word) => !/^(\[.*\]|>>+|♪+)$/.test(word.text))
    .filter((word) => word.end > clip.start && word.start < clipEnd)
    .map((word) => ({ ...word, start: Math.max(0, word.start - clip.start), end: Math.min(clip.duration, word.end - clip.start) }))
  const chunks = chunkWords(inClip, maxChars, maxWords)
  const baseY = Math.round(height * style.y[mode])
  const wordTags = (state, bord, color) => `{\\1c${state.c}\\3c${color}\\bord${bord}\\alpha${state.a}`
  const events = []
  chunks.forEach((chunk, chunkIndex) => {
    const nextStart = chunks[chunkIndex + 1]?.[0].start
    const chunkEnd = Math.min(chunk.at(-1).end + 0.15, nextStart ?? Infinity, clip.duration)
    chunk.forEach((word, wordIndex) => {
      const from = wordIndex === 0 ? chunk[0].start : word.start
      const to = chunk[wordIndex + 1] ? chunk[wordIndex + 1].start : chunkEnd
      if (to <= from) return
      const keyIndex = style.stack && chunk.length > 1 ? pickKeyWord(chunk) : -1
      const text = chunk.map((item, i) => {
        const label = assEscape(style.upper ? item.text.toUpperCase() : item.text)
        const isKey = i === keyIndex
        const state = i < wordIndex ? style.spoken : i === wordIndex ? style.active : { c: style.spoken.c, a: style.upcoming }
        const upcoming = i > wordIndex
        let color = state.c
        let tags = `\\fn${style.font}\\i${style.italic}\\b${style.bold}`
        if (style.stack) tags += `\\fs${Math.round(size * (isKey ? style.keyScale : style.smallScale))}`
        if (isKey && style.key) {
          tags = `\\fn${style.key.font}\\i${style.key.italic}\\b${style.key.bold}\\fs${Math.round(size * style.keyScale)}`
          color = style.key.c
        }
        const bord = i === wordIndex ? (style.active.bord ?? style.outline) : style.outline
        const outlineColor = i === wordIndex ? (style.active.outlineColor ?? style.outlineColor) : style.outlineColor
        let glow = ''
        if (style.glow && !upcoming) glow = `\\bord${style.glow.bord}\\blur${style.glow.blur}\\3a${style.glow.a}`
        else if (style.glow) glow = '\\bord0\\blur0'
        let scale = '\\fscx100\\fscy100'
        if (i === wordIndex) {
          scale = style.pop > 100
            ? `\\fscx${style.pop}\\fscy${style.pop}\\t(0,110,\\fscx100\\fscy100)`
            : style.pop < 100 ? `\\fscx${style.pop}\\fscy${style.pop}\\t(0,90,\\fscx108\\fscy108)\\t(90,170,\\fscx100\\fscy100)` : ''
        }
        const base = `{\\1c${color}\\3c${outlineColor}\\bord${bord}\\alpha${state.a}${glow}${tags}${scale}}`
        const brk = style.stack && keyIndex >= 0 ? (isKey ? (i > 0 ? '\\N' : '') : (keyIndex >= 0 && i === keyIndex + 1 ? '\\N' : '')) : ''
        return `${brk}${base}${label}`
      }).join(' ').replace(/ \\N/g, '\\N')
      const an = style.anchor ? `\\an${style.anchor}` : ''
      const blurIn = style.blurIn ? '\\blur10\\t(0,320,\\blur0)' : ''
      const intro = wordIndex === 0
        ? `{${an}\\fad(80,0)${blurIn}\\move(${width / 2},${baseY + 26},${width / 2},${baseY},0,140)}`
        : `{${an}\\pos(${width / 2},${baseY})}`
      events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Default,,0,0,0,,${intro}${text}`)
    })
  })
  if (!events.length) return false
  const margin = portrait ? 110 : 110
  const content = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes',
    '', '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.font},${size},${style.spoken.c},&H000000FF,${style.outlineColor},&H90000000,${style.bold},${style.italic},0,0,100,100,${style.spacing},0,1,${style.outline},${style.shadow},2,${margin},${margin},60,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events,
  ].join('\n')
  await fs.writeFile(target, content, 'utf8')
  return true
}

async function findCaptionCues(jobDir) {
  const files = await fs.readdir(jobDir)
  const captionFile = files.find((file) => /\.(vtt|srt)$/i.test(file))
  if (!captionFile) return []
  return parseCaptionFile(await fs.readFile(path.join(jobDir, captionFile), 'utf8'))
}

function createHighlights(duration, count = 8) {
  const clipLength = Math.min(58, Math.max(15, Math.min(28, Math.floor(duration / (count + 1)))))
  const anchors = Array.from({ length: count }, (_, i) => Math.max(0, duration * ((i + 1) / (count + 1)) - clipLength / 2))
  const labels = ['Peak insight', 'Story beat', 'Strong quote']
  const titles = ['Momen paling penting dari video', 'Bagian cerita yang paling kuat', 'Insight yang layak dibagikan']
  return anchors.map((start, index) => {
    const safeStart = Math.min(start, Math.max(0, duration - clipLength))
    return {
      id: index + 1,
      title: `${titles[index % 3]} #${index + 1}`,
      tag: labels[index % 3],
      start: Number(safeStart.toFixed(2)),
      duration: Math.min(clipLength, duration - safeStart),
      score: `${Math.max(60, 94 - index * 4)}%`,
      color: ['clip-one', 'clip-two', 'clip-three'][index % 3],
    }
  })
}

async function ensureFaceModel() {
  try {
    await fs.access(faceModelPath)
  } catch {
    await fs.mkdir(modelDir, { recursive: true })
    if (process.env.CLIPFORGE_RESOURCES) {
      try {
        await fs.copyFile(path.join(process.env.CLIPFORGE_RESOURCES, 'yunet.onnx'), faceModelPath)
        return
      } catch {}
    }
    const reply = await fetch(faceModelUrl)
    if (!reply.ok) throw new Error(`Model face detector gagal diunduh (${reply.status})`)
    await fs.writeFile(faceModelPath, Buffer.from(await reply.arrayBuffer()))
  }
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    execFile('python3', args, { maxBuffer: 20 * 1024 * 1024, timeout: 3_600_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.split('\n').filter((line) => line && !line.includes('WARN')).slice(-3).join(' ') || error.message))
      else resolve(stdout)
    })
  })
}

// Follows the main face across the clip and returns an ffmpeg crop-x expression for a 9:16 window, or null if tracking is unavailable.
async function trackFaceCrop(source, clip) {
  await ensureFaceModel()
  const result = JSON.parse(await runPython([faceScript, source, String(clip.start), String(clip.duration), faceModelPath]))
  if (!result.points.some((point) => point.found)) return null
  const scaledWidth = Math.round((result.width * 1920) / result.height)
  if (scaledWidth <= 1080) return null
  const xs = result.points
    .filter((_, index) => index % 2 === 0)
    .map((point) => ({ t: point.t, x: Math.min(scaledWidth - 1080, Math.max(0, Math.round(point.cx * scaledWidth - 540))) }))
  const terms = []
  for (let i = 0; i < xs.length - 1; i += 1) {
    const [a, b] = [xs[i], xs[i + 1]]
    terms.push(`gte(t,${a.t})*lt(t,${b.t})*(${a.x}+${b.x - a.x}*(t-${a.t})/${(b.t - a.t).toFixed(2)})`)
  }
  const last = xs.at(-1)
  terms.push(`gte(t,${last.t})*${last.x}`)
  return terms.join('+')
}

function subtitlesFilterFor(assFile) {
  return `subtitles='${assFile.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`
}

// Caption saja di atas latar hijau (#00FF00) supaya bisa di-chroma key di editor.
async function renderCaptionLayer(assFile, target, duration, outputFormat) {
  const size = outputFormat === 'portrait' ? '1080x1920' : '1280x720'
  const args = ['-y', '-f', 'lavfi', '-i', `color=c=0x00FF00:s=${size}:r=30:d=${duration}`, '-vf', subtitlesFilterFor(assFile), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', target]
  await runCommand(ffmpegPath, args, () => {})
}

async function cutClip(source, target, clip, options, assFile, update) {
  const { muteMusic, outputFormat, portraitMode, cropX } = options
  const audioFilters = muteMusic ? ['highpass=f=80', 'lowpass=f=8000', 'afftdn=nr=12:nf=-25'] : []
  const portrait = outputFormat === 'portrait'
  const blur = portrait && portraitMode === 'blur'
  const subtitlesFilter = assFile ? subtitlesFilterFor(assFile) : null
  let videoArgs
  if (blur) {
    // Frame landscape utuh di tengah 9:16, bagian atas-bawah diisi versi blur dari frame yang sama.
    const stages = [
      '[0:v]split=2[bg][fg]',
      '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=40:luma_power=2[blurred]',
      '[fg]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[sharp]',
      `[blurred][sharp]overlay=(W-w)/2:(H-h)/2${subtitlesFilter ? `,${subtitlesFilter}` : ''}[out]`,
    ]
    videoArgs = ['-filter_complex', stages.join(';'), '-map', '[out]']
  } else {
    const videoFilters = portrait
      ? (cropX ? ['scale=-2:1920', `crop=1080:1920:x='${cropX}':y=0`, 'setsar=1'] : ['scale=1080:1920:force_original_aspect_ratio=increase', 'crop=1080:1920', 'setsar=1'])
      : ['scale=1280:720:force_original_aspect_ratio=decrease', 'pad=1280:720:(ow-iw)/2:(oh-ih)/2', 'setsar=1']
    if (subtitlesFilter) videoFilters.push(subtitlesFilter)
    videoArgs = ['-map', '0:v:0', '-vf', videoFilters.join(',')]
  }
  const args = ['-y', '-ss', String(clip.start), '-i', source, '-t', String(clip.duration), ...videoArgs, '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
  if (audioFilters.length) args.push('-af', audioFilters.join(','))
  args.push('-c:a', 'aac', '-b:a', '128k', target)
  await runCommand(ffmpegPath, args, (line) => {
    if (line.includes('frame=')) update?.()
  })
}

async function facePointsFor(source, start, duration) {
  await ensureFaceModel()
  const result = JSON.parse(await runPython([faceScript, source, String(start), String(duration), faceModelPath, '1']))
  return result.points
}

// Jump-cuts pauses longer than 0.8 s. Returns the trimmed file plus the clip/words remapped onto its own timeline.
async function trimSilentGaps(source, clip, words, target) {
  const silences = await detectSilences(ffmpegPath, source, clip.start, clip.duration)
  const keeps = buildKeepSegments(clip.duration, silences)
  const kept = keeps.reduce((sum, [from, to]) => sum + (to - from), 0)
  if (clip.duration - kept < 0.5) return null
  const expression = keeps.map(([from, to]) => `between(t,${from},${to})`).join('+')
  await runCommand(ffmpegPath, [
    '-y', '-ss', String(clip.start), '-i', source, '-t', String(clip.duration),
    '-vf', `select='${expression}',setpts=N/FRAME_RATE/TB`, '-af', `aselect='${expression}',asetpts=N/SR/TB`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-c:a', 'aac', '-b:a', '160k', target,
  ])
  const remapped = remapWords(words, clip.start, keeps)
  return { source: target, clip: { ...clip, start: 0, duration: Number(remapped.duration.toFixed(2)) }, words: remapped.words, removed: clip.duration - remapped.duration }
}

async function processJob(job) {
  const jobDir = path.join(jobsDir, job.id)
  const source = path.join(jobDir, 'source.mp4')
  await fs.mkdir(jobDir, { recursive: true })
  job.status = 'downloading'
  job.message = 'Mengambil video dari YouTube'
  await downloadYoutubeVideo(job.url, source, job)
  const duration = await probeVideo(source)
  let captionCues = []
  job.message = 'Mencari transkrip / auto-caption YouTube'
  try {
    await ytDlp.execPromise([
      job.url, '--skip-download', '--no-playlist', '--no-warnings', '--write-auto-subs', '--write-subs',
      '--ignore-errors', '--sub-langs', 'id,en,id-orig,en-orig', '--sub-format', 'vtt/best', '--output', path.join(jobDir, 'source.%(ext)s'),
    ])
    captionCues = await findCaptionCues(jobDir)
  } catch (error) {
    console.warn('Caption fetch:', String(error.message || error).split('\n').slice(-2).join(' '))
    captionCues = await findCaptionCues(jobDir)
  }
  job.captionStatus = !job.captionsEnabled ? 'disabled' : captionCues.length ? 'available' : 'unavailable'

  job.status = 'processing'
  job.progress = 15
  let highlights
  const provider = LLM_PROVIDERS[process.env.CLIPFORGE_LLM_PROVIDER] ? process.env.CLIPFORGE_LLM_PROVIDER : 'anthropic'
  const { label, envKey, defaultModel } = LLM_PROVIDERS[provider]
  const apiKey = process.env[envKey]
  if (!apiKey) {
    job.selectionNote = `API key ${label} belum diisi, memakai penilaian lokal.`
  } else if (!captionCues.length) {
    job.selectionNote = 'Tidak ada transkrip, memakai penilaian lokal.'
  } else {
    try {
      highlights = await selectClipsWithLlm({
        provider,
        apiKey,
        model: process.env.CLIPFORGE_LLM_MODEL || defaultModel,
        words: captionCues, duration, maxClips: job.clipCount,
        onProgress: (message) => { job.message = message },
      })
      if (highlights?.length) Object.assign(job, { selectedBy: 'llm', scoredWithTranscript: true })
      else job.selectionNote = `${label} tidak menemukan momen yang valid, memakai penilaian lokal.`
    } catch (error) {
      job.selectionNote = `${label} gagal, memakai penilaian lokal: ${error.message.slice(0, 160)}`
      console.warn('LLM selection:', error.message)
    }
  }
  if (!highlights?.length) {
    try {
      const scoring = await scoreVideo({
        ffmpegPath, source, duration, words: captionCues,
        maxClips: job.clipCount,
        facePoints: (start, length) => facePointsFor(source, start, length),
        onProgress: (message) => { job.message = message },
      })
      job.scoredWithTranscript = scoring.transcript
      highlights = scoring.clips
      if (highlights.length) job.selectedBy = 'heuristic'
    } catch (error) {
      console.warn('Scoring:', error.message)
    }
  }
  if (!highlights?.length) {
    job.selectedBy = 'fallback'
    highlights = createHighlights(duration, job.clipCount).map((clip) => ({ ...clip, score: String(94 - (clip.id - 1) * 4) }))
  }
  job.message = 'Memotong momen terbaik dengan FFmpeg'
  job.progress = 30
  for (let index = 0; index < highlights.length; index += 1) {
    const clip = highlights[index]
    const filename = `clip-${index + 1}.mp4`
    let clipSource = source
    let cutInfo = clip
    let clipWords = captionCues
    if (job.trimSilence) {
      job.message = `Membuang jeda panjang di klip ${index + 1}`
      try {
        const trimmed = await trimSilentGaps(source, clip, captionCues, path.join(jobDir, `trim-${index + 1}.mp4`))
        if (trimmed) {
          clipSource = trimmed.source
          cutInfo = trimmed.clip
          clipWords = trimmed.words
          clip.trimmedSeconds = Number(trimmed.removed.toFixed(1))
        }
      } catch (error) {
        console.warn('Trim silence:', error.message)
      }
    }
    const assFile = clipWords.length ? path.join(jobDir, `clip-${index + 1}.ass`) : null
    const hasCaptions = assFile && job.captionsEnabled ? await writeAssCaptions(cutInfo, clipWords, assFile, job.outputFormat, job.captionTemplate) : false
    let cropX = null
    if (job.faceTracking && job.outputFormat === 'portrait' && job.portraitMode === 'crop') {
      job.message = `Melacak wajah untuk klip ${index + 1}`
      try {
        cropX = await trackFaceCrop(clipSource, cutInfo)
      } catch (error) {
        console.warn('Face tracking:', error.message)
      }
      job.faceTracked = Boolean(cropX) || job.faceTracked
    }
    job.message = `Merender klip ${index + 1}`
    // Mode caption terpisah: video tanpa caption, lalu caption dirender sendiri di latar hijau.
    const burnCaptions = hasCaptions && !job.captionOnly
    await cutClip(clipSource, path.join(jobDir, filename), cutInfo, { ...job, cropX }, burnCaptions ? assFile : null, () => {})
    if (hasCaptions && job.captionOnly) {
      job.message = `Merender caption klip ${index + 1}`
      const captionFilename = `clip-${index + 1}-captions.mp4`
      await renderCaptionLayer(assFile, path.join(jobDir, captionFilename), cutInfo.duration, job.outputFormat)
      clip.captionFilename = captionFilename
    }
    clip.filename = filename
    clip.time = `${formatTime(clip.start)} — ${formatTime(clip.start + clip.duration)}`
    clip.durationLabel = formatTime(cutInfo.duration)
    clip.hasCaptions = hasCaptions
    clip.outputFormat = job.outputFormat
    job.progress = 30 + Math.round(((index + 1) / highlights.length) * 65)
  }
  job.status = 'completed'
  job.message = 'Analisis selesai'
  job.progress = 100
  job.clips = highlights
  await fs.rm(source, { force: true })
}

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'clipforge-processing' }))

app.post('/api/jobs', (request, response) => {
  const { url, muteMusic = false, outputFormat = 'landscape', portraitMode = 'crop', captionsEnabled = true, captionOnly = false, captionTemplate = 'clean', faceTracking = false, trimSilence = false, clipCount = 10 } = request.body || {}
  if (!isYoutubeUrl(url)) return response.status(400).json({ error: 'Masukkan URL YouTube yang valid.' })
  if (!['landscape', 'portrait'].includes(outputFormat)) return response.status(400).json({ error: 'Pilih output landscape atau portrait.' })
  if (!['crop', 'blur'].includes(portraitMode)) return response.status(400).json({ error: 'Mode portrait tidak valid.' })
  if (!['clean', 'neon', 'blurstack', 'kinetic', 'retro', 'offer'].includes(captionTemplate)) return response.status(400).json({ error: 'Template caption tidak valid.' })
  if (![3, 5, 7, 10].includes(Number(clipCount))) return response.status(400).json({ error: 'Jumlah klip harus 3, 5, 7, atau 10.' })
  const id = crypto.randomUUID()
  const job = { id, url, clipCount: Number(clipCount), muteMusic: Boolean(muteMusic), outputFormat, portraitMode, captionsEnabled: Boolean(captionsEnabled), captionOnly: Boolean(captionOnly), captionTemplate, faceTracking: Boolean(faceTracking), trimSilence: Boolean(trimSilence), status: 'queued', progress: 0, message: 'Menyiapkan job', clips: [] }
  jobs.set(id, job)
  processJob(job).catch((error) => {
    job.status = 'failed'
    job.message = error.message.includes('Sign in') || error.message.includes('bot') ? 'YouTube meminta verifikasi. Coba video publik lain.' : error.message.includes('Status code: 410') ? 'Link video sudah tidak tersedia.' : `Pemrosesan gagal: ${error.message.slice(0, 120)}`
    job.error = error.message
  })
  response.status(202).json({ id, status: job.status })
})

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job) return response.status(404).json({ error: 'Job tidak ditemukan.' })
  response.json({ id: job.id, status: job.status, progress: job.progress, message: job.message, captionStatus: job.captionStatus, scoredWithTranscript: job.scoredWithTranscript, selectedBy: job.selectedBy, selectionNote: job.selectionNote, faceTracking: job.faceTracking, faceTracked: Boolean(job.faceTracked), clips: job.clips.map((clip) => ({ ...clip, downloadUrl: `/api/jobs/${job.id}/clips/${clip.filename}`, captionDownloadUrl: clip.captionFilename ? `/api/jobs/${job.id}/clips/${clip.captionFilename}` : null })) })
})

app.get('/api/jobs/:id/clips/:filename', async (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job || !job.clips.some((clip) => [clip.filename, clip.captionFilename].includes(request.params.filename))) return response.status(404).json({ error: 'Klip tidak ditemukan.' })
  const filePath = path.join(jobsDir, job.id, request.params.filename)
  response.download(filePath, request.params.filename)
})

if (process.env.CLIPFORGE_STATIC) {
  app.use(express.static(process.env.CLIPFORGE_STATIC))
  app.get(/^\/(?!api\/|media\/).*/, (_request, response) => response.sendFile(path.join(process.env.CLIPFORGE_STATIC, 'index.html')))
}

// Job folders hold the source video and rendered clips. Keep only the two most recent ones,
// but never remove a job that is still queued, downloading or processing.
const keepJobs = 2
setInterval(async () => {
  try {
    const folders = []
    for (const entry of await fs.readdir(jobsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const stat = await fs.stat(path.join(jobsDir, entry.name)).catch(() => null)
      if (stat) folders.push({ name: entry.name, mtimeMs: stat.mtimeMs })
    }
    folders.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { name } of folders.slice(keepJobs)) {
      const job = jobs.get(name)
      if (job && !['completed', 'failed'].includes(job.status)) continue
      jobs.delete(name)
      await fs.rm(path.join(jobsDir, name), { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('Cleanup job lama:', error.message)
  }
}, 10 * 60 * 1000)

const server = http.createServer(app)
// Long videos keep requests and sockets busy for many minutes; never cut them off from the server side.
server.requestTimeout = 0
server.headersTimeout = 0
server.keepAliveTimeout = 0
server.timeout = 0
export const listeningPort = await new Promise((resolve) => server.listen(port, process.env.CLIPFORGE_STATIC ? '127.0.0.1' : undefined, () => resolve(server.address().port)))
console.log(`ClipForge processing server listening on http://localhost:${listeningPort}`)
