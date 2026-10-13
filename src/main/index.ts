import { app, BrowserWindow, ipcMain, shell, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NavButton, ToolStatus } from '@shared/types'
import { ensureAdbServer, forceRefresh, isKnownDevice, stopWatching, watchDevices } from './adb'
import { closeAllWindows, closeWindow, openWindow, runningSerials, setExternalListeners } from './external'
import { gridStart, gridStop, gridStopAll, key, nav, resetVideo, scroll, setGridSink, touch } from './grid'
import { revealScreenshot, takeScreenshot } from './screenshot'
import { copyScreenText } from './ocr'
import { getSettings, saveSettings } from './settings'
import { resetToolCache, resolveTool } from './tools'

let win: BrowserWindow | undefined

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const RENDERER_HTML = join(__dirname, '../renderer/index.html')

/** True only for the app's own page (the dev server in dev, the bundled index.html when packaged). */
function isAppUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    const dev = process.env.ELECTRON_RENDERER_URL
    // compare the origin, not a string prefix: "http://localhost:5173@evil.com" must not match
    if (dev) return u.origin === new URL(dev).origin
    // compare decoded paths: an install folder name can contain [ ] % | and other characters
    // that different URL encoders write in different ways
    return u.protocol === 'file:' && fileURLToPath(u) === RENDERER_HTML
  } catch {
    return false
  }
}

async function toolStatus(): Promise<ToolStatus> {
  const [adb, scrcpy] = await Promise.all([resolveTool('adb'), resolveTool('scrcpy')])
  let adbError: string | undefined
  try {
    await ensureAdbServer()
  } catch (e) {
    adbError = (e as Error).message
  }
  return { adb, scrcpy, adbError }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: 'Mob Hub',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true
    }
  })

  // Open only web links in the browser. Block other schemes (file:, custom app protocols).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The preload exposes window.api to any page in this window. Never leave the app page
  // (for example, when a link or an HTML file is dropped on the window).
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })
  win.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(RENDERER_HTML)
  }

  // Runs on the first load and on every reload (Cmd+R, dev hot reload): the new page has no state,
  // so stop the grid sessions it cannot see and send the current lists again.
  win.webContents.on('did-finish-load', () => {
    void gridStopAll()
    watchDevices((d) => send('devices', d))
    send('windows', runningSerials())
  })
}

// ---------- IPC ----------

class IpcRejected extends Error {}

function assertTrusted(e: IpcMainEvent | IpcMainInvokeEvent) {
  if (!isAppUrl(e.senderFrame?.url)) throw new IpcRejected(`IPC from untrusted page: ${e.senderFrame?.url}`)
}

function assertDevice(serial: unknown): asserts serial is string {
  if (!isKnownDevice(serial)) throw new Error('Unknown device. Refresh the device list, then try again.')
}

const isSerialList = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const NAV_BUTTONS: readonly NavButton[] = ['back', 'home', 'recents', 'volUp', 'volDown', 'rotate']

/** ipcMain.handle with a sender check. */
function handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    assertTrusted(e)
    return fn(...(args as A))
  })
}

/** ipcMain.on with a sender check. Bad input is dropped with a warning. */
function listen(channel: string, fn: (...args: unknown[]) => void) {
  ipcMain.on(channel, (e, ...args) => {
    try {
      assertTrusted(e)
      fn(...args)
    } catch (err) {
      console.warn(`[ipc] ${channel} rejected:`, (err as Error).message)
    }
  })
}

