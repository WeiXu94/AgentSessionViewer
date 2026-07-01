import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { SearchIndexProgress, SessionsAPI } from '../shared/ipc.js'

const api: SessionsAPI = {
  list: (force) => ipcRenderer.invoke('sessions:list', force),
  loadTranscript: (originalPath, source, id) => ipcRenderer.invoke('transcript:load', originalPath, source, id),
  deleteSession: (originalPath, source, id) => ipcRenderer.invoke('sessions:delete', originalPath, source, id),
  searchSessions: (query, options) => ipcRenderer.invoke('search:query', query, options),
  onSearchIndexProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: SearchIndexProgress): void => callback(progress)
    ipcRenderer.on('searchIndex:progress', listener)
    return () => ipcRenderer.removeListener('searchIndex:progress', listener)
  },
  exportSession: (originalPath, source, id, format) =>
    ipcRenderer.invoke('export:session', originalPath, source, id, format),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  confirm: (message, detail) => ipcRenderer.invoke('dialog:confirm', message, detail),
  getAccentColor: () => ipcRenderer.invoke('system:accentColor'),
  onAccentColorChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, accent: string): void => callback(accent)
    ipcRenderer.on('system:accentColorChanged', listener)
    return () => ipcRenderer.removeListener('system:accentColorChanged', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
