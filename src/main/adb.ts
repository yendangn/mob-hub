import { execFile } from 'node:child_process'
import { AdbServerClient, type Adb } from '@yume-chan/adb'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import type { DeviceInfo } from '@shared/types'
import { childEnv, resolveTool } from './tools'

const client = new AdbServerClient(new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 }))

let lastJson = ''
let lastDevices: DeviceInfo[] = []
let timer: NodeJS.Timeout | undefined
let listener: ((d: DeviceInfo[]) => void) | undefined
let serverStarting: Promise<void> | undefined
let inFlight: Promise<void> | undefined
let failures = 0
let watching = false
let interval = 1500
/** Report an empty list only after this many failed polls in a row, so one adb hiccup does not drop every tile. */
const FAILURES_BEFORE_EMPTY = 2

/** Make sure the adb server is running (we talk to it over TCP 5037). */
export async function ensureAdbServer(): Promise<void> {
  try {
    await client.getVersion()
    return
  } catch {
    /* not running — start it */
  }
  serverStarting ??= (async () => {
    const adb = await resolveTool('adb')
    if (!adb) throw new Error('adb not found. Install it with `brew install android-platform-tools` or set its path in Settings.')
    await new Promise<void>((resolve, reject) =>
      execFile(adb, ['start-server'], { env: childEnv(adb), timeout: 15000 }, (err) =>
        err ? reject(err) : resolve()
      )
    )
  })().finally(() => (serverStarting = undefined))
  await serverStarting
}

function isWireless(serial: string) {
  return /:\d+$/.test(serial) || serial.includes('._adb-tls-connect')
}

async function listDevices(): Promise<DeviceInfo[]> {
  await ensureAdbServer()
  const devices = await client.getDevices(['device', 'unauthorized', 'offline'])
  return devices
    .map((d) => ({
      serial: d.serial,
      state: d.state as DeviceInfo['state'],
      model: d.model?.replace(/_/g, ' '),
      product: d.product,
      wireless: isWireless(d.serial)
    }))
    .sort((a, b) => a.serial.localeCompare(b.serial))
}

function publish(devices: DeviceInfo[]) {
  lastDevices = devices
  const json = JSON.stringify(devices)
  if (json !== lastJson) {
    lastJson = json
    listener?.(devices)
  }
}

/** One poll at a time: a slow adb answer cannot arrive after a newer one and restore an old list. */
function poll(): Promise<void> {
  inFlight ??= (async () => {
    try {
      publish(await listDevices())
      failures = 0
    } catch (e) {
      console.warn('[adb] poll failed:', (e as Error).message)
      if (++failures >= FAILURES_BEFORE_EMPTY) publish([])
    }
  })().finally(() => (inFlight = undefined))
  return inFlight
}

function schedule() {
  clearTimeout(timer)
  if (!watching) return
  timer = setTimeout(() => void poll().finally(schedule), interval)
}

export function watchDevices(cb: (d: DeviceInfo[]) => void, intervalMs = 1500) {
  listener = cb
  interval = intervalMs
  lastJson = ''
  watching = true
  void poll().finally(schedule)
}

export function forceRefresh() {
  lastJson = ''
  return poll()
}

export function stopWatching() {
  watching = false
  clearTimeout(timer)
}

/** True if the serial is a device from the last poll that is ready for use. */
export function isKnownDevice(serial: unknown): serial is string {
  return typeof serial === 'string' && lastDevices.some((d) => d.serial === serial && d.state === 'device')
}

export async function createAdb(serial: string): Promise<Adb> {
  await ensureAdbServer()
  return client.createAdb({ serial })
}
