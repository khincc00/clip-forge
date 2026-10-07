# ClipForge

ClipForge adalah auto clipper YouTube berbasis React, Express, FFmpeg, dan yt-dlp standalone.

## Menjalankan lokal

```bash
npm install
npm run dev
```

Buka `http://localhost:5173`.

Backend processing berjalan di `http://localhost:8787` dan diproxy oleh Vite melalui `/api`.

## Alur processing

1. Frontend membuat job melalui `POST /api/jobs`.
2. Backend mengunduh video publik YouTube tanpa playlist memakai yt-dlp standalone macOS/Linux/Windows.
3. Durasi video dibaca menggunakan `ffprobe`.
4. Track subtitle/manual atau auto-caption Indonesia/Inggris diambil jika tersedia.
5. Klip dipilih dengan Scoring System: kandidat 15-45 detik diberi skor 0-100 dengan rumus
   `Final = Hook×40% + Energy×25% + Value×25% + Visual×10%` (lihat bagian Scoring di bawah), lalu klip skor tertinggi yang tidak tumpang tindih diambil (jumlahnya 3, 5, 7, atau 10, dipilih di UI; default 10).
6. FFmpeg memotong kandidat ke landscape 16:9 atau portrait 9:16 dan membakar caption ke video.
7. Frontend polling status job dan mendapatkan URL download per klip.

## Format dan caption

- Landscape menghasilkan frame 1280 x 720; portrait menghasilkan frame 1080 x 1920 dengan crop tengah.
- Auto-caption menggunakan subtitle/auto-caption yang disediakan YouTube. Jika video tidak memiliki track caption yang dapat diakses, klip tetap dibuat tanpa caption dan UI memberi tahu pengguna.
- Template Clean Fade, Big Word, Highlight, Neon Glow, Editorial, dan Elegant Serif dirender dengan FFmpeg/libass ke dalam MP4.

## Audio

Toggle `Matikan background music` mengaktifkan filter voice-focus FFmpeg (`highpass`, `lowpass`, dan `afftdn`). Ini mengurangi noise dan frekuensi musik, tetapi bukan source separation berbasis stem. Untuk pemisahan musik dan suara yang lebih presisi, worker dapat diganti dengan pipeline Demucs/UVR pada server GPU.

## Catatan deployment

- Gunakan video YouTube yang dapat ditonton publik.
- Pastikan penggunaan mematuhi hak cipta, Terms of Service YouTube, dan izin pemilik video.
- `storage/jobs` menyimpan file sementara hasil processing; tambahkan cleanup terjadwal untuk deployment produksi.
- Untuk produksi, pindahkan job map ke Redis/database dan worker ke queue seperti BullMQ.

## Face tracking

Format Portrait dapat memakai Face tracking: crop 9:16 mengikuti wajah utama. Fitur ini butuh `python3` dengan `opencv-python-headless` (`pip3 install opencv-python-headless`); model YuNet (~230 KB) diunduh otomatis ke `storage/models/`. Tanpa wajah atau OpenCV, crop kembali ke tengah frame.

## Scoring System

Semua analisis berjalan lokal di `server/scoring.js`. Transkrip berasal dari caption YouTube (bukan Whisper), dan klasifikasi memakai aturan kata kunci/regex, bukan LLM.

- **Hook (40%)**: deteksi pertanyaan (kenapa, gimana, rahasia, jangan, salah, ternyata), angka/list (3 cara, 100jt, pertama), dan kata ekstrem (rugi, cuan, gila, gratis, viral). Jika ada dalam 3 detik pertama skor langsung +50.
- **Energy (25%)**: lonjakan volume (RMS di atas 120% rata-rata), variasi nada (autokorelasi), tawa/reaksi (hahaha, wkwk, wow, anjir, [Laughter]), dikurangi penalti proporsi jeda.
- **Value (25%)**: topik tunggal dalam satu klip (pergeseran topik dideteksi dengan TF-IDF antar blok 15 detik, bukan embedding), pola setup→punchline (awalnya… ternyata…), dan kalimat opini/kontroversi.
- **Visual (10%)**: wajah tunggal di tengah dan menghadap kamera (YuNet, hanya untuk 8 kandidat teratas) ditambah pergantian scene. Teks di layar (OCR) belum diimplementasikan.
- Tanpa transkrip, bobot dinormalisasi ke Energy + Visual saja.
- **Hapus jeda panjang**: jeda diam >0,8 detik dibuang (jump cut, menyisakan 0,15 detik di tiap sisi), caption ikut disinkronkan ulang.

## Aplikasi desktop (macOS)

Installer `.dmg` tersedia di halaman Releases. Untuk build sendiri (Apple Silicon):

```bash
cd desktop
npm install
npm run dist   # hasil: desktop/release/ClipForge-<versi>-arm64.dmg
```

Aplikasi ditandatangani ad-hoc (bukan Developer ID), jadi buka pertama kali dengan klik kanan > Open, atau jalankan `xattr -cr /Applications/ClipForge.app`.
