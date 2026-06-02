import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu, type MenuItemConstructorOptions, shell } from 'electron'
import { listSessions } from './indexer.js'
import { loadTranscript } from './transcript.js'

const APP_NAME = 'AgentSessionViewer'
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'AgentSessionViewer',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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

// ── Lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
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
