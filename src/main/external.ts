import { spawn, type ChildProcess } from 'node:child_process'
import { BrowserWindow, screen } from 'electron'
import { getSettings } from './settings'
import { childEnv, resolveTool } from './tools'

/**
 * Mode A: one native scrcpy window per device, placed on a grid of slots
 * to the right of the app window. macOS can't reparent foreign windows, so
 * "tiling" = launching each scrcpy at a computed position.
 */

interface Running {
  proc: ChildProcess
  slot: number
  stderr: string[]
}

const running = new Map<string, Running>()
let onChange: ((serials: string[]) => void) | undefined
let onError: ((msg: string) => void) | undefined

export function setExternalListeners(change: typeof onChange, error: typeof onError) {
  onChange = change
  onError = error
}

const emit = () => onChange?.([...running.keys()])

function freeSlot(): number {
  const used = new Set([...running.values()].map((r) => r.slot))
  let i = 0
  while (used.has(i)) i++
  return i
}

function slotGeometry(slot: number) {
  const s = getSettings()
  const h = s.windowHeight
  const w = Math.round(h * 0.47) // typical phone aspect ~ 9:19.5 incl. borders
  const gap = 8
  const titleBar = 28

  const main = BrowserWindow.getAllWindows()[0]
  const display = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  const area = display.workArea

  // Start right of the app window if there is room for at least one tile.
  let startX = area.x
  if (main) {
    const b = main.getBounds()
    if (b.x + b.width + w + gap <= area.x + area.width) startX = b.x + b.width + gap
  }
  const cols = Math.max(1, Math.floor((area.x + area.width - startX) / (w + gap)))
  const col = slot % cols
  const row = Math.floor(slot / cols)
  const y = area.y + titleBar + row * (h + titleBar + gap)
  return {
    x: startX + col * (w + gap),
    y: Math.min(y, area.y + area.height - 100),
    h
  }
}

/** Split like a shell: quotes group words and are removed, also inside a token (--opt="a b" → --opt=a b). */
function splitArgs(s: string): string[] {
  return (s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((a) => a.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
}

export async function openWindow(serial: string, title: string): Promise<void> {
  if (running.has(serial)) return
  if (serial.startsWith('-')) throw new Error('Invalid device serial')
  const scrcpy = await resolveTool('scrcpy')
  if (!scrcpy) throw new Error('scrcpy not found. Install it with `brew install scrcpy` or set its path in Settings.')
  const adb = await resolveTool('adb')
  const s = getSettings()
  const slot = freeSlot()
  const g = slotGeometry(slot)

  const args = [
    '-s', serial,
    '--window-title', title,
    '--window-x', String(g.x),
    '--window-y', String(g.y),
    '--window-height', String(g.h),
    '--video-bit-rate', `${Math.round(s.bitrateMbps * 1000)}K`,
    '--no-audio'
  ]
  if (s.maxSize > 0) args.push('--max-size', String(s.maxSize))
  if (s.maxFps > 0) args.push('--max-fps', String(s.maxFps))
  args.push(...splitArgs(s.extraArgs))

  const proc = spawn(scrcpy, args, { env: childEnv(adb), stdio: ['ignore', 'pipe', 'pipe'] })
  const entry: Running = { proc, slot, stderr: [] }
  running.set(serial, entry)
  emit()

  const collect = (buf: Buffer) => {
    const lines = buf.toString().split('\n').filter(Boolean)
    entry.stderr.push(...lines)
    if (entry.stderr.length > 30) entry.stderr.splice(0, entry.stderr.length - 30)
  }
  proc.stdout?.on('data', collect)
  proc.stderr?.on('data', collect)

  const startedAt = Date.now()
  proc.on('error', (e) => onError?.(`[${title}] ${e.message}`))
  proc.on('exit', (code) => {
    if (running.get(serial)?.proc === proc) running.delete(serial)
    emit()
    if (code && code !== 0 && Date.now() - startedAt < 10_000) {
      const tail = entry.stderr.filter((l) => /ERROR|error|WARN/.test(l)).slice(-4).join('\n')
      onError?.(`scrcpy (${title}) exited with code ${code}\n${tail || entry.stderr.slice(-4).join('\n')}`)
    }
  })
}

export async function closeWindow(serial: string) {
  const r = running.get(serial)
  if (!r) return
  running.delete(serial)
  r.proc.kill('SIGTERM')
  emit()
}

export function closeAllWindows() {
  for (const r of running.values()) r.proc.kill('SIGTERM')
  running.clear()
}

export function runningSerials() {
  return [...running.keys()]
}