function registerIpc() {
  handle('settings:get', () => getSettings())
  handle('settings:save', async (s: unknown) => {
    saveSettings(s)
    resetToolCache()
    void forceRefresh()
    return toolStatus()
  })
  // search for adb/scrcpy again: the user may have installed them since the last search
  handle('tools:status', () => {
    resetToolCache()
    return toolStatus()
  })
  handle('devices:refresh', () => {
    resetToolCache()
    return forceRefresh()
  })

  handle('window:open', (serial: unknown, title: unknown) => {
    assertDevice(serial)
    return openWindow(serial, typeof title === 'string' && title ? title.slice(0, 200) : serial)
  })
  handle('window:close', (serial: unknown) => typeof serial === 'string' && closeWindow(serial))

  handle('grid:start', (serial: unknown) => {
    assertDevice(serial)
    return gridStart(serial)
  })
  handle('grid:stop', (serial: unknown) => typeof serial === 'string' && gridStop(serial))

  listen('grid:touch', (serials, t) => {
    const v = t as Record<string, unknown>
    if (!isSerialList(serials) || !v || ![0, 1, 2].includes(v.action as number)) throw new Error('bad touch')
    if (!isNum(v.x) || !isNum(v.y) || !isNum(v.pressure)) throw new Error('bad touch')
    touch(serials, { action: v.action as number, x: v.x, y: v.y, pressure: v.pressure })
  })
  listen('grid:scroll', (serials, s) => {
    const v = s as Record<string, unknown>
    if (!isSerialList(serials) || !v || !isNum(v.x) || !isNum(v.y) || !isNum(v.scrollX) || !isNum(v.scrollY)) {
      throw new Error('bad scroll')
    }
    scroll(serials, { x: v.x, y: v.y, scrollX: v.scrollX, scrollY: v.scrollY })
  })
  listen('grid:key', (serials, k) => {
    const v = k as Record<string, unknown>
    if (!isSerialList(serials) || !v || typeof v.code !== 'string' || typeof v.down !== 'boolean' || !isNum(v.meta)) {
      throw new Error('bad key')
    }
    if (v.text !== undefined && (typeof v.text !== 'string' || v.text.length > 5000)) throw new Error('bad key text')
    key(serials, { code: v.code, text: v.text as string | undefined, down: v.down, meta: v.meta })
  })
  listen('grid:nav', (serials, b) => {
    if (!isSerialList(serials) || !NAV_BUTTONS.includes(b as NavButton)) throw new Error('bad nav')
    nav(serials, b as NavButton)
  })
  handle('screenshot:take', (serial: unknown, label: unknown, copyToClipboard: unknown) => {
    assertDevice(serial)
    const name = typeof label === 'string' && label ? label : serial
    return takeScreenshot(serial, name, copyToClipboard === true).then((path) => ({ path }))
  })
  handle('screenshot:reveal', (path: unknown) => {
    if (typeof path !== 'string') throw new Error('bad path')
    revealScreenshot(path)
  })
  handle('ocr:copyText', (serial: unknown, region: unknown) => {
    assertDevice(serial)
    if (region === undefined) return copyScreenText(serial)
    const r = region as Record<string, unknown>
    const ok = (v: unknown) => isNum(v) && v >= 0 && v <= 1
    if (!r || !ok(r.x) || !ok(r.y) || !ok(r.w) || !ok(r.h) || (r.w as number) <= 0 || (r.h as number) <= 0) {
      throw new Error('bad region')
    }
    return copyScreenText(serial, { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number })
  })
  listen('grid:resetVideo', (serial) => {
    if (typeof serial === 'string') resetVideo(serial)
  })

  setExternalListeners(
    (serials) => send('windows', serials),
    (msg) => send('error', msg)
  )
  setGridSink({
    packet: (serial, sessionId, p) => send('grid:packet', serial, sessionId, p),
    ended: (serial, sessionId, reason) => send('grid:ended', serial, sessionId, reason)
  })
}

// The macOS press-and-hold accent popup replaces a character that the grid already sent to the device,
// which gives "eé". Turn it off for this app: holding a key repeats it, as on a hardware keyboard.
if (process.platform === 'darwin') systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false)

app.whenReady().then(() => {
  // The packaged app gets its icon from build/icon.icns. In dev, the dock shows the Electron icon unless we set it.
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png'))
  }
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  stopWatching()
  closeAllWindows()
  void gridStopAll()
})
