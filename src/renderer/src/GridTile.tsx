import { useEffect, useRef, useState } from 'react'
import type { ScrcpyVideoCodecId, ScrcpyVideoStreamPacket } from '@yume-chan/scrcpy'
import { ReadableStream, type ReadableStreamDefaultController } from '@yume-chan/stream-extra'
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer
} from '@yume-chan/scrcpy-decoder-webcodecs'
import type { GridSessionInfo, NavButton, OcrRegion, VideoPacket } from '@shared/types'
import { register } from './gridBus'
import { Icon } from './icons'

interface Props {
  info: GridSessionInfo
  title: string
  /** serials that should receive input from this tile (self, or all when sync is on) */
  targets: () => string[]
  synced: boolean
  onClose(): void
  /** Take screenshots of these devices. */
  onScreenshot(serials: string[]): Promise<void>
  /** Read the text on this device's screen (or in a region of it) and copy it to the Mac clipboard. */
  onCopyText(serial: string, region?: OcrRegion): Promise<void>
}

/** A drag shorter than this (CSS px) is a click: read the whole screen. */
const MIN_DRAG = 6

// AndroidKeyEventMeta bits
const META = { shift: 1, alt: 2, ctrl: 4096, meta: 65536 }
const IS_MAC = navigator.userAgent.includes('Mac')

const NAV_LEFT: [NavButton, string][] = [['back', 'Back'], ['home', 'Home'], ['recents', 'Recents']]
const NAV_RIGHT: [NavButton, string][] = [['volDown', 'Volume down'], ['volUp', 'Volume up'], ['rotate', 'Rotate screen']]

