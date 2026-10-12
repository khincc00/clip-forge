const { app, BrowserWindow, shell, dialog, Menu, ipcMain, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const DEFAULT_MODEL = 'claude-opus-5-5'

let mainWindow
let settingsWindow

// The API key is stored encrypted with the OS keychain (safeStorage), never in plain text.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

// Puts the saved key and model into the environment the server reads when a job starts.
function applySettings() {
  const settings = readSettings()
  if (settings.apiKey && safeStorage.isEncryptionAvailable()) {
    try {
      process.env.ANTHROPIC_API_KEY = safeStorage.decryptString(Buffer.from(settings.apiKey, 'base64'))
    } catch (error) {
      console.warn('API key tidak bisa dibuka:', error.message)
    }
  }
  process.env.CLIPFORGE_LLM_MODEL = MODELS.includes(settings.model) ? settings.model : DEFAULT_MODEL
}

function settingsStatus() {
  const settings = readSettings()
  return { hasKey: Boolean(settings.apiKey), model: MODELS.includes(settings.model) ? settings.model : DEFAULT_MODEL }
}

function saveSettings({ apiKey = '', model, clearKey = false } = {}) {
  const current = readSettings()
  const next = { model: MODELS.includes(model) ? model : DEFAULT_MODEL }
  if (clearKey) {
    delete process.env.ANTHROPIC_API_KEY
  } else if (apiKey.trim()) {
    const key = apiKey.trim()
    if (!key.startsWith('sk-ant-')) throw new Error('API key harus diawali sk-ant-.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Penyimpanan aman tidak tersedia di perangkat ini.')
    next.apiKey = safeStorage.encryptString(key).toString('base64')
  } else if (current.apiKey) {
    next.apiKey = current.apiKey
  }
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 })
  applySettings()
  return settingsStatus()
}

function openSettings() {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 430,
    resizable: false,
    title: 'Pengaturan Claude API',
    backgroundColor: '#171c1b',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs') },
  })
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'))
  settingsWindow.on('closed', () => { settingsWindow = null })
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: 'Pengaturan Claude API…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
  ]))
}

async function startServer() {
  process.env.PORT = '0'
  process.env.CLIPFORGE_DATA_DIR = path.join(app.getPath('userData'), 'storage')
  process.env.CLIPFORGE_STATIC = path.join(__dirname, 'dist')
  applySettings()
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

ipcMain.handle('settings:get', () => settingsStatus())
ipcMain.handle('settings:save', (_event, payload) => saveSettings(payload))

app.whenReady().then(() => {
  buildMenu()
  return createWindow().catch((error) => {
    dialog.showErrorBox('ClipForge gagal dimulai', String(error?.stack || error))
    app.quit()
  })
}).catch(() => app.quit())

app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
