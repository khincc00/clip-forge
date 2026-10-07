import { spawn } from 'node:child_process'

// Final Score = Hook 40% + Energy 25% + Value 25% + Visual 10%, each component 0-100.
const WEIGHTS = { hook: 0.4, energy: 0.25, value: 0.25, visual: 0.1 }
const MIN_CLIP = 15
const MAX_CLIP = 45
const MIN_RESULTS = 7

const clamp = (value, low = 0, high = 100) => Math.min(high, Math.max(low, value))
const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0)
const std = (list) => {
  if (list.length < 2) return 0
  const average = mean(list)
  return Math.sqrt(mean(list.map((value) => (value - average) ** 2)))
}

const HOOK_PATTERNS = {
  question: /\b(kenapa|mengapa|gimana|bagaimana|rahasia|jangan|salah|ternyata|why|how|secret|never|stop|mistake|wrong|truth)\b|\?/i,
  number: /\b\d+([.,]\d+)?\s?(cara|tips|kesalahan|langkah|alasan|hal|ways|mistakes|steps|reasons|things|jt|juta|miliar|rb|ribu)\b|\b(pertama|kedua|ketiga|first|second|third)\b|\b\d+\b/i,
  extreme: /\b(rugi|cuan|gila|bodoh|penipuan|gratis|viral|bahaya|bangkrut|scam|crazy|insane|free|shocking|dangerous)\b/i,
}
const SETUP_PATTERN = /\b(awalnya|kirain|gue kira|gua kira|saya kira|aku kira|i thought|i used to think)\b/i
const PAYOFF_PATTERN = /\b(ternyata|nyatanya|padahal|turns out|actually)\b/i
const OPINION_PATTERN = /\b(menurut (gue|gua|saya|aku)|(gue|gua|saya|aku) (gak|nggak|ga|tidak) setuju|ini salahnya|salah besar|unpopular opinion|i disagree|in my opinion|menurut saya|jujur)\b/gi
const LAUGHTER_PATTERN = /^(\[(laughter|applause)\]|(ha|he|hi){2,}h?|(wk)+w?k?|wow|anjir|anjay|waduh|lol|lmao)[!.,?]*$/i
const STOPWORDS = new Set('yang dan atau dengan untuk dari pada ini itu juga tapi karena jadi sudah bisa akan kita kami mereka there their with that this have from they what when your about which would been were will just like then than them into some more very'.split(' '))

// words are sorted by start time, so ranges can be found by binary search instead of scanning the whole transcript per candidate.
function lowerBound(words, time) {
  let low = 0
  let high = words.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (words[mid].start < time) low = mid + 1
    else high = mid
  }
  return low
}
const wordsBetween = (words, from, to) => words.slice(lowerBound(words, from), lowerBound(words, to))

const hookCategories = (text) => Object.entries(HOOK_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name)

function spawnCapture(command, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    let err = ''
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => { err += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve({ stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString(), stderr: err }) : reject(new Error(err.slice(-800) || `exit ${code}`))))
  })
}

// ---------- transcript structure ----------

export function buildSegments(words) {
  const speech = words.filter((word) => !/^(\[.*\]|>>+|♪+)$/.test(word.text))
  const segments = []
  let current = []
  const flush = () => {
    if (!current.length) return
    segments.push({ start: current[0].start, end: current.at(-1).end, text: current.map((word) => word.text).join(' ') })
    current = []
  }
  for (const word of speech) {
    const previous = current.at(-1)
    if (previous && (word.start - previous.end > 0.6 || current.length >= 18)) flush()
    current.push(word)
    if (/[.?!]$/.test(word.text)) flush()
  }
  flush()
  return segments
}

