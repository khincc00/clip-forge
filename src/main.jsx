import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScanFace, ArrowDownToLine, ArrowUpRight, Captions, Check, Clock3, Film, Link2, Play, RectangleHorizontal, RectangleVertical, Scissors, Settings2, Sparkles, VolumeX, WandSparkles } from 'lucide-react'
import './styles.css'
import './refresh.css'

const captionStyles = [
  { id: 'clean', name: 'Clean Fade', sample: 'kata yang kuat', description: 'Kata menyala satu per satu' },
  { id: 'bigword', name: 'Big Word', sample: 'kata', description: 'Satu kata besar, pop' },
  { id: 'highlight', name: 'Highlight', sample: 'KATA YANG KUAT', description: 'Kotak kuning di kata aktif' },
  { id: 'neon', name: 'Neon Glow', sample: 'kata KUNCI', description: 'Hijau glow, kata kunci besar' },
  { id: 'editorial', name: 'Editorial', sample: 'kata kunci', description: 'Sans putih + serif merah' },
  { id: 'serif', name: 'Elegant Serif', sample: 'kata yang kuat', description: 'Serif tipis, muncul halus' },
]


function getVideoId(value) {
  try {
    const parsed = new URL(value)
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.slice(1)
    if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2]
    return parsed.searchParams.get('v')
  } catch {
    return null
  }
}

