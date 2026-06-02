import { contextBridge, ipcRenderer } from 'electron'
import type { SessionsAPI } from '../shared/ipc.js'

const api: SessionsAPI = {
  list: (force) => ipcRenderer.invoke('sessions:list', force),
  loadTranscript: (originalPath, source, id) => ipcRenderer.invoke('transcript:load', originalPath, source, id),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text)
}

contextBridge.exposeInMainWorld('api', api)
