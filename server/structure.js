// Pola klip enam beat. Urutan di klip selalu tetap: hook → premis → roast → solusi → bukti → CTA.
// Isi tiap beat boleh diambil dari bagian video mana pun (LLM), atau berurutan dari kandidat terbaik (scoring lokal).
export const BEATS = [
  { role: 'hook', label: 'Hook uang', purpose: 'Stop scroll', seconds: 3 },
  { role: 'premis', label: 'Premis', purpose: 'Relate', seconds: 3 },
  { role: 'roast', label: 'Roast / agitate', purpose: 'Agitate / empati', seconds: 6 },
  { role: 'solution', label: 'Solusi / plot twist', purpose: 'Twist / hero', seconds: 8 },
  { role: 'bukti', label: 'Bukti instan', purpose: 'Before-after', seconds: 6 },
  { role: 'cta', label: 'CTA komen', purpose: 'Trigger algo', seconds: 4 },
]
export const TOTAL_SECONDS = BEATS.reduce((sum, beat) => sum + beat.seconds, 0)

const SLACK = 2 // seconds a beat may run past its target before it is cut
const MIN_BEAT = 1 // shorter beats are dropped
const SNAP_SECONDS = 0.8 // local cuts move onto a nearby sentence boundary within this distance

const round = (value) => Number(value.toFixed(2))

// Caps each beat at its target length plus SLACK and returns them in playback order.
// A beat missing from the input, or shorter than MIN_BEAT, is left out; callers decide whether that is acceptable.
export function fitBeats(beats) {
  return BEATS.flatMap((spec) => {
    const beat = beats.find((item) => item.role === spec.role)
    if (!beat) return []
    const end = Math.min(beat.end, beat.start + spec.seconds + SLACK)
    const length = end - beat.start
    return length >= MIN_BEAT ? [{ role: spec.role, start: round(beat.start), end: round(end), length: round(length) }] : []
  })
}

function snapTo(time, edges) {
  let best = time
  let gap = SNAP_SECONDS
  for (const edge of edges) {
    const distance = Math.abs(edge - time)
    if (distance <= gap) { best = edge; gap = distance }
  }
  return best
}

// Without an LLM: take the window that starts at the chosen candidate and cut it into beats in order,
// moving each boundary onto the nearest sentence boundary so no cut lands mid-word.
export function localBeats(start, duration, segments) {
  const edges = segments.flatMap((segment) => [segment.start, segment.end])
  const limit = Math.min(duration, start + TOTAL_SECONDS)
  let elapsed = 0
  const marks = BEATS.map((spec, index) => {
    const at = elapsed
    elapsed += spec.seconds
    return index === 0 ? start : snapTo(start + at, edges)
  })
  marks.push(Math.min(limit, snapTo(start + TOTAL_SECONDS, edges)))
  const beats = BEATS.map((spec, index) => ({ role: spec.role, start: marks[index], end: Math.min(limit, marks[index + 1]) }))
  return fitBeats(beats)
}

export const totalLength = (beats) => beats.reduce((sum, beat) => sum + beat.length, 0)

// Source-time ranges in playback order. Passed to remapWords with clipStart 0 so caption times land on the assembled clip.
export const keepRanges = (beats) => beats.map((beat) => [beat.start, beat.start + beat.length])

// Where each beat sits in the assembled clip (from/to) and in the original video (sourceStart/sourceEnd).
export function timelineOf(beats) {
  let elapsed = 0
  return beats.map((beat) => {
    const spec = BEATS.find((item) => item.role === beat.role)
    const entry = {
      role: beat.role,
      label: spec.label,
      purpose: spec.purpose,
      from: round(elapsed),
      to: round(elapsed + beat.length),
      sourceStart: round(beat.start),
      sourceEnd: round(beat.end),
    }
    elapsed += beat.length
    return entry
  })
}

// The CTA beat is always last. Its on-screen text runs for the length of that beat.
export function ctaOverlay(beats, text) {
  const last = beats.at(-1)
  if (last?.role !== 'cta') return []
  const total = totalLength(beats)
  return [{ from: round(total - last.length), to: round(total), text }]
}

// FFmpeg arguments that cut each beat with input seeking and joins them with concat, in playback order.
export function buildBeatArgs(source, beats, target) {
  const inputs = beats.flatMap((beat) => ['-ss', beat.start.toFixed(3), '-t', beat.length.toFixed(3), '-i', source])
  const chains = beats.map((_, index) => `[${index}:v:0]setpts=PTS-STARTPTS,setsar=1[v${index}];[${index}:a:0]asetpts=PTS-STARTPTS,aresample=44100[a${index}]`)
  const pairs = beats.map((_, index) => `[v${index}][a${index}]`).join('')
  const filter = [...chains, `${pairs}concat=n=${beats.length}:v=1:a=1[outv][outa]`].join(';')
  return ['-y', ...inputs, '-filter_complex', filter, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', target]
}

// FFmpeg arguments that join already-rendered clips in list order. Stream copy works because every clip
// is rendered with the same codecs, size and sample rate, so nothing is encoded twice.
export function buildConcatArgs(listFile, target) {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', target]
}
