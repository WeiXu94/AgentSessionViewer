import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, type MenuItemConstructorOptions, shell } from 'electron'
import type { ContextMenuActionId, SessionMeta } from '../shared/ipc.js'
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

function appIconPath(): string | undefined {
  const candidates = [join(app.getAppPath(), 'resources/icon.png'), join(process.cwd(), 'resources/icon.png')]
  return candidates.find((path) => existsSync(path))
}

function createWindow(): void {
  const icon = appIconPath()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'AgentSessionViewer',
    titleBarStyle: 'hiddenInset',
    icon,
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
  if (p) shell.showItemInFinder(p)
})

ipcMain.handle('shell:openPath', async (_e, p: string) => {
  if (p) await shell.openPath(p)
})

ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(text ?? '')
})

ipcMain.handle('rowmenu:show', (event, session: SessionMeta) => {
  return new Promise<{ action: ContextMenuActionId; sessionId: string } | null>((resolve) => {
    let done = false
    const finish = (action: ContextMenuActionId | null): void => {
      if (done) return
      done = true
      resolve(action ? { action, sessionId: session.id } : null)
    }

    const template: MenuItemConstructorOptions[] = [
      { label: 'Copy Resume Command', enabled: !!session.resumeCommand, click: () => finish('copy-resume') },
      { type: 'separator' },
      { label: 'Copy Session ID', click: () => finish('copy-id') },
      { label: 'Copy Path', click: () => finish('copy-path') },
      { type: 'separator' },
      { label: 'Reveal Session Log in Finder', click: () => finish('reveal') },
      { label: 'Open Working Directory', enabled: !!session.cwd, click: () => finish('open-cwd') },
      { type: 'separator' },
      {
        label: session.repo ? `Filter by Project: ${session.repo}` : 'Filter by Project',
        enabled: !!session.repo,
        click: () => finish('filter-project')
      }
    ]

    const menu = Menu.buildFromTemplate(template)
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    menu.popup({ window: win, callback: () => finish(null) })
  })
})

// ── Lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
  buildAppMenu()
  const icon = appIconPath()
  if (icon && process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(icon))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
