import { app, clipboard, net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  DefaultServerPath,
  ScrcpyInstanceId,
  ScrcpyPointerId,
  type ScrcpyControlMessageWriter
} from '@yume-chan/scrcpy'
import { ReadableStream, WritableStream } from '@yume-chan/stream-extra'
import type {
  GridSessionInfo,
  KeyInput,
  NavButton,
  ScrollInput,
  Settings,
  TouchInput,
  VideoPacket
} from '@shared/types'
import server from '@shared/scrcpy-server.json'
import { createAdb } from './adb'
import { getSettings } from './settings'

/**
 * Mode B: run scrcpy-server ourselves (no scrcpy desktop client), receive the raw
 * H.264 stream over adb and forward packets to the renderer, which decodes them
 * with WebCodecs into a <canvas>. Control messages go back the other way.
 *
 * The server protocol must match what @yume-chan/scrcpy implements (ScrcpyOptionsLatest).
 * The version and SHA-256 are in src/shared/scrcpy-server.json.
 */
const SERVER_VERSION = server.version
const SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SERVER_VERSION}/scrcpy-server-v${SERVER_VERSION}`

interface Session {
  id: number
  client: AdbScrcpyClient<ReturnType<typeof createOptions>>
  controller?: ScrcpyControlMessageWriter
  width: number
  height: number
  stopping: boolean
  /** Input messages run one after another, so that a touch or key cannot overtake a paste. */
  inputQueue: Promise<unknown>
  /** Text of a paste that is queued but not sent yet. More text typed right after it joins it. */
  pendingPaste?: { text: string }
  /** True while the last queued input item is pendingPaste, so appending keeps the order. */
  lastIsPaste: boolean
  /** Last text the user copied on the device (from clipboard sync), put back after the grid pastes. */
  deviceClipboard?: string
  restoreTimer?: NodeJS.Timeout
}

interface PendingStart {
  id: number
  cancelled: boolean
  promise: Promise<GridSessionInfo>
}

let nextId = 1
const sessions = new Map<string, Session>()
const starting = new Map<string, PendingStart>()
/** Stops that are closing a server. A new start for the same device waits for them. */
const stopping = new Map<string, Promise<void>>()

export interface GridSink {
  packet(serial: string, sessionId: number, p: VideoPacket): void
  ended(serial: string, sessionId: number, reason?: string): void
}
let sink: GridSink | undefined
export const setGridSink = (s: GridSink) => (sink = s)

// ---------- server binary ----------

let serverBytes: Promise<Uint8Array> | undefined

const sha256 = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex')

/** One load or download, shared by all starts ("+ All" on a first run starts many at once). */
function getServerBinary(): Promise<Uint8Array> {
  serverBytes ??= loadServerBinary().catch((e) => {
    serverBytes = undefined // try again next time
    throw e
  })
  return serverBytes
}

async function loadServerBinary(): Promise<Uint8Array> {
  const name = `scrcpy-server-v${SERVER_VERSION}`
  const bundled = [
    join(process.resourcesPath ?? '', name), // packaged app (extraResources)
    join(app.getAppPath(), 'resources', name) // dev
  ]
  const cached = join(app.getPath('userData'), name)
  for (const p of [...bundled, cached]) {
    if (!existsSync(p)) continue
    const buf = new Uint8Array(readFileSync(p))
    if (sha256(buf) === server.sha256) return buf
    console.warn(`[grid] ${p} has an incorrect SHA-256, ignoring it`)
    if (p === cached) rmSync(p, { force: true })
  }
  const res = await net.fetch(SERVER_URL)
  if (!res.ok) throw new Error(`Failed to download scrcpy-server (${res.status}). Run "npm run fetch-server" when you are online.`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (sha256(buf) !== server.sha256) {
    throw new Error('The downloaded scrcpy-server has an incorrect SHA-256. Check your network, then try again.')
  }
  mkdirSync(dirname(cached), { recursive: true })
  writeFileSync(`${cached}.tmp`, buf)
  renameSync(`${cached}.tmp`, cached)
  return buf
}

// ---------- lifecycle ----------

function createOptions(s: Settings) {
  return new AdbScrcpyOptionsLatest(
    {
      video: true,
      audio: false,
      control: true,
      tunnelForward: true,
      scid: ScrcpyInstanceId.random(),
      maxSize: s.maxSize,
      // the server parses these with Integer.parseInt, so they must be integers
      videoBitRate: Math.round(s.bitrateMbps * 1_000_000),
      maxFps: s.maxFps,
      videoCodec: 'h264',
      // device clipboard changes come back to us, so the grid can put the user's clipboard back after a paste
      clipboardAutosync: true,
      stayAwake: true
    },
    { version: SERVER_VERSION }
  )
}

class StartCancelled extends Error {
  constructor() {
    super('Start cancelled')
  }
}

export function gridStart(serial: string): Promise<GridSessionInfo> {
  if (sessions.has(serial)) return Promise.reject(new Error('Device is already in the grid'))
  const pending = starting.get(serial)
  if (pending && !pending.cancelled) return pending.promise
  const entry: PendingStart = { id: nextId++, cancelled: false, promise: undefined! }
  // Two servers on one device at the same time can fail (one hardware encoder). Wait for the earlier run.
  const earlier = [pending?.promise, stopping.get(serial)].map((p) => p?.catch(() => {}))
  entry.promise = Promise.all(earlier)
    .then(() => doStart(serial, entry))
    .finally(() => {
      if (starting.get(serial) === entry) starting.delete(serial)
    })
  starting.set(serial, entry)
  return entry.promise
}

async function doStart(serial: string, pending: PendingStart): Promise<GridSessionInfo> {
  const checkCancelled = () => {
    if (pending.cancelled) throw new StartCancelled()
  }
  const s = getSettings()
  const adb = await createAdb(serial)
  const bin = await getServerBinary()
  checkCancelled()

  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bin)
        c.close()
      }
    })
  )
  checkCancelled()

  let client: Session['client']
  try {
    client = await AdbScrcpyClient.start(adb, DefaultServerPath, createOptions(s))
  } catch (e) {
    throw withServerOutput(e)
  }

  const session: Session = {
    id: pending.id,
    client,
    controller: client.controller,
    width: 0,
    height: 0,
    stopping: false,
    inputQueue: Promise.resolve(),
    lastIsPaste: false
  }

  try {
    checkCancelled()

    // Server log must be drained, otherwise the process can stall.
    void client.output
      .pipeTo(new WritableStream({ write: (line) => console.log(`[scrcpy ${serial}]`, line) }))
      .catch(() => {})

    // Text the user copies on the device also goes to the Mac clipboard (if the setting is on).
    // scrcpy-server does not echo the clipboard values that the grid sets for paste.
    void client.clipboard
      ?.pipeTo(
        new WritableStream({
          write: (text) => {
            session.deviceClipboard = text
            if (getSettings().syncClipboardToMac) clipboard.writeText(text)
          }
        })
      )
      .catch(() => {})

    const video = await client.videoStream
    checkCancelled()

    session.width = video.width
    session.height = video.height
    video.sizeChanged(({ width, height }) => {
      session.width = width
      session.height = height
    })
    sessions.set(serial, session)

    void video.stream
      .pipeTo(
        new WritableStream({
          write(packet) {
            if (packet.type === 'configuration' || packet.type === 'session') {
              sink?.packet(serial, session.id, packet)
            } else {
              sink?.packet(serial, session.id, {
                type: 'data',
                keyframe: packet.keyframe,
                // BigInt over IPC is fragile → send as string
                pts: packet.pts?.toString(),
                data: packet.data
              })
            }
          }
        })
      )
      .catch((e) => console.warn(`[grid ${serial}] video ended`, e?.message))

    void client.exited.then(() => {
      clearTimeout(session.restoreTimer)
      if (sessions.get(serial) === session) sessions.delete(serial)
      // A stop that the user started needs no message: the renderer already removed the tile.
      if (!session.stopping) sink?.ended(serial, session.id, 'scrcpy-server stopped (connection lost?)')
    })

    return {
      serial,
      sessionId: session.id,
      codec: video.metadata.codec,
      width: video.width,
      height: video.height,
      deviceName: video.metadata.deviceName
    }
  } catch (e) {
    session.stopping = true
    if (sessions.get(serial) === session) sessions.delete(serial)
    await client.close().catch(() => {})
    throw withServerOutput(e)
  }
}

/** Add the last lines of the server log, so that the user sees why the server stopped. */
function withServerOutput(e: unknown): unknown {
  if (e instanceof AdbScrcpyExitedError && e.output.length) {
    return new Error(`${e.message}\n${e.output.slice(-5).join('\n')}`)
  }
  return e
}

export async function gridStop(serial: string) {
  const pending = starting.get(serial)
  if (pending) {
    // A cancelled start closes its own server and never becomes a session. Do not look in
    // `sessions` after the wait: a session found there would be a newer run.
    pending.cancelled = true
    await pending.promise.catch(() => {})
    return
  }
  const s = sessions.get(serial)
  if (!s) return
  s.stopping = true
  clearTimeout(s.restoreTimer)
  sessions.delete(serial)
  const closing = s.client.close().catch(() => {})
  stopping.set(serial, closing)
  await closing
  if (stopping.get(serial) === closing) stopping.delete(serial)
}

export async function gridStopAll() {
  const serials = new Set([...sessions.keys(), ...starting.keys()])
  await Promise.all([...serials].map(gridStop))
}

// ---------- control ----------

function each(serials: string[], fn: (s: Session) => Promise<unknown> | undefined) {
  for (const serial of serials) {
    const s = sessions.get(serial)
    if (!s?.controller || !s.width) continue
    fn(s)?.catch((e) => console.warn(`[grid ${serial}] control failed`, (e as Error).message))
  }
}

/** Run fn after the earlier input messages of this session. */
function enqueueInput(s: Session, fn: () => Promise<unknown>) {
  s.lastIsPaste = false
  const next = s.inputQueue.then(fn)
  s.inputQueue = next.catch(() => {})
  return next
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function touch(serials: string[], t: TouchInput) {
  each(serials, (s) =>
    enqueueInput(s, () => s.controller!.injectTouch({
      action: t.action as 0 | 1 | 2,
      pointerId: ScrcpyPointerId.Finger,
      pointerX: Math.round(t.x * s.width),
      pointerY: Math.round(t.y * s.height),
      videoWidth: s.width,
      videoHeight: s.height,
      pressure: t.pressure,
      actionButton: 0,
      buttons: 0
    }))
  )
}

export function scroll(serials: string[], sc: ScrollInput) {
  each(serials, (s) =>
    enqueueInput(s, () => s.controller!.injectScroll({
      pointerX: Math.round(sc.x * s.width),
      pointerY: Math.round(sc.y * s.height),
      videoWidth: s.width,
      videoHeight: s.height,
      scrollX: sc.scrollX,
      scrollY: sc.scrollY,
      buttons: 0
    }))
  )
}

async function pressKey(c: ScrcpyControlMessageWriter, keyCode: number) {
  for (const action of [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up]) {
    await c.injectKeyCode({ action, keyCode: keyCode as AndroidKeyCode, repeat: 0, metaState: 0 })
  }
}

/** The device injects the paste key event asynchronously after it sets the clipboard. */
const PASTE_SETTLE_MS = 80
/** Put the user's device clipboard back when no paste happened for this long. */
const RESTORE_CLIPBOARD_MS = 600

/**
 * scrcpy-server types injectText as key events from the Android KeyCharacterMap, which only has ASCII.
 * Other characters (Vietnamese diacritics, emoji, CJK) are dropped, so they go through the device
 * clipboard and a paste action. sequence 0 = do not wait for the device to acknowledge.
 *
 * - Text typed while a paste is still queued joins that paste: one paste instead of many, and fewer
 *   chances for the next clipboard write to replace the text before the app reads it.
 * - After a paste, wait a short time before the next input.
 * - When the pastes stop, put back the text that the user last copied on the device (known only
 *   if the user copied it while the device was in the grid).
 */
function typeText(s: Session, text: string) {
  const c = s.controller!
  if (s.lastIsPaste && s.pendingPaste) {
    s.pendingPaste.text += text
    return undefined
  }
  if (/^[\x20-\x7e]*$/.test(text)) return enqueueInput(s, () => c.injectText(text))
  const paste = { text }
  const run = enqueueInput(s, async () => {
    if (s.pendingPaste === paste) s.pendingPaste = undefined
    clearTimeout(s.restoreTimer)
    await c.setClipboard({ sequence: 0n, paste: true, content: paste.text })
    await delay(PASTE_SETTLE_MS)
    s.restoreTimer = setTimeout(() => restoreClipboard(s), RESTORE_CLIPBOARD_MS)
  })
  s.pendingPaste = paste
  s.lastIsPaste = true
  return run
}

function restoreClipboard(s: Session) {
  if (s.deviceClipboard === undefined || s.stopping) return
  const content = s.deviceClipboard
  void enqueueInput(s, () => s.controller!.setClipboard({ sequence: 0n, paste: false, content })).catch(() => {})
}

export function key(serials: string[], k: KeyInput) {
  each(serials, (s) => {
    const c = s.controller!
    if (k.text) return k.down ? typeText(s, k.text) : undefined
    const keyCode = (AndroidKeyCode as Record<string, number>)[k.code]
    if (keyCode === undefined) return undefined
    return enqueueInput(s, () =>
      c.injectKeyCode({
        action: k.down ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
        keyCode: keyCode as AndroidKeyCode,
        repeat: 0,
        metaState: k.meta as never
      })
    )
  })
}

export function nav(serials: string[], b: NavButton) {
  each(serials, (s) =>
    enqueueInput(s, async () => {
      const c = s.controller!
      switch (b) {
        case 'back':
          await c.backOrScreenOn(AndroidKeyEventAction.Down)
          await c.backOrScreenOn(AndroidKeyEventAction.Up)
          return
        case 'home':
          return pressKey(c, AndroidKeyCode.AndroidHome)
        case 'recents':
          return pressKey(c, AndroidKeyCode.AndroidAppSwitch)
        case 'volUp':
          return pressKey(c, AndroidKeyCode.VolumeUp)
        case 'volDown':
          return pressKey(c, AndroidKeyCode.VolumeDown)
        case 'rotate':
          return c.rotateDevice()
      }
    })
  )
}

export function resetVideo(serial: string) {
  sessions.get(serial)?.controller?.resetVideo().catch(() => {})
}
