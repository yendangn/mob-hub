import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { getSettings } from './settings'

/**
 * GUI apps on macOS don't inherit the shell PATH, so `adb`/`scrcpy` installed by
 * Homebrew or Android Studio are not found by name. We search well-known locations.
 */
function candidateDirs(): string[] {
  const home = homedir()
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, 'Library/Android/sdk/platform-tools'),
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'platform-tools'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'platform-tools'),
    join(home, 'Android/Sdk/platform-tools'),
    ...(process.env.PATH ?? '').split(delimiter)
  ]
  return [...new Set(dirs.filter(Boolean) as string[])]
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnDisk(name: string): string | undefined {
  for (const dir of candidateDirs()) {
    const p = join(dir, name)
    if (isExecutable(p)) return p
  }
  return undefined
}

/** Last resort: ask the user's login shell (picks up ~/.zshrc PATH tweaks). */
function findViaShell(name: string): Promise<string | undefined> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `command -v ${name}`], { timeout: 4000 }, (err, stdout) => {
      const line = stdout?.toString().trim().split('\n').pop()
      resolve(!err && line && isExecutable(line) ? line : undefined)
    })
  })
}

/**
 * Cache of search results. null = not found: do not search again (the login shell is slow)
 * until resetToolCache(), which runs when the user saves Settings.
 */
const resolved = new Map<string, Promise<string | null>>()

export async function resolveTool(name: 'adb' | 'scrcpy'): Promise<string | undefined> {
  const configured = name === 'adb' ? getSettings().adbPath : getSettings().scrcpyPath
  if (configured) return isExecutable(configured) ? configured : undefined
  let p = resolved.get(name)
  if (p) {
    const found = await p
    if (found === null || isExecutable(found)) return found ?? undefined
  }
  p = (async () => findOnDisk(name) ?? (await findViaShell(name)) ?? null)()
  resolved.set(name, p)
  return (await p) ?? undefined
}

export function resetToolCache() {
  resolved.clear()
}

/** Env for child processes: full PATH + ADB so scrcpy uses the same adb as us. */
export function childEnv(adbPath?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: candidateDirs().join(delimiter),
    ...(adbPath ? { ADB: adbPath } : {})
  }
}
