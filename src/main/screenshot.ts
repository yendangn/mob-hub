import { app, clipboard, ClipboardItem, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAdb } from './adb'
import { getSettings } from './settings'

/** PNG files start with these 8 bytes. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Files this app saved. Only these can be shown in Finder through IPC. */
const saved = new Set<string>()

function screenshotDir(): string {
  return getSettings().screenshotDir || app.getPath('desktop')
}

/** "Pixel 7 Pro" → "Pixel-7-Pro"; keep letters (also Vietnamese), digits, dot, dash, underscore. */
function safeName(s: string): string {
  return s.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'device'
}

function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/** Index of the first PNG signature in the data, or -1 if there is none. */
function findPngStart(data: Uint8Array): number {
  const last = data.length - PNG_SIGNATURE.length
  for (let i = 0; i <= last; i++) {
    if (PNG_SIGNATURE.every((b, j) => data[i + j] === b)) return i
  }
  return -1
}

/**
 * Full-resolution PNG of the device screen (`screencap -p` through adb exec, which keeps binary data unchanged).
 * Screens with a secure flag (banking apps, DRM video) come back black: Android does not allow capturing them.
 */
export async function captureScreen(serial: string): Promise<Uint8Array> {
  const adb = await createAdb(serial)
  const output = await adb.subprocess.noneProtocol.spawn(['screencap', '-p']).wait()
  // The none protocol merges stderr into stdout. Devices with more than one display
  // (Samsung foldables, DeX) write a warning before the PNG data, so skip to the signature.
  const start = findPngStart(output)
  if (start < 0) {
    const text = new TextDecoder().decode(output.subarray(0, 200)).trim()
    throw new Error(`Screenshot failed${text ? `: ${text}` : ''}`)
  }
  return start === 0 ? output : output.subarray(start)
}

/**
 * Take a full-resolution, lossless screenshot on the device, save it as PNG and copy it to the Mac clipboard.
 */
export async function takeScreenshot(serial: string, label: string, copyToClipboard: boolean): Promise<string> {
  const png = await captureScreen(serial)

  const dir = screenshotDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${safeName(label)}_${timestamp()}.png`)
  writeFileSync(file, png)
  saved.add(file)

  if (copyToClipboard) {
    await clipboard
      .write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
      .catch((e) => console.warn('[screenshot] clipboard write failed', (e as Error).message))
  }
  return file
}

export function revealScreenshot(file: string) {
  if (!saved.has(file)) throw new Error('Unknown file')
  shell.showItemInFolder(file)
}
