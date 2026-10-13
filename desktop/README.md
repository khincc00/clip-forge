# ClipForge Desktop

ClipForge adalah aplikasi desktop (Electron) untuk membuat klip pendek otomatis dari video YouTube atau video lokal. Aplikasi mengambil video, membaca transkrip/auto-caption, memberi skor pada momen-momen menarik, lalu memotong dan merender klip dengan FFmpeg. Opsi tambahan: caption bergaya, crop 9:16 yang mengikuti wajah, dan pembuangan jeda panjang.

- Nama produk: ClipForge
- Versi: 0.3.1
- Bahasa UI dan log: Bahasa Indonesia
- Platform build: macOS (arm64) dalam bentuk DMG

## Fitur

- **Input URL YouTube** dengan validasi domain (`youtube.com`, `m.youtube.com`, `youtu.be`).
- **Video lokal**: pilih tab **Video lokal**, lalu pilih file dari komputer (MP4, MOV, MKV, WEBM, M4V, AVI). File diunggah ke server lokal (`POST /api/uploads`) lalu diproses seperti video YouTube. Video lokal tidak punya auto-caption, jadi tidak ada transkrip, caption tidak dibuat, dan pemilihan momen memakai scoring lokal.
- **Pemilihan resolusi otomatis** berdasarkan durasi: 720p untuk video ≤ 20 menit, 480p untuk ≤ 60 menit, 360p di atas itu.
- **Unduh video** memakai `yt-dlp`. Jika gagal, fallback ke `@distube/ytdl-core`.
- **Transkrip** dari caption YouTube (`.vtt` / `.srt`). Caption dengan timestamp per kata dipakai langsung; caption biasa dibagi rata per kata.
- **Pemilihan momen dengan Claude** (opsional, `app/server/llm-selection.js`): jika API key Anthropic diisi, transkrip dikirim ke Claude per 30 menit untuk memilih klip yang berdiri sendiri, punya hook, dan punya kesimpulan. Hasilnya tetap dipotong dengan FFmpeg. Tanpa key, atau jika panggilan gagal, aplikasi memakai scoring lokal di bawah. Alasan pemakaian scoring lokal ditampilkan lewat `selectionNote` di respons job.
- **Scoring momen lokal** (`app/server/scoring.js`):
  - Final score = Hook 40% + Energy 25% + Value 25% + Visual 10%.
  - Hook: pola pertanyaan, angka, dan kata emosional.
  - Energy: volume, nada (estimasi pitch), tawa dari transkrip, dan jeda, dari audio yang didekodekan FFmpeg.
  - Value: pergantian topik dalam transkrip (hanya jika ada transkrip).
  - Visual: jumlah pergantian scene (`select='gt(scene,0.4)'`) di dalam klip.
  - Durasi klip 15–45 detik, minimal 7 hasil.
- **Output**:
  - `landscape` 1280×720.
  - `portrait` 1080×1920 (9:16).
  - `clip-1.mp4` … `clip-N.mp4` per klip. Jika ada lebih dari satu klip (dan bukan mode caption terpisah), semua klip juga digabung berurutan menjadi `final.mp4`. Unduh lewat `finalDownloadUrl` di respons job.
- **Struktur 6 beat** (`app/server/structure.js`): setiap klip (±30 detik) disusun dari enam beat yang selalu urut:
  1. Hook uang, 0–3 s: stop scroll.
  2. Premis, 3–6 s: relate.
  3. Roast / agitate, 6–12 s: bikin penonton kesal atau empati.
  4. Solusi / plot twist, 12–20 s: solusi instan yang membalik ekspektasi.
  5. Bukti instan, 20–26 s: before → after yang visual.
  6. CTA komen, 26–30 s: ajakan komen, ditampilkan sebagai teks overlay (`ctaText`, default "Komen di bawah").
  - Dengan API key Claude/Gemini/OpenAI, model memilih isi tiap beat dari bagian video mana pun, sehingga hook bisa diambil dari menit lain. Tanpa key, beat diambil berurutan dari kandidat terbaik.
  - Tanpa transkrip, beat diambil berurutan dari waktu video tanpa snap ke kalimat, dan CTA tetap tampil. Jika **Trim silence** dipilih dan tidak ada transkrip, beat tidak dipakai dan jeda dipangkas saja.
  - Jika video punya transkrip, opsi **Trim silence** diabaikan karena klip sudah disusun ulang.