function findTopicShifts(words) {
  const speech = words.filter((word) => !/^(\[.*\]|>>+|♪+)$/.test(word.text))
  if (!speech.length) return []
  const blockLength = 15
  const blocks = []
  for (const word of speech) {
    const index = Math.floor(word.start / blockLength)
    ;(blocks[index] ||= { start: index * blockLength, tokens: new Map() })
    const token = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    if (token.length >= 4 && !STOPWORDS.has(token)) blocks[index].tokens.set(token, (blocks[index].tokens.get(token) || 0) + 1)
  }
  const filled = blocks.filter(Boolean)
  const documentFrequency = new Map()
  filled.forEach((block) => block.tokens.forEach((_, token) => documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)))
  const vectors = filled.map((block) => {
    const vector = new Map()
    block.tokens.forEach((count, token) => vector.set(token, count * Math.log(1 + filled.length / documentFrequency.get(token))))
    return vector
  })
  const cosine = (a, b) => {
    let dot = 0
    let normA = 0
    let normB = 0
    a.forEach((value, token) => { normA += value * value; if (b.has(token)) dot += value * b.get(token) })
    b.forEach((value) => { normB += value * value })
    return normA && normB ? dot / Math.sqrt(normA * normB) : 0
  }
  const similarities = vectors.slice(0, -1).map((vector, i) => cosine(vector, vectors[i + 1]))
  if (similarities.length < 3) return []
  const threshold = mean(similarities) - 0.6 * std(similarities)
  return similarities.map((value, i) => (value < threshold ? filled[i + 1].start : null)).filter((value) => value !== null)
}

// ---------- audio / video signals ----------

async function analyzeAudio(ffmpegPath, source) {
  const { stdout } = await spawnCapture(ffmpegPath, ['-v', 'error', '-i', source, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { binary: true })
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
  const hop = 800 // 0.1 s at 8 kHz
  const frames = Math.floor(samples.length / hop)
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    for (let i = f * hop; i < (f + 1) * hop; i += 1) sum += samples[i] * samples[i]
    rms[f] = Math.sqrt(sum / hop) / 32768
  }
  const active = Array.from(rms).filter((value) => value > 0.005)
  const globalMean = mean(active) || 0.01
  const f0 = new Float32Array(frames)
  const windowSize = 512
  for (let f = 0; f < frames; f += 1) {
    if (rms[f] < globalMean * 0.5) continue
    const base = f * hop
    if (base + windowSize + 110 > samples.length) break
    let energy = 0
    for (let i = 0; i < windowSize; i += 1) energy += samples[base + i] * samples[base + i]
    let bestLag = 0
    let bestValue = 0
    for (let lag = 20; lag <= 106; lag += 1) {
      let sum = 0
      for (let i = 0; i < windowSize; i += 1) sum += samples[base + i] * samples[base + i + lag]
      const normalized = sum / (energy || 1)
      if (normalized > bestValue) { bestValue = normalized; bestLag = lag }
    }
    if (bestValue > 0.4) f0[f] = 8000 / bestLag
  }
  return { rms, f0, globalMean }
}

async function detectSceneCuts(ffmpegPath, source) {
  try {
    const { stderr } = await spawnCapture(ffmpegPath, ['-i', source, '-an', '-vf', "fps=2,scale=160:-2,select='gt(scene,0.4)',showinfo", '-f', 'null', '-'])
    return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1]))
  } catch {
    return []
  }
}

function audioMetrics(audio, start, end) {
  const from = Math.max(0, Math.floor(start * 10))
  const to = Math.min(audio.rms.length, Math.ceil(end * 10))
  const rms = Array.from(audio.rms.slice(from, to))
  if (!rms.length) return { volume: 0, pitch: 0, silence: 0 }
  const spikes = rms.filter((value) => value > audio.globalMean * 1.2).length / rms.length
  const relative = mean(rms) / audio.globalMean
  const volume = clamp(spikes * 200 + (relative - 1) * 80)
  const voiced = Array.from(audio.f0.slice(from, to)).filter((value) => value > 0)
  let pitch = 0
  if (voiced.length > 8) {
    const median = [...voiced].sort((a, b) => a - b)[Math.floor(voiced.length / 2)]
    pitch = clamp(std(voiced.map((value) => 12 * Math.log2(value / median))) * 17)
  }
  const silence = rms.filter((value) => value < audio.globalMean * 0.12).length / rms.length
  return { volume, pitch, silence }
}

// ---------- scoring ----------

function generateCandidates(segments, duration) {
  const candidates = []
  if (!segments.length) {
    for (const length of [25, 35]) {
      for (let start = 0; start + MIN_CLIP <= duration; start += 5) candidates.push({ start, end: Math.min(duration, start + length) })
    }
    return candidates
  }
  segments.forEach((first, i) => {
    const ends = []
    for (let j = i; j < segments.length; j += 1) {
      const length = segments[j].end - first.start
      if (length > MAX_CLIP) break
      if (length >= MIN_CLIP) ends.push({ end: segments[j].end, length })
    }
    for (const target of [30, 42]) {
      const best = ends.reduce((pick, option) => (!pick || Math.abs(option.length - target) < Math.abs(pick.length - target) ? option : pick), null)
      if (best) candidates.push({ start: first.start, end: Math.min(best.end, duration) })
    }
  })
  return candidates
}

