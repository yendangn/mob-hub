import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/types'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void) {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  toolStatus: () => ipcRenderer.invoke('tools:status'),
  onDevices: (cb) => on('devices', cb),
  refreshDevices: () => ipcRenderer.invoke('devices:refresh'),

  openWindow: (serial, title) => ipcRenderer.invoke('window:open', serial, title),
  closeWindow: (serial) => ipcRenderer.invoke('window:close', serial),
  onWindowsChanged: (cb) => on('windows', cb),

  gridStart: (serial) => ipcRenderer.invoke('grid:start', serial),
  gridStop: (serial) => ipcRenderer.invoke('grid:stop', serial),
  onGridPacket: (cb) => on('grid:packet', cb),
  onGridEnded: (cb) => on('grid:ended', cb),
  touch: (serials, t) => ipcRenderer.send('grid:touch', serials, t),
  scroll: (serials, s) => ipcRenderer.send('grid:scroll', serials, s),
  key: (serials, k) => ipcRenderer.send('grid:key', serials, k),
  nav: (serials, b) => ipcRenderer.send('grid:nav', serials, b),
  resetVideo: (serial) => ipcRenderer.send('grid:resetVideo', serial),

  screenshot: (serial, label, copyToClipboard) => ipcRenderer.invoke('screenshot:take', serial, label, copyToClipboard),
  revealFile: (path) => ipcRenderer.invoke('screenshot:reveal', path),
  copyScreenText: (serial, region) => ipcRenderer.invoke('ocr:copyText', serial, region),

  onError: (cb) => on('error', cb)
}

contextBridge.exposeInMainWorld('api', api)