function App() {
  const [url, setUrl] = useState('')
  const [muteMusic, setMuteMusic] = useState(false)
  const [outputFormat, setOutputFormat] = useState('portrait')
  const [captionsEnabled, setCaptionsEnabled] = useState(true)
  const [captionTemplate, setCaptionTemplate] = useState('clean')
  const [faceTracking, setFaceTracking] = useState(false)
  const [trimSilence, setTrimSilence] = useState(true)
  const [clipCount, setClipCount] = useState(10)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [clips, setClips] = useState([])
  const [progress, setProgress] = useState(0)
  const [processingMessage, setProcessingMessage] = useState('Menyiapkan job')
  const [captionStatus, setCaptionStatus] = useState('')
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  const notify = (message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 3600)
  }

  const analyzeVideo = async (event) => {
    event.preventDefault()
    if (!url.trim()) {
      notify('Tempel link YouTube terlebih dahulu')
      return
    }
    setIsAnalyzing(true)
    setError('')
    setClips([])
    setProgress(2)
    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, muteMusic, outputFormat, captionsEnabled, captionTemplate, faceTracking, trimSilence, clipCount }),
      })
      const createdJob = await response.json()
      if (!response.ok) throw new Error(createdJob.error || 'Job tidak dapat dibuat')
      let job
      let failedPolls = 0
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        try {
          const statusResponse = await fetch(`/api/jobs/${createdJob.id}`)
          job = await statusResponse.json()
          if (!statusResponse.ok) throw new Error(job.error || 'Status job tidak dapat dibaca')
          failedPolls = 0
        } catch (pollError) {
          // Tolerate short network hiccups; a long video can keep the server busy for many minutes.
          failedPolls += 1
          if (failedPolls >= 20) throw pollError
          continue
        }
        if (job.status === 'failed') throw new Error(job.message)
        setProgress(job.progress || (job.status === 'downloading' ? 12 : 22))
        setProcessingMessage(job.message || 'Memproses video')
        setCaptionStatus(job.captionStatus || '')
      } while (job?.status !== 'completed')
      setClips(job.clips)
      setProgress(100)
      setCaptionStatus(job.captionStatus || '')
      notify(job.faceTracking && !job.faceTracked ? 'Klip siap, tetapi wajah tidak terdeteksi (atau OpenCV belum terpasang), jadi crop memakai tengah frame.' : job.captionStatus === 'unavailable' ? 'Klip siap, tetapi sumber video tidak menyediakan auto-caption.' : 'Semua klip siap diunduh.')
    } catch (caughtError) {
      setError(caughtError.message || 'Terjadi kesalahan saat memproses video')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const downloadClip = (clip) => {
    if (!clip.downloadUrl) return notify('Klip belum tersedia untuk diunduh')
    const link = document.createElement('a')
    link.href = clip.downloadUrl
    link.download = `clipforge-${clip.outputFormat || outputFormat}-${clip.id}.mp4`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const videoId = getVideoId(url)
  const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ''

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#home"><span className="brand-mark"><Scissors size={17} strokeWidth={2.5} /></span><span>clipforge</span></a>
        <div className="workspace-label">CREATOR WORKSPACE</div>
        <nav className="main-nav" aria-label="Navigasi utama">
          <button className="nav-item active"><Sparkles size={17} /> Auto clipper</button>
          <button className="nav-item" onClick={() => notify('Riwayat akan menampilkan job yang selesai pada sesi ini.')}><Clock3 size={17} /> Riwayat</button>
        </nav>
        <div className="sidebar-bottom"><div className="side-tip"><span className="side-tip-icon"><WandSparkles size={15} /></span><p><strong>Siap untuk feed.</strong><br />Format dan caption langsung terpasang di klip.</p></div><div className="profile"><div className="avatar">CF</div><div><strong>ClipForge Studio</strong><small>Local workspace</small></div><Settings2 size={16} className="muted-icon" /></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar"><div className="breadcrumb">Studio <span>/</span> <strong>Auto clipper</strong></div><div className="top-actions"><span className="live-dot" /> Processing ready <span className="top-divider" /><span className="top-shortcut">MP4 export</span></div></header>
        <div className="content">
          <div className="page-heading"><div><p className="eyebrow"><span className="eyebrow-mark" /> VIDEO EDITING, ON AUTOPILOT</p><h1>Long video.<br /><em>Short-form energy.</em></h1><p className="subtitle">Drop in a YouTube link. Get the moments worth sharing, framed and captioned for your platform.</p></div><div className="heading-stamp"><span>CF / 01</span><strong>MAKE<br />THE CUT</strong><div className="stamp-line" /></div></div>

          <form className="source-panel" onSubmit={analyzeVideo}>
            <div className="panel-head"><div className="panel-title"><span className="step">01</span><div><h2>Video source</h2><p>Paste a public YouTube URL to start.</p></div></div><span className="secure-label"><Check size={13} /> PRIVATE SESSION</span></div>
            <div className="url-input-wrap"><Link2 size={18} /><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://youtube.com/watch?v=..." aria-label="Link video YouTube" /><button className="analyze-button" disabled={isAnalyzing}>{isAnalyzing ? 'Working...' : 'Find my clips'} <ArrowUpRight size={16} /></button></div>

            <div className="settings-grid">
              <section className="setting-block"><div className="setting-heading"><span className="setting-icon"><Film size={15} /></span><div><strong>Output format</strong><small>Choose your frame</small></div></div><div className="format-options" role="group" aria-label="Format output video"><button type="button" className={`format-option ${outputFormat === 'landscape' ? 'selected' : ''}`} onClick={() => setOutputFormat('landscape')} aria-pressed={outputFormat === 'landscape'}><RectangleHorizontal size={20} /><span><strong>Landscape</strong><small>16:9 · YouTube</small></span>{outputFormat === 'landscape' && <Check size={15} className="selected-check" />}</button><button type="button" className={`format-option ${outputFormat === 'portrait' ? 'selected' : ''}`} onClick={() => setOutputFormat('portrait')} aria-pressed={outputFormat === 'portrait'}><RectangleVertical size={20} /><span><strong>Portrait</strong><small>9:16 · Reels / TikTok</small></span>{outputFormat === 'portrait' && <Check size={15} className="selected-check" />}</button></div></section>

              <section className="setting-block caption-block"><div className="setting-heading"><span className="setting-icon"><Captions size={16} /></span><div><strong>Auto captions</strong><small>Burned into the MP4</small></div><button type="button" className={`toggle ${captionsEnabled ? 'on' : ''}`} onClick={() => setCaptionsEnabled(!captionsEnabled)} aria-label="Aktifkan auto caption" aria-pressed={captionsEnabled}><span /></button></div>
                <div className={`caption-picker ${captionsEnabled ? '' : 'disabled'}`} aria-label="Pilih template caption">{captionStyles.map((style) => <button type="button" key={style.id} className={`caption-style ${captionTemplate === style.id ? 'selected' : ''}`} onClick={() => setCaptionTemplate(style.id)} disabled={!captionsEnabled} aria-pressed={captionTemplate === style.id}><span className={`caption-sample sample-${style.id}`}>{style.sample}</span><strong>{style.name}</strong><small>{style.description}</small></button>)}</div>
              </section>
            </div>

            <section className="setting-block clip-count-block"><div className="setting-heading"><span className="setting-icon"><Scissors size={15} /></span><div><strong>Jumlah klip</strong><small>Maksimal klip terbaik yang dihasilkan</small></div></div><div className="format-options" role="group" aria-label="Jumlah klip">{[3, 5, 7, 10].map((count) => <button type="button" key={count} className={`format-option ${clipCount === count ? 'selected' : ''}`} onClick={() => setClipCount(count)} aria-pressed={clipCount === count}><span><strong>{count} klip</strong><small>{count === 3 ? 'Cepat' : count === 10 ? 'Paling lengkap' : 'Seimbang'}</small></span>{clipCount === count && <Check size={15} className="selected-check" />}</button>)}</div></section>

            <div className="source-options"><button type="button" className="audio-option" onClick={() => setMuteMusic(!muteMusic)} aria-pressed={muteMusic}><span className={`audio-icon ${muteMusic ? 'active' : ''}`}><VolumeX size={15} /></span><span><strong>Reduce background music</strong><small>Voice focus on export</small></span><span className={`toggle small ${muteMusic ? 'on' : ''}`}><span /></span></button><button type="button" className="audio-option" onClick={() => setFaceTracking(!faceTracking)} aria-pressed={faceTracking} disabled={outputFormat !== 'portrait'} title={outputFormat !== 'portrait' ? 'Hanya untuk format Portrait' : undefined}><span className={`audio-icon ${faceTracking && outputFormat === 'portrait' ? 'active' : ''}`}><ScanFace size={15} /></span><span><strong>Face tracking</strong><small>{outputFormat === 'portrait' ? 'Crop 9:16 mengikuti wajah' : 'Aktif hanya di Portrait'}</small></span><span className={`toggle small ${faceTracking && outputFormat === 'portrait' ? 'on' : ''}`}><span /></span></button><button type="button" className="audio-option" onClick={() => setTrimSilence(!trimSilence)} aria-pressed={trimSilence}><span className={`audio-icon ${trimSilence ? 'active' : ''}`}><Scissors size={15} /></span><span><strong>Hapus jeda panjang</strong><small>Potong diam lebih dari 0,8 detik</small></span><span className={`toggle small ${trimSilence ? 'on' : ''}`}><span /></span></button><span className="output-badge">OUTPUT <strong>MP4</strong></span></div>
          </form>

          <section className="results-section"><div className="section-heading"><div><div className="title-row"><span className="step">02</span><h2>Your clips</h2>{clips.length > 0 && <span className="result-count">{clips.length} READY</span>}</div><p>Selected moments, ready for your next edit.</p></div>{clips.length > 0 && <button className="download-all" onClick={() => clips.forEach(downloadClip)}><ArrowDownToLine size={15} /> Download all</button>}</div>
            {isAnalyzing ? <div className="progress-panel"><div className="progress-copy"><span className="progress-kicker"><span className="processing-pulse" /> SERVER PROCESSING</span><strong>{processingMessage}</strong><span>Downloading, finding captions, framing and rendering your clips.</span></div><div className="progress-track"><span style={{ width: `${Math.max(4, progress)}%` }} /></div><div className="progress-meta"><span>{outputFormat === 'portrait' ? '9:16 portrait' : '16:9 landscape'}{captionsEnabled ? ` · ${captionTemplate} captions` : ' · no captions'}</span><strong>{Math.round(progress)}%</strong></div></div> : error ? <div className="empty-state error-state"><span className="empty-icon"><Link2 size={19} /></span><strong>Could not process this video</strong><p>{error}</p><button type="button" onClick={() => setError('')}>Dismiss</button></div> : clips.length === 0 ? <div className="empty-state"><span className="empty-icon"><Play size={17} /></span><strong>Your edit starts with a link.</strong><p>Choose a format and caption look, then run the clipper to see real video results here.</p></div> : <div className="clip-grid">{clips.map((clip, index) => <article className="clip-card" key={clip.id}><div className={`clip-preview ${clip.color || ['clip-one', 'clip-two', 'clip-three'][index % 3]}`}>{thumbnail && <img src={thumbnail} alt="Video source preview" onError={(event) => { event.currentTarget.style.display = 'none' }} />}<span className="clip-shade" /><span className="clip-tag">{clip.tag}</span><span className="clip-index">{String(index + 1).padStart(2, '0')}</span><span className="time-stamp">{clip.durationLabel || clip.duration}</span><span className="preview-caption">{clip.hasCaptions ? 'Captioned' : 'No captions found'}</span></div><div className="clip-info"><div className="clip-title-row"><h3>{clip.title}</h3><span className="score" title="Final score = Hook 40% + Energy 25% + Value 25% + Visual 10%">{String(clip.score).replace('%', '')}<small>/100</small></span></div>{clip.breakdown && <div className="score-breakdown"><span>Hook <b>{clip.breakdown.hook}</b></span><span>Energy <b>{clip.breakdown.energy}</b></span><span>Value <b>{clip.breakdown.value}</b></span><span>Visual <b>{clip.breakdown.visual}</b></span></div>}<div className="clip-meta"><span><Clock3 size={13} /> {clip.time}</span><span>{clip.outputFormat === 'portrait' ? '9:16' : '16:9'}</span>{clip.trimmedSeconds > 0 && <span>−{clip.trimmedSeconds}s jeda</span>}</div><button className="clip-download" onClick={() => downloadClip(clip)}><ArrowDownToLine size={15} /> Download MP4</button></div></article>)}</div>}
          </section>
          <footer><span>CLIPFORGE STUDIO <b>·</b> LOCAL PROCESSING</span><span>Make the moments count.</span></footer>
        </div>
      </section>
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </main>
  )
}

const rootElement = document.getElementById('root')
const root = import.meta.hot?.data?.root || createRoot(rootElement)
if (import.meta.hot) import.meta.hot.data.root = root
root.render(<App />)