function scoreHook(words, start) {
  const speech = wordsBetween(words, start, start + 8).filter((word) => !/^\[.*\]$/.test(word.text))
  const first3 = speech.filter((word) => word.start < start + 3).map((word) => word.text).join(' ')
  const first8 = speech.map((word) => word.text).join(' ')
  const early = hookCategories(first3)
  let score = early.length ? 50 + (early.length - 1) * 15 : 0
  const later = hookCategories(first8).filter((name) => !early.includes(name))
  score += later.length * 20
  return { score: clamp(score), categories: [...new Set([...early, ...later])] }
}

function scoreValue(text, topicShifts, start, end) {
  const inner = topicShifts.filter((time) => time > start + 3 && time < end - 3).length
  const startsAtShift = topicShifts.some((time) => Math.abs(time - start) <= 3)
  let score = (inner === 0 ? 40 : 40 / (1 + inner * 2)) + (startsAtShift ? 20 : 0)
  const setup = SETUP_PATTERN.exec(text)
  const payoff = PAYOFF_PATTERN.exec(text)
  if (setup && payoff && payoff.index > setup.index) score += 30
  else if (payoff) score += 10
  score += Math.min(40, (text.match(OPINION_PATTERN) || []).length * 20)
  return clamp(score)
}

const REASONS = { hook: 'Hook kuat', energy: 'Energi tinggi', value: 'Insight / opini', visual: 'Visual kuat' }

export async function scoreVideo({ ffmpegPath, source, duration, words, facePoints, onProgress, maxClips = 10 }) {
  const hasTranscript = words.some((word) => !/^\[.*\]$/.test(word.text))
  onProgress?.('Menganalisis audio (volume & nada)')
  const audio = await analyzeAudio(ffmpegPath, source)
  onProgress?.('Mendeteksi pergantian scene')
  const sceneCuts = await detectSceneCuts(ffmpegPath, source)
  const segments = buildSegments(words)
  const topicShifts = findTopicShifts(words)
  onProgress?.('Memberi skor kandidat klip')

  const scored = generateCandidates(segments, duration).map((candidate) => {
    const inside = wordsBetween(words, candidate.start, candidate.end)
    const text = inside.map((word) => word.text).join(' ')
    const hook = hasTranscript ? scoreHook(words, candidate.start) : { score: 0, categories: [] }
    const laughter = inside.filter((word) => LAUGHTER_PATTERN.test(word.text)).length
    const metrics = audioMetrics(audio, candidate.start, candidate.end)
    const energy = clamp(metrics.volume * 0.5 + metrics.pitch * 0.35 + clamp(laughter * 35) * 0.5 - metrics.silence * 40)
    const value = hasTranscript ? scoreValue(text, topicShifts, candidate.start, candidate.end) : 0
    const motion = clamp(sceneCuts.filter((time) => time >= candidate.start && time < candidate.end).length * 30)
    return { ...candidate, hook: hook.score, hookCategories: hook.categories, energy, value, motion, visual: null, silence: metrics.silence, text }
  })

  const finalScore = (item) => {
    const visual = item.visual ?? item.motion
    const parts = hasTranscript
      ? WEIGHTS.hook * item.hook + WEIGHTS.energy * item.energy + WEIGHTS.value * item.value + WEIGHTS.visual * visual
      : (WEIGHTS.energy * item.energy + WEIGHTS.visual * visual) / (WEIGHTS.energy + WEIGHTS.visual)
    return parts
  }

  // Visual (face) scoring is the expensive part, so only the strongest pre-scored candidates get it.
  const shortlist = [...scored].sort((a, b) => finalScore(b) - finalScore(a)).slice(0, maxClips + 4)
  if (facePoints) {
    for (const item of shortlist) {
      try {
        const points = await facePoints(item.start, item.end - item.start)
        const found = points.filter((point) => point.found)
        const foundRatio = found.length / (points.length || 1)
        const centered = found.filter((point) => Math.abs(point.cx - 0.5) < 0.2 && (point.faces ?? 1) === 1).length / (points.length || 1)
        const facing = found.filter((point) => (point.frontal ?? 0) > 0.5).length / (points.length || 1)
        item.visual = clamp((foundRatio * 50 + centered * 25 + facing * 25) * 0.65 + item.motion * 0.35)
      } catch {
        item.visual = null
      }
    }
  }

  const picks = []
  const rest = scored.filter((item) => !shortlist.includes(item)).sort((a, b) => finalScore(b) - finalScore(a))
  const ranked = [...shortlist.sort((a, b) => finalScore(b) - finalScore(a)), ...rest]
  // Strict no-overlap first; if the video yields fewer than MIN_RESULTS, retry with progressively looser overlap.
  for (const tolerance of [0.1, 0.3, 0.5]) {
    for (const item of ranked) {
      if (picks.length >= maxClips) break
      if (picks.includes(item)) continue
      const overlaps = picks.some((pick) => Math.min(pick.end, item.end) - Math.max(pick.start, item.start) > tolerance * (item.end - item.start))
      if (!overlaps) picks.push(item)
    }
    if (picks.length >= Math.min(MIN_RESULTS, maxClips)) break
  }
  picks.sort((a, b) => finalScore(b) - finalScore(a))
  return {
    transcript: hasTranscript,
    clips: picks.map((item, index) => {
      const visual = item.visual ?? item.motion
      const contributions = { hook: WEIGHTS.hook * item.hook, energy: WEIGHTS.energy * item.energy, value: WEIGHTS.value * item.value, visual: WEIGHTS.visual * visual }
      const top = Object.entries(contributions).sort((a, b) => b[1] - a[1])[0][0]
      const firstSentence = segments.find((segment) => segment.start >= item.start - 0.5)?.text || ''
      const title = firstSentence ? firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1, 70) : `Momen terbaik #${index + 1}`
      return {
        id: index + 1,
        title,
        tag: REASONS[top],
        start: Number(item.start.toFixed(2)),
        duration: Number(Math.min(MAX_CLIP, item.end - item.start).toFixed(2)),
        score: `${Math.round(finalScore(item))}`,
        breakdown: { hook: Math.round(item.hook), energy: Math.round(item.energy), value: Math.round(item.value), visual: Math.round(visual) },
        hookTypes: item.hookCategories,
        color: ['clip-one', 'clip-two', 'clip-three'][index % 3],
      }
    }),
  }
}

