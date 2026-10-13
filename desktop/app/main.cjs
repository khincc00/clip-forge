const { app, BrowserWindow, shell, dialog, Menu, ipcMain, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

// Penyedia AI yang didukung. Model boleh diganti dengan ID lain dari akun penyedia.
const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', envKey: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-', defaultModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  google: { label: 'Google Gemini', envKey: 'GEMINI_API_KEY', prefix: 'AIza', defaultModel: 'gemini-3.5-flash', models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'] },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', prefix: 'sk-', defaultModel: 'gpt-6-astra', models: ['gpt-6-astra'] },
}
const DEFAULT_PROVIDER = 'anthropic'
const MODEL_PATTERN = /^[\w.:/-]{1,100}$/

let mainWindow
let settingsWindow

// The API keys are stored encrypted with the OS keychain (safeStorage), never in plain text.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')

// Settings lama hanya menyimpan satu key Claude (apiKey + model). Bentuknya dipindahkan ke format per penyedia.
function normalizeSettings(raw) {
  const keys = { ...(raw.keys || {}) }
  const models = { ...(raw.models || {}) }
  if (raw.apiKey && !keys.anthropic) keys.anthropic = raw.apiKey
  if (raw.model && !models.anthropic) models.anthropic = raw.model
  for (const [id, config] of Object.entries(PROVIDERS)) {
    if (!models[id]) models[id] = config.defaultModel
  }
  const provider = PROVIDERS[raw.provider] ? raw.provider : DEFAULT_PROVIDER
  return { provider, keys, models }
}

function readSettings() {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')))
  } catch {
    return normalizeSettings({})
  }
}

// Puts the saved keys and the active provider into the environment the server reads when a job starts.
function applySettings() {
  const settings = readSettings()
  for (const [id, config] of Object.entries(PROVIDERS)) {
    const stored = settings.keys[id]
    if (!stored || !safeStorage.isEncryptionAvailable()) continue
    try {
      process.env[config.envKey] = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch (error) {
      console.warn(`API key ${config.label} tidak bisa dibuka:`, error.message)
    }
  }
  process.env.CLIPFORGE_LLM_PROVIDER = settings.provider
  process.env.CLIPFORGE_LLM_MODEL = settings.models[settings.provider]
}

function settingsStatus() {
  const settings = readSettings()
  return {
    provider: settings.provider,
    models: settings.models,
    hasKey: Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, Boolean(settings.keys[id])])),
    providers: Object.entries(PROVIDERS).map(([id, config]) => ({
      id,
      label: config.label,
      prefix: config.prefix,
      defaultModel: config.defaultModel,
      models: config.models,
    })),
  }
}

function saveSettings({ provider, apiKey = '', model = '', clearKey = false } = {}) {
  if (!PROVIDERS[provider]) throw new Error('Penyedia AI tidak dikenal.')
  const config = PROVIDERS[provider]
  const settings = readSettings()
  settings.provider = provider
  const modelId = String(model).trim()
  if (modelId && !MODEL_PATTERN.test(modelId)) throw new Error('ID model hanya boleh berisi huruf, angka, titik, titik dua, garis miring, atau strip.')
  settings.models[provider] = modelId || config.defaultModel
  if (clearKey) {
    delete settings.keys[provider]
    delete process.env[config.envKey]
  } else if (apiKey.trim()) {
    const key = apiKey.trim()
    if (!key.startsWith(config.prefix)) throw new Error(`API key ${config.label} harus diawali ${config.prefix}.`)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Penyimpanan aman tidak tersedia di perangkat ini.')
    settings.keys[provider] = safeStorage.encryptString(key).toString('base64')
  }
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 })
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
    height: 500,
    resizable: false,
    title: 'Pengaturan API AI',
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
        { label: 'Pengaturan API AI…', accelerator: 'CmdOrCtrl+,', click: openSettings },
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
