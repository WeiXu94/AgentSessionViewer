import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions
} from 'electron'
import type { ExportFormat, SearchIndexProgress, SearchOptions } from '../shared/ipc.js'
import { buildHtmlExport, buildMarkdownExport } from './export.js'
import { invalidateSessionCache, getSessionMeta, listSessions } from './indexer.js'
import { searchSessions, syncSearchIndex } from './searchIndex.js'
import { deleteSession } from './deleteSession.js'
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
function sendSearchIndexProgress(progress: SearchIndexProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('searchIndex:progress', progress)
  }
}

ipcMain.handle('sessions:list', async (_e, force?: boolean) => {
  const metas = await listSessions(!!force)
  // Bring the full-text index up to date in the background; never blocks the listing.
  syncSearchIndex(metas, sendSearchIndexProgress)
  return metas
})

ipcMain.handle('transcript:load', (_e, originalPath: string, source: string, id: string) =>
  loadTranscript(originalPath, source, id)
)

ipcMain.handle('sessions:delete', async (_e, originalPath: string, source: string, id: string) => {
  const result = await deleteSession(source, id, originalPath)
  if (result.ok) {
    // Force a rescan on the next list() so the deleted session disappears and
    // the search index prunes it (syncSearchIndex drops keys not in the live set).
    invalidateSessionCache()
  }
  return result
})

ipcMain.handle('search:query', async (_e, query: string, options?: SearchOptions) => {
  // listSessions() backs resolveMeta AND supplies the live titles used for the
  // title-weighted ranking, so its result is fed straight into the search.
  const metas = await listSessions(false)
  return searchSessions(query, options, getSessionMeta, metas)
})

ipcMain.handle('export:session', async (_e, originalPath: string, source: string, id: string, format: ExportFormat) => {
  try {
    await listSessions(false)
    const meta = getSessionMeta(source, id, originalPath)
    const payload = await loadTranscript(originalPath, source, id)
    if (payload.error) return { ok: false, error: payload.error }
    if (payload.nodes.length === 0) return { ok: false, error: 'Nothing to export — no renderable messages.' }

    const ext = format === 'html' ? 'html' : 'md'
    const safeId = id.replace(/[^\w.-]+/gu, '-').slice(0, 24) || 'session'
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const saveOptions = {
      title: format === 'html' ? 'Export Session as HTML' : 'Export Session as Markdown',
      defaultPath: join(app.getPath('downloads'), `${source}-session-${safeId}.${ext}`),
      filters:
        format === 'html'
          ? [{ name: 'HTML', extensions: ['html', 'htm'] }]
          : [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, saveOptions) : await dialog.showSaveDialog(saveOptions)
    if (result.canceled || !result.filePath) return { ok: true, canceled: true }

    const identity = { source, id }
    const content =
      format === 'html' ? buildHtmlExport(meta, payload, identity) : buildMarkdownExport(meta, payload, identity)
    fs.writeFileSync(result.filePath, content, 'utf8')
    shell.showItemInFolder(result.filePath)
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) }
  }
})

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

ipcMain.handle('dialog:confirm', async (_e, message: string, detail?: string) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  const opts = {
    type: 'warning' as const,
    buttons: ['Delete', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete Session',
    message,
    detail
  }
  const result = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return result.response === 0
})

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