// ---------- silence trimming ----------

export async function detectSilences(ffmpegPath, source, start, duration) {
  const { stderr } = await spawnCapture(ffmpegPath, ['-ss', String(start), '-t', String(duration), '-i', source, '-vn', '-af', 'silencedetect=n=-32dB:d=0.8', '-f', 'null', '-'])
  const ranges = []
  let open = null
  for (const line of stderr.split('\n')) {
    const begin = line.match(/silence_start: (-?[\d.]+)/)
    const finish = line.match(/silence_end: ([\d.]+)/)
    if (begin) open = Math.max(0, Number(begin[1]))
    if (finish && open !== null) { ranges.push([open, Number(finish[1])]); open = null }
  }
  if (open !== null) ranges.push([open, duration])
  return ranges
}

// Keeps 0.15 s on each side of every silence longer than 0.8 s.
export function buildKeepSegments(duration, silences, pad = 0.15) {
  const keeps = []
  let cursor = 0
  for (const [from, to] of silences) {
    const cutFrom = from + pad
    const cutTo = to - pad
    if (cutTo - cutFrom < 0.3) continue
    if (cutFrom > cursor) keeps.push([Number(cursor.toFixed(3)), Number(cutFrom.toFixed(3))])
    cursor = cutTo
  }
  if (cursor < duration) keeps.push([Number(cursor.toFixed(3)), Number(duration.toFixed(3))])
  return keeps
}

// Maps absolute word times to the trimmed clip timeline (clip starts at 0).
export function remapWords(words, clipStart, keeps) {
  const offsets = []
  let total = 0
  for (const [from, to] of keeps) { offsets.push(total); total += to - from }
  const mapped = []
  for (const word of words) {
    const relative = word.start - clipStart
    const index = keeps.findIndex(([from, to]) => relative >= from && relative < to)
    if (index === -1) continue
    const [from, to] = keeps[index]
    const start = offsets[index] + (relative - from)
    mapped.push({ ...word, start, end: Math.min(offsets[index] + (to - from), offsets[index] + (word.end - clipStart - from)) })
  }
  return { words: mapped, duration: total }
}
