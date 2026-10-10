import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

const file = () => join(app.getPath('userData'), 'settings.json')

let cache: Settings | undefined

function num(v: unknown, fallback: number, min: number, max: number, integer: boolean): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(max, Math.max(min, n))
  return integer ? Math.round(clamped) : Math.round(clamped * 10) / 10
}

/**
 * A tool path must be empty (auto-detect) or an absolute path to a file named like the tool.
 * strict: throw (a save from the dialog shows the message). Not strict: drop the bad path and
 * keep the other settings (a file from an earlier version).
 */
function toolPath(v: unknown, tool: 'adb' | 'scrcpy', strict: boolean): string {
  if (typeof v !== 'string') return ''
  const p = v.trim()
  if (!p) return ''
  let error: string | undefined
  if (!isAbsolute(p)) error = `The ${tool} path must be an absolute path.`
  else if (!basename(p).toLowerCase().startsWith(tool)) error = `The ${tool} path must point to the ${tool} program.`
  if (!error) return p
  if (strict) throw new Error(error)
  console.warn(`[settings] ignoring ${tool} path "${p}": ${error}`)
  return ''
}

/** A folder must be empty (the default folder) or an absolute path. */
function dirPath(v: unknown, strict: boolean): string {
  if (typeof v !== 'string') return ''
  const p = v.trim()
  if (!p || isAbsolute(p)) return p
  if (strict) throw new Error('The screenshot folder must be an absolute path.')
  console.warn(`[settings] ignoring screenshot folder "${p}": not an absolute path`)
  return ''
}

/**
 * Settings come from the renderer and from a file on disk, so check every field.
 * Numbers are clamped to safe ranges. scrcpy-server rejects non-integer values for most of them.
 */
function sanitizeSettings(input: unknown, strict = true): Settings {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  return {
    adbPath: toolPath(s.adbPath, 'adb', strict),
    scrcpyPath: toolPath(s.scrcpyPath, 'scrcpy', strict),
    windowHeight: num(s.windowHeight, d.windowHeight, 200, 4000, true),
    maxSize: num(s.maxSize, d.maxSize, 0, 8192, true),
    bitrateMbps: num(s.bitrateMbps, d.bitrateMbps, 0.1, 200, false),
    maxFps: num(s.maxFps, d.maxFps, 0, 240, true),
    extraArgs: typeof s.extraArgs === 'string' ? s.extraArgs.slice(0, 2000) : d.extraArgs,
    screenshotDir: dirPath(s.screenshotDir, strict)
  }
}

export function getSettings(): Settings {
  if (cache) return cache
  try {
    if (existsSync(file())) {
      cache = sanitizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file(), 'utf8')) }, false)
      return cache
    }
  } catch (e) {
    console.warn('[settings] failed to read, using defaults', e)
  }
  cache = { ...DEFAULT_SETTINGS }
  return cache
}

export function saveSettings(input: unknown): Settings {
  cache = sanitizeSettings(input)
  writeFileSync(file(), JSON.stringify(cache, null, 2))
  return cache
}
