import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions
} from 'electron'
import { listSessions } from './indexer.js'
import { loadTranscript } from './transcript.js'

const APP_NAME = 'AgentSessionViewer'
const DEFAULT_ACCENT = '#007aff'
// Must run before `ready` so the macOS app menu (About/Hide/Quit <name>) uses it.
app.setName(APP_NAME)

let mainWindow: BrowserWindow | null = null

/** Explicit application menu so the app-name labels are correct in dev and packaged builds. */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { label: `Hide ${APP_NAME}`, role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${APP_NAME}`, role: 'quit' }
      ]
    })
  }
  template.push({ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function getSystemAccentColor(): string {
  if (process.platform !== 'darwin') return DEFAULT_ACCENT

  const raw = systemPreferences.getAccentColor()
  const hex = raw.slice(0, 6)
  return /^[\da-f]{6}$/iu.test(hex) ? `#${hex}` : DEFAULT_ACCENT
}

function sendAccentColor(): void {
  const accent = getSystemAccentColor()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('system:accentColorChanged', accent)
  }
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'AgentSessionViewer',
    backgroundColor: isMac ? '#00000000' : '#ffffff',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 19, y: 18 },
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
          transparent: true
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.once('did-finish-load', sendAccentColor)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('sessions:list', (_e, force?: boolean) => listSessions(!!force))

ipcMain.handle('transcript:load', (_e, originalPath: string, source: string, id: string) =>
  loadTranscript(originalPath, source, id)
)

ipcMain.handle('shell:reveal', (_e, p: string) => {
  if (p) shell.showItemInFolder(p)
})

ipcMain.handle('shell:openPath', async (_e, p: string) => {
  if (p) await shell.openPath(p)
})

ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(text ?? '')
})

ipcMain.handle('shell:openExternal', async (_e, url: string) => {
  if (url) await shell.openExternal(url)
})

ipcMain.handle('system:accentColor', () => getSystemAccentColor())

// ── Lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  nativeTheme.themeSource = 'system'
  if (process.platform === 'darwin') {
    systemPreferences.on('accent-color-changed', sendAccentColor)
  }
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
  buildAppMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
