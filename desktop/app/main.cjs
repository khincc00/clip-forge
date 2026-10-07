const { app, BrowserWindow, shell, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

let mainWindow

async function startServer() {
  process.env.PORT = '0'
  process.env.CLIPFORGE_DATA_DIR = path.join(app.getPath('userData'), 'storage')
  process.env.CLIPFORGE_STATIC = path.join(__dirname, 'dist')
  // Seed the bundled yt-dlp so the first launch doesn't need to download it.
  const binDir = path.join(process.env.CLIPFORGE_DATA_DIR, 'bin')
  const target = path.join(binDir, 'yt-dlp')
  const bundled = path.join(process.resourcesPath, 'yt-dlp')
  if (!fs.existsSync(target) && fs.existsSync(bundled)) {
    fs.mkdirSync(binDir, { recursive: true })
    fs.copyFileSync(bundled, target)
    fs.chmodSync(target, 0o755)
  }
  const { listeningPort } = await import(pathToFileURL(path.join(__dirname, 'server', 'index.js')).href)
  return listeningPort
}

async function createWindow() {
  const port = await startServer()
  mainWindow = new BrowserWindow({ width: 1360, height: 900, minWidth: 980, minHeight: 700, backgroundColor: '#171c1b', title: 'ClipForge' })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  await mainWindow.loadURL(`http://127.0.0.1:${port}`)
}

app.whenReady().then(() => createWindow().catch((error) => {
  dialog.showErrorBox('ClipForge gagal dimulai', String(error?.stack || error))
  app.quit()
})).catch(() => app.quit())

app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
