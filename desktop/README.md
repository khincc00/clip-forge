# ClipForge Desktop

ClipForge adalah aplikasi desktop (Electron) untuk membuat klip pendek otomatis dari video YouTube. Aplikasi mengambil video, membaca transkrip/auto-caption, memberi skor pada momen-momen menarik, lalu memotong dan merender klip dengan FFmpeg. Opsi tambahan: caption bergaya, crop 9:16 yang mengikuti wajah, dan pembuangan jeda panjang.

- Nama produk: ClipForge
- Versi: 0.2.0
- Bahasa UI dan log: Bahasa Indonesia
- Platform build: macOS (arm64) dalam bentuk DMG

## Fitur

- **Input URL YouTube** dengan validasi domain (`youtube.com`, `m.youtube.com`, `youtu.be`).
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
  ├─ POST /api/jobs                       → membuat job, status 202
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
└─ jobs/<id>/  video sumber, caption, dan klip hasil render
```

Hanya 2 job terakhir yang disimpan di `jobs/`. Folder job yang lebih lama dihapus otomatis setiap 10 menit. Job yang masih berjalan tidak pernah dihapus.

## Struktur Folder

```
desktop/
├─ app/
│  ├─ main.cjs              Entry point Electron (window, menu, pengaturan API key)
│  ├─ settings.html         Halaman pengaturan API key dan model
│  ├─ settings.js           Logika halaman pengaturan
│  ├─ settings-preload.cjs  Jembatan IPC untuk halaman pengaturan (key tidak pernah dikirim balik)
│  ├─ server/               Disalin dari ../server oleh prepare.sh (tidak di-commit)
│  └─ dist/                 Build frontend dari ../src oleh prepare.sh (tidak di-commit)
├─ build/
│  ├─ afterPack.cjs         Ad-hoc codesign bundle untuk Apple Silicon
│  ├─ icon.icns             Ikon aplikasi
│  └─ icon-1024.png
├─ prepare.sh               Menyalin server dan frontend ke app/, lalu mengunduh yt-dlp
├─ resources/               yt-dlp yang dibundel (dibuat oleh prepare.sh)
└─ package.json
```

Sumber server ada di `../server/` (`index.js`, `scoring.js`, `llm-selection.js`, `face_track.py`).

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

Perintah ini menjalankan `electron-builder --mac dmg --arm64`. Hasilnya ada di folder `release/`, misalnya `ClipForge-0.2.0-arm64.dmg`.

Catatan build:

- `afterPack.cjs` melakukan ad-hoc signing dengan `codesign` karena `identity` diset `null`.
- `asarUnpack` mengeluarkan `ffmpeg-static`, `ffprobe-static`, dan `face_track.py` dari asar agar bisa dieksekusi.
- `resources/yt-dlp` disalin ke `Contents/Resources/yt-dlp` dan dipakai sebagai binary awal.

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
- Frontend dibangun dari `../src` oleh `prepare.sh`. Perubahan UI harus dilakukan di `../src`, bukan di `app/dist/`.

## Batasan yang Diketahui

- Job disimpan di memori. Saat aplikasi ditutup, daftar job hilang. File di `storage/jobs/` hanya disimpan untuk 2 job terakhir.
- Hanya target build macOS arm64.
- Bergantung pada YouTube dan `yt-dlp`. Jika YouTube mengubah sesuatu atau meminta verifikasi, unduhan bisa gagal.
- Face tracking dan model YuNet membutuhkan Python dengan OpenCV. Jika tidak ada wajah yang terdeteksi, crop tidak diikat ke wajah.
- Tidak ditemukan file test di repo ini.

## Lisensi

Belum ditentukan.