- **Template caption** (ASS): `clean`, `bigword`, `highlight`, `serif`, `neon`, `editorial`.
- **Face tracking** untuk output portrait memakai OpenCV YuNet (`app/server/face_track.py`). Model `yunet.onnx` diunduh saat pertama kali dibutuhkan.
- **Trim silence**: membuang jeda panjang dengan `silencedetect` FFmpeg.
- **Jumlah klip**: 3, 5, 7, atau 10.

## Arsitektur

```
Electron main (app/main.cjs)
  └─ menjalankan server Express lokal di 127.0.0.1 (port acak)
       └─ BrowserWindow memuat UI React dari server tersebut

Express server (app/server/index.js)
  ├─ GET  /api/health
  ├─ POST /api/uploads?name=<file>        → unggah video lokal (body biner), mengembalikan uploadId
  ├─ POST /api/jobs                       → membuat job dari `url` YouTube atau `uploadId`, status 202
  ├─ GET  /api/jobs/:id                   → status, progres, daftar klip
  ├─ GET  /api/jobs/:id/clips/:filename   → unduh klip
  ├─ GET  /media/...                      → file job (statis)
  └─ GET  /* (selain /api, /media)        → index.html (SPA)
```

Job berjalan di memori (`Map`) dan dikerjakan secara asinkron. Status job: `queued` → `downloading` → `processing` → `completed` atau `failed`.

Data disimpan di `userData/storage` (`CLIPFORGE_DATA_DIR`):

```
storage/
├─ bin/        yt-dlp (disalin dari resources saat pertama jalan)
├─ models/     yunet.onnx
├─ uploads/    video lokal yang diunggah, sebelum dipakai job (dihapus jika tidak dipakai dalam 1 jam)
└─ jobs/<id>/  video sumber, caption, dan klip hasil render
```

Hanya 2 job terakhir yang disimpan di `jobs/`. Folder job yang lebih lama dihapus otomatis setiap 10 menit. Job yang masih berjalan tidak pernah dihapus.

## Struktur Folder

```
CLIPFORGE DESKTOP/
├─ app/
│  ├─ main.cjs            Entry point Electron (window, startup server)
│  ├─ dist/               Build frontend (index.html dan assets)
│  └─ server/
│     ├─ index.js         Express API, pipeline job, render FFmpeg, caption ASS
│     ├─ scoring.js       Segmentasi transkrip, kandidat klip, scoring
│     ├─ face_track.py    Tracking wajah (Python + OpenCV)
│     └─ package.json     { "type": "module" }
├─ build/
│  ├─ afterPack.cjs       Ad-hoc codesign bundle untuk Apple Silicon
│  ├─ icon.icns           Ikon aplikasi
│  ├─ icon-1024.png
│  └─ icon.iconset/
├─ resources/
│  └─ yt-dlp              Binary yt-dlp yang dibundel (extraResources)
├─ release/               Output electron-builder (DMG, mac-arm64)
├─ INSTALLER/             DMG installer
├─ package.json
└─ package-lock.json
```

## Prasyarat

- Node.js (disarankan versi LTS terbaru).
- npm.
- **FFmpeg dan FFprobe** tidak perlu dipasang manual. Keduanya disediakan oleh `ffmpeg-static` dan `ffprobe-static`.
- **Python 3** dengan paket `opencv-python`, untuk face tracking (opsi "Face tracking" saat output portrait).
- Koneksi internet, untuk mengunduh video YouTube dan model face detector saat pertama kali.

## Instalasi dan Menjalankan

```bash
# instal dependensi
npm install

# jalankan aplikasi dalam mode development
npm start
```