export function GridTile({ info, title, targets, synced, onClose, onScreenshot, onCopyText }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const sizeRef = useRef({ w: info.width, h: info.height })
  const [size, setSize] = useState({ w: info.width, h: info.height })
  const [fps, setFps] = useState(0)
  const pressed = useRef(false)
  const [capturing, setCapturing] = useState(false)
  /** Keys sent down to the device, with the serials they went to. Keyup goes to the same serials. */
  const held = useRef(new Map<string, string[]>())
  /** Text that the IME is composing (for example, Telex), shown over the screen until it is committed. */
  const [composing, setComposing] = useState('')
  /** "Copy text" mode: the user drags a box over the screen. Touches do not go to the device. */
  const [selecting, setSelecting] = useState(false)
  /** The box being dragged, in client coordinates. */
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number }>()
  const [reading, setReading] = useState(false)
  const screenRef = useRef<HTMLDivElement>(null)
  /** "More" menu (volume, rotate): open/closed. */
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  // Close the "more" menu on an outside click or Esc.
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [moreOpen])

  // decoder lifecycle
  useEffect(() => {
    const canvas = canvasRef.current!
    if (!WebCodecsVideoDecoder.isSupported) {
      console.error('WebCodecs not supported')
      return
    }
    const renderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer({ canvas })
      : new BitmapVideoFrameRenderer({ canvas })
    const decoder = new WebCodecsVideoDecoder({ codec: info.codec as ScrcpyVideoCodecId, renderer })

    let controller!: ReadableStreamDefaultController<ScrcpyVideoStreamPacket>
    const source = new ReadableStream<ScrcpyVideoStreamPacket>({
      start(c) {
        controller = c
      }
    })
    void source
      .pipeTo(decoder.writable)
      .catch((e: Error) => console.warn(`[${info.serial}] decoder stopped`, e.message))

    const removeSize = decoder.sizeChanged(({ width, height }) => {
      sizeRef.current = { w: width, h: height }
      setSize({ w: width, h: height })
    })

    const unregister = register(info.serial, info.sessionId, (p: VideoPacket) => {
      try {
        controller.enqueue(
          p.type === 'data'
            ? { ...p, pts: p.pts !== undefined ? BigInt(p.pts) : undefined }
            : p
        )
      } catch {
        /* stream closed */
      }
    })

    let last = 0
    const fpsTimer = setInterval(() => {
      const n = decoder.framesRendered
      setFps(n - last)
      last = n
    }, 1000)

    return () => {
      clearInterval(fpsTimer)
      unregister()
      removeSize()
      try {
        controller.close()
      } catch {
        /* already closed */
      }
      decoder.dispose()
    }
  }, [info.serial, info.sessionId, info.codec])

  // map a pointer position (CSS px) → normalized device coords, honoring object-fit: contain
  function toDevice(e: { clientX: number; clientY: number }) {
    const el = canvasRef.current!
    const r = el.getBoundingClientRect()
    const { w, h } = sizeRef.current
    if (!w || !h) return undefined
    const scale = Math.min(r.width / w, r.height / h)
    const dw = w * scale
    const dh = h * scale
    const ox = r.left + (r.width - dw) / 2
    const oy = r.top + (r.height - dh) / 2
    const x = (e.clientX - ox) / dw
    const y = (e.clientY - oy) / dh
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 }
  }

  const sendTouch = (action: number, e: React.PointerEvent) => {
    const p = toDevice(e)
    if (!p) return
    window.api.touch(targets(), { action, x: p.x, y: p.y, pressure: action === 1 ? 0 : 1 })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const p = toDevice(e)
    if (!p?.inside) return
    e.currentTarget.setPointerCapture(e.pointerId)
    inputRef.current?.focus()
    pressed.current = true
    sendTouch(0, e)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (pressed.current) sendTouch(2, e)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!pressed.current) return
    pressed.current = false
    sendTouch(1, e)
  }
  const onContextMenu = (e: React.MouseEvent) => {
    // right click = Back, like scrcpy
    e.preventDefault()
    window.api.nav(targets(), 'back')
  }
  const onWheel = (e: React.WheelEvent) => {
    const p = toDevice(e)
    if (!p?.inside) return
    const clamp = (v: number) => Math.max(-1, Math.min(1, v))
    window.api.scroll(targets(), {
      x: p.x,
      y: p.y,
      scrollX: clamp(-e.deltaX / 100),
      scrollY: clamp(-e.deltaY / 100)
    })
  }

  const meta = (e: React.KeyboardEvent) =>
    (e.shiftKey ? META.shift : 0) |
    (e.altKey ? META.alt : 0) |
    (e.ctrlKey ? META.ctrl : 0) |
    (e.metaKey && !IS_MAC ? META.meta : 0)

  // Keyboard input goes through a hidden <textarea>, so that IMEs (Vietnamese Telex/VNI, CJK) work.
  // Printable text arrives in onInput / onCompositionEnd / onPaste. Only non-printable keys go as key codes.
  // On macOS, Option types characters (for example, "@" on a German layout), so Alt does not make a key a shortcut.
  const isPrintable = (e: React.KeyboardEvent) =>
    e.key.length === 1 && !e.ctrlKey && !e.metaKey && (IS_MAC || !e.altKey || e.getModifierState('AltGraph'))
  // 'Process' (keyCode 229) = key handled by the IME, 'Dead' = macOS dead key that starts a composition
  const isImeKey = (e: React.KeyboardEvent) =>
    e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Dead' || e.keyCode === 229

  /** Main rejects longer text in one message, so send long pastes in parts. */
  const TEXT_CHUNK = 2000
  const sendText = (text: string) => {
    const serials = targets()
    for (let i = 0; i < text.length; i += TEXT_CHUNK) {
      window.api.key(serials, { code: '', text: text.slice(i, i + TEXT_CHUNK), down: true, meta: 0 })
    }
  }
  const pressKey = (code: string, metaState = 0) => {
    const serials = targets()
    window.api.key(serials, { code, down: true, meta: metaState })
    window.api.key(serials, { code, down: false, meta: metaState })
  }
  const releaseAll = () => {
    for (const [code, serials] of held.current) window.api.key(serials, { code, down: false, meta: 0 })
    held.current.clear()
  }

  /**
   * Cmd on macOS. The Mac keeps Cmd shortcuts (quit, close, hide, switch app, emoji picker...).
   * Cmd is never sent to the device: Android reads a lone Meta tap as "open Assistant".
   * Like scrcpy desktop, the text-editing shortcuts go to the device as Ctrl (Android uses Ctrl for them).
   * Shortcuts match the typed character, not the physical key, so they work on AZERTY and Dvorak.
   * Cmd+Shift+T is for this app: start or stop "Copy text".
   */
  const CMD_TO_CTRL = new Set(['a', 'c', 'x', 'z', 'y'])
  const onCmdKey = (e: React.KeyboardEvent) => {
    const ch = e.key.toLowerCase()
    if (ch === 't' && e.shiftKey) {
      e.preventDefault()
      if (!reading) toggleSelecting()
      return
    }
    if (ch === 'v') return // the browser pastes into the textarea, then onPaste sends it
    if (!CMD_TO_CTRL.has(ch)) return // leave it to the Mac
    e.preventDefault()
    const code = `Key${ch.toUpperCase()}`
    const metaState = META.ctrl | (e.shiftKey ? META.shift : 0)
    const serials = targets()
    window.api.key(serials, { code: 'ControlLeft', down: true, meta: META.ctrl })
    window.api.key(serials, { code, down: true, meta: metaState })
    window.api.key(serials, { code, down: false, meta: metaState })
    window.api.key(serials, { code: 'ControlLeft', down: false, meta: 0 })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeKey(e)) return
    // CapsLock: macOS sends keydown when it turns on and keyup when it turns off, and it often switches
    // the input source. The caps state already reaches the device through the typed text.
    if (e.key === 'CapsLock') return
    if (IS_MAC && (e.key === 'Meta' || e.metaKey)) return e.key === 'Meta' ? undefined : onCmdKey(e)
    if (isPrintable(e)) return // the browser inserts it, then onInput sends it
    e.preventDefault()
    const serials = held.current.get(e.code) ?? targets()
    held.current.set(e.code, serials)
    window.api.key(serials, { code: e.code, down: true, meta: meta(e) })
  }
  const onKeyUp = (e: React.KeyboardEvent) => {
    // Release only keys that were sent down, whatever the IME state is now.
    const serials = held.current.get(e.code)
    if (!serials) return
    e.preventDefault()
    held.current.delete(e.code)
    window.api.key(serials, { code: e.code, down: false, meta: meta(e) })
  }
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ne = e.nativeEvent as InputEvent
    if (ne.isComposing) return // wait for onCompositionEnd
    if (ne.inputType === 'insertText' && ne.data) sendText(ne.data)
    // an IME can pass Enter through (for example, to commit a word and send a message)
    else if (ne.inputType === 'insertLineBreak' || ne.inputType === 'insertParagraph') pressKey('Enter')
    e.currentTarget.value = ''
  }
  const onCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    setComposing('')
    sendText(e.data)
    e.currentTarget.value = ''
  }
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    sendText(e.clipboardData.getData('text/plain'))
  }
  // Clicks on the header and nav buttons must not take the focus from the textarea.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  const nav = (b: NavButton) => window.api.nav(targets(), b)
  const screenshot = async () => {
    setCapturing(true)
    try {
      await onScreenshot(targets())
    } finally {
      setCapturing(false)
    }
  }

  const stopSelecting = () => {
    setSelecting(false)
    setDrag(undefined)
  }
  const toggleSelecting = () => (selecting ? stopSelecting() : setSelecting(true))
  // While selecting, Esc and Enter are for this mode only: they must not go to the device.
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.preventDefault()
      e.stopPropagation()
      stopSelecting()
      if (e.key === 'Enter') void readText()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selecting])

  const readText = async (region?: OcrRegion) => {
    setReading(true)
    try {
      await onCopyText(info.serial, region)
    } finally {
      setReading(false)
    }
  }
  const onSelectDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY })
  }
  const onSelectMove = (e: React.PointerEvent) => {
    if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY })
  }
  const onSelectUp = (e: React.PointerEvent) => {
    if (!drag) return
    stopSelecting()
    if (Math.abs(e.clientX - drag.x0) < MIN_DRAG && Math.abs(e.clientY - drag.y0) < MIN_DRAG) return void readText()
    const a = toDevice({ clientX: drag.x0, clientY: drag.y0 })
    const b = toDevice(e)
    if (!a || !b) return
    const region = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
    // the box is outside the video (in the black bars)
    if (region.w > 0 && region.h > 0) void readText(region)
  }
  const dragBox = () => {
    const r = screenRef.current?.getBoundingClientRect()
    if (!drag || !r) return undefined
    return {
      left: Math.min(drag.x0, drag.x1) - r.left,
      top: Math.min(drag.y0, drag.y1) - r.top,
      width: Math.abs(drag.x1 - drag.x0),
      height: Math.abs(drag.y1 - drag.y0)
    }
  }
  const landscape = size.w > size.h

  return (
    <div
      className={`tile${synced ? ' synced' : ''}${landscape ? ' landscape' : ''}`}
      tabIndex={-1}
      onFocus={(e) => e.target === e.currentTarget && inputRef.current?.focus()}
    >
      <textarea
        ref={inputRef}
        className="tile-input"
        aria-label={`Keyboard input for ${title}`}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onInput={onInput}
        onCompositionStart={() => setComposing('')}
        onCompositionUpdate={(e) => setComposing(e.data)}
        onCompositionEnd={onCompositionEnd}
        onPaste={onPaste}
        onBlur={() => {
          releaseAll()
          setComposing('')
        }}
      />
      {composing && (
        // show the end of a long composition: that is the part being typed
        <div className="tile-compose">{composing.length > 40 ? `…${composing.slice(-40)}` : composing}</div>
      )}
      <div className="tile-head" onMouseDown={keepFocus}>
        <span className="tile-title" title={info.serial}>{title}</span>
        <span className="tile-meta">
          {size.w ? `${size.w}×${size.h}` : '—'} · {fps}fps
        </span>
        <button className="tile-btn" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="tile-screen" ref={screenRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={onContextMenu}
          onWheel={onWheel}
        />
        {selecting && (
          <div
            className="tile-select"
            onPointerDown={onSelectDown}
            onPointerMove={onSelectMove}
            onPointerUp={onSelectUp}
            onPointerCancel={stopSelecting}
            onContextMenu={(e) => {
              e.preventDefault()
              stopSelecting()
            }}
          >
            {drag ? <div className="tile-select-box" style={dragBox()} /> : <div className="tile-select-hint">Drag over text or a QR code to copy · Click or Enter for the whole screen · Esc to cancel</div>}
          </div>
        )}
      </div>
      <div className="tile-nav" onMouseDown={keepFocus}>
        {NAV_LEFT.map(([b, label]) => (
          <button key={b} className="tile-btn" title={label} aria-label={label} onClick={() => nav(b)}><Icon name={b} /></button>
        ))}
        <span className="spacer" />
        <button
          className="tile-btn"
          title={synced ? 'Screenshot of all devices in the grid' : 'Screenshot'}
          aria-label="Screenshot"
          disabled={capturing}
          onClick={screenshot}
        >
          <Icon name="camera" />
        </button>
        <button
          className={`tile-btn${selecting ? ' on' : ''}`}
          title="Copy text or a QR code from the screen (⌘⇧T)"
          aria-label="Copy text from the screen"
          aria-pressed={selecting}
          disabled={reading}
          onClick={toggleSelecting}
        >
          <Icon name="text" />
        </button>
        <div className="tile-more" ref={moreRef}>
          <button
            className={`tile-btn${moreOpen ? ' on' : ''}`}
            title="More"
            aria-label="More"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <Icon name="more" />
          </button>
          {moreOpen && (
            <div className="tile-menu">
              {NAV_RIGHT.map(([b, label]) => (
                <button
                  key={b}
                  className="tile-menu-item"
                  onClick={() => {
                    nav(b)
                    setMoreOpen(false)
                  }}
                >
                  <Icon name={b} />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
