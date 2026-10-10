import type { VideoPacket } from '@shared/types'

/**
 * Routes video packets from main to the right tile. Packets can arrive before the
 * tile has created its decoder (the stream starts before gridStart() resolves),
 * so we queue them per serial until a handler registers.
 *
 * Every packet carries the id of the server run that sent it. A tile takes only packets
 * of its own run: a late packet from an earlier run (the device was removed and added
 * again quickly) would reach the decoder before its configuration and stop it.
 */
type Handler = (p: VideoPacket) => void
interface Entry {
  sessionId: number
  p: VideoPacket
}
const handlers = new Map<string, { sessionId: number; h: Handler }>()
const queues = new Map<string, Entry[]>()
const lastConfig = new Map<string, Entry>()
const MAX_QUEUE = 600

let installed = false
function install() {
  if (installed) return
  installed = true
  window.api.onGridPacket((serial, sessionId, p) => {
    const handler = handlers.get(serial)
    const q = queues.get(serial)
    // Queue only for a tile that is starting (prepare() was called). Drop packets for removed tiles.
    if (!handler && !q) return
    if (p.type === 'configuration') lastConfig.set(serial, { sessionId, p })
    if (handler) {
      if (handler.sessionId === sessionId) handler.h(p)
      return
    }
    if (q!.length < MAX_QUEUE) q!.push({ sessionId, p })
  })
}

export function register(serial: string, sessionId: number, h: Handler) {
  install()
  const handler = { sessionId, h }
  handlers.set(serial, handler)
  const q = (queues.get(serial) ?? []).filter((e) => e.sessionId === sessionId)
  queues.delete(serial)
  const config = lastConfig.get(serial)
  if (q.length) {
    q.forEach((e) => h(e.p))
  } else if (config?.sessionId === sessionId) {
    // Joining a stream already in progress: replay codec config and ask the
    // server for a fresh keyframe so the new decoder can start.
    h(config.p)
    window.api.resetVideo(serial)
  }
  return () => {
    if (handlers.get(serial) === handler) handlers.delete(serial)
  }
}

export function prepare(serial: string) {
  install()
  queues.set(serial, [])
  lastConfig.delete(serial)
}

export function discard(serial: string) {
  queues.delete(serial)
  lastConfig.delete(serial)
  handlers.delete(serial)
}