`npm start` menjalankan `electron .`. Entry point ada di `app/main.cjs`, yang kemudian menjalankan server di `app/server/index.js`.

## Build

```bash
npm run dist
```

Perintah ini menjalankan `electron-builder --mac dmg --arm64`. Hasilnya ada di folder `release/`, misalnya `ClipForge-0.3.1-arm64.dmg`.

Catatan build:

- `afterPack.cjs` melakukan ad-hoc signing dengan `codesign` karena `identity` diset `null`.
- `asarUnpack` mengeluarkan `ffmpeg-static`, `ffprobe-static`, dan `face_track.py` dari asar agar bisa dieksekusi.
- `resources/yt-dlp` disalin ke `Contents/Resources/yt-dlp` dan dipakai sebagai binary awal. File ini tidak ada di Git (`.gitignore`), jadi unduh dulu dari https://github.com/yt-dlp/yt-dlp/releases (`yt-dlp_macos`), simpan sebagai `resources/yt-dlp`, lalu `chmod +x`.

## Konfigurasi

Variabel lingkungan yang dibaca server:

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `PORT` | `8787` (`0` saat dijalankan dari Electron) | Port server HTTP |
| `CLIPFORGE_DATA_DIR` | `<root>/storage` | Lokasi job, binary, dan model |
| `CLIPFORGE_STATIC` | — | Folder build frontend; jika di-set, server hanya listen di `127.0.0.1` |
| `CLIPFORGE_RESOURCES` | — | Folder berisi `yunet.onnx` yang disalin sebelum mengunduh |
| `ANTHROPIC_API_KEY` | — | API key Claude. Di aplikasi desktop diisi lewat menu **Pengaturan Claude API** (`⌘,`) |
| `CLIPFORGE_LLM_MODEL` | `claude-opus-5-5` | Model untuk pemilihan momen. Pilihan lain: `claude-sonnet-5-5`, `claude-haiku-5-5` |

### API key di aplikasi desktop

- Buka **ClipForge → Pengaturan Claude API…** lalu isi API key (diawali `sk-ant-`) dan pilih model.
- Key disimpan di `userData/settings.json` dalam bentuk terenkripsi memakai `safeStorage` (Keychain di macOS). Key tidak pernah dikirim balik ke halaman pengaturan.
- Biaya pemakaian ditagih oleh Anthropic sesuai token. Perkiraan kasar untuk video 1 jam: Opus 5.5 sekitar $0.14, Sonnet 5.5 sekitar $0.07, Haiku 5.5 sekitar $0.004 per video.
- Pemilihan momen dengan Claude hanya berjalan jika video punya transkrip (caption YouTube).

## Catatan Teknis

- **Batas body request**: 50 KB (`express.json`).
- **Timeout unduhan**: job dibatalkan jika tidak ada kemajuan selama 5 menit.
- **Timeout Python**: 1 jam per proses `face_track.py`.
- **Penanganan error YouTube**: pesan khusus untuk verifikasi bot (`Sign in`/`bot`) dan video yang sudah dihapus (HTTP 410).
- **Pembersihan caption**: tag `[Music]`, `>>`, dan `♪` dibuang sebelum scoring dan render.
- Source frontend (`src/` di root repo) belum disinkronkan dengan UI ini. `app/dist/` adalah hasil build yang di-commit langsung.

## Batasan yang Diketahui

- Job disimpan di memori. Saat aplikasi ditutup, daftar job hilang. File di `storage/jobs/` hanya disimpan untuk 2 job terakhir.
- Hanya target build macOS arm64.
- Bergantung pada YouTube dan `yt-dlp`. Jika YouTube mengubah sesuatu atau meminta verifikasi, unduhan bisa gagal.
- Face tracking dan model YuNet membutuhkan Python dengan OpenCV. Jika tidak ada wajah yang terdeteksi, crop tidak diikat ke wajah.
- Tidak ditemukan file test di repo ini.

## Lisensi

Belum ditentukan.
