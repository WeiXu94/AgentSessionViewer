import type { SessionsAPI } from '../../shared/ipc'

declare global {
  interface Window {
    api: SessionsAPI
  }
}

export {}
