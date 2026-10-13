import Anthropic from '@anthropic-ai/sdk'
import { buildSegments } from './scoring.js'

// Penyedia AI yang didukung. envKey adalah variabel environment tempat key disimpan saat job berjalan.
export const LLM_PROVIDERS = {
  anthropic: { label: 'Claude', envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5' },
  google: { label: 'Gemini', envKey: 'GEMINI_API_KEY', defaultModel: 'gemini-3.5-flash' },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-6-astra' },
}
const REFUSAL_REASONS = { google: ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'], openai: ['content_filter'] }

const MIN_CLIP = 15
const MAX_CLIP = 60
const WINDOW_SECONDS = 1800
const SNAP_SECONDS = 3
const WEIGHTS = { hook: 0.4, energy: 0.25, value: 0.25 }
const TOTAL_WEIGHT = WEIGHTS.hook + WEIGHTS.energy + WEIGHTS.value
const TAGS = { hook: 'Hook kuat', energy: 'Energi tinggi', value: 'Insight / opini' }
const COLORS = ['clip-one', 'clip-two', 'clip-three']

const SYSTEM = `You select the most engaging self-contained moments from a video transcript to become short clips. The video can be any genre: podcast, tutorial, interview, vlog, comedy, gaming, and so on.

A good moment:
- makes sense on its own, without the rest of the video;
- opens with a strong hook in its first few seconds;
- contains a complete point, answer, story beat, joke, or reveal;
- carries emotion, surprise, or a useful insight.

Rules:
- Each clip must last between 15 and 60 seconds.
- Use only timestamps that appear in the transcript lines. Start where a line starts and end where a line ends.
- Score hook, energy (emotional or comedic intensity), and value (insight or usefulness) from 0 to 100.
- Write titles in the same language as the transcript.

Reply with JSON only, no prose and no code fence, in this shape:
{"clips":[{"start":"mm:ss","end":"mm:ss","title":"...","hook":0,"energy":0,"value":0,"reason":"..."}]}`

const clamp = (value) => Math.min(100, Math.max(0, Number(value) || 0))

function formatTime(seconds) {
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

// Accepts "mm:ss", "h:mm:ss", or plain seconds. Returns null when the value cannot be read.
function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const parts = value.trim().split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

// Moves a timestamp onto the nearest segment boundary within SNAP_SECONDS so cuts land between sentences.
function snap(value, points) {
  let best = value
  let distance = SNAP_SECONDS
  for (const point of points) {
    const gap = Math.abs(point - value)
    if (gap <= distance) { best = point; distance = gap }
  }
  return best
}

function toClip(raw, { starts, ends, duration }) {
  const rawStart = parseTime(raw?.start)
  const rawEnd = parseTime(raw?.end)
  if (rawStart === null || rawEnd === null) return null
  const start = snap(rawStart, starts)
  const end = Math.min(duration, snap(rawEnd, ends))
  const length = end - start
  if (start < 0 || length < MIN_CLIP || length > MAX_CLIP) return null
  const scores = { hook: clamp(raw.hook), energy: clamp(raw.energy), value: clamp(raw.value) }
  const total = (WEIGHTS.hook * scores.hook + WEIGHTS.energy * scores.energy + WEIGHTS.value * scores.value) / TOTAL_WEIGHT
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : 'Momen menarik'
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : ''
  return { start, end, duration: Number(length.toFixed(2)), title, reason, scores, total: Math.round(total) }
}

function parseCandidates(text, context) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed.clips)) return []
    return parsed.clips.map((raw) => toClip(raw, context)).filter(Boolean)
  } catch {
    return []
  }
}

// Picks the strongest clips without overlap, the same way the local scorer does.
function pickClips(candidates, maxClips) {
  const picks = []
  for (const item of [...candidates].sort((a, b) => b.total - a.total)) {
    if (picks.length >= maxClips) break
    const overlaps = picks.some((pick) => Math.min(pick.end, item.end) - Math.max(pick.start, item.start) > 0.1 * (item.end - item.start))
    if (!overlaps) picks.push(item)
  }
  return picks
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`)
  return data
}

// Returns ask(system, user) -> text for the chosen provider. Google and OpenAI use their REST APIs directly,
// so only the Anthropic SDK is needed as a dependency.
function createCaller({ provider, apiKey, model }) {
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey })
    return async (system, user) => {
      const response = await client.messages.create({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] })
      if (response.stop_reason === 'refusal') throw new Error('Model menolak memproses transkrip ini')
      return response.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
    }
  }
  if (provider === 'google') {
    return async (system, user) => {
      const data = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': apiKey }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16000 },
      })
      const candidate = data.candidates?.[0]
      if (REFUSAL_REASONS.google.includes(candidate?.finishReason)) throw new Error('Model menolak memproses transkrip ini')
      return (candidate?.content?.parts || []).map((part) => part.text || '').join('')
    }
  }
  if (provider === 'openai') {
    return async (system, user) => {
      const data = await postJson('https://api.openai.com/v1/chat/completions', { authorization: `Bearer ${apiKey}` }, {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        max_completion_tokens: 16000,
      })
      const choice = data.choices?.[0]
      if (REFUSAL_REASONS.openai.includes(choice?.finish_reason) || choice?.message?.refusal) throw new Error('Model menolak memproses transkrip ini')
      return choice?.message?.content || ''
    }
  }
  throw new Error(`Penyedia AI tidak dikenal: ${provider}`)
}

// Asks the chosen AI provider to pick clips window by window. Returns null when nothing usable came back,
// so the caller can fall back to the local scorer.
export async function selectClipsWithLlm({ provider, apiKey, model, words, duration, maxClips, onProgress }) {
  const ask = createCaller({ provider, apiKey, model })
  const label = LLM_PROVIDERS[provider].label
  const segments = buildSegments(words)
  if (!segments.length) return null
  const context = {
    starts: segments.map((segment) => segment.start),
    ends: segments.map((segment) => segment.end),
    duration,
  }
  const windows = []
  for (let start = 0; start < duration; start += WINDOW_SECONDS) windows.push({ start, end: Math.min(duration, start + WINDOW_SECONDS) })

  const candidates = []
  for (const [index, window] of windows.entries()) {
    const lines = segments
      .filter((segment) => segment.start >= window.start && segment.start < window.end)
      .map((segment) => `[${formatTime(segment.start)}] ${segment.text}`)
    if (!lines.length) continue
    onProgress?.(`${label} menilai momen (${index + 1}/${windows.length})`)
    const text = await ask(SYSTEM, `Pick up to ${maxClips} clips from this part of the video (${formatTime(window.start)} to ${formatTime(window.end)}).\n\n${lines.join('\n')}`)
    candidates.push(...parseCandidates(text, context))
  }

  const picks = pickClips(candidates, maxClips)
  if (!picks.length) return null
  return picks.map((clip, index) => {
    const top = Object.keys(WEIGHTS).sort((a, b) => WEIGHTS[b] * clip.scores[b] - WEIGHTS[a] * clip.scores[a])[0]
    return {
      id: index + 1,
      title: clip.title,
      tag: TAGS[top],
      start: Number(clip.start.toFixed(2)),
      duration: clip.duration,
      score: String(clip.total),
      breakdown: { hook: Math.round(clip.scores.hook), energy: Math.round(clip.scores.energy), value: Math.round(clip.scores.value), visual: 0 },
      hookTypes: [],
      reason: clip.reason,
      color: COLORS[index % COLORS.length],
    }
  })
}
