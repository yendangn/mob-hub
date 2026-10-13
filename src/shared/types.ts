export type DeviceState = 'device' | 'unauthorized' | 'offline'

export interface DeviceInfo {
  serial: string
  state: DeviceState
  model?: string
  product?: string
  /** true if connected over Wi-Fi (serial looks like ip:port or mDNS) */
  wireless: boolean
}

export interface Settings {
  /** Absolute path to adb. Empty = auto-detect. */
  adbPath: string
  /** Absolute path to scrcpy. Empty = auto-detect. */
  scrcpyPath: string
  /** Window height (px) for external scrcpy windows. */
  windowHeight: number
  /** Max video dimension, 0 = native. Applies to both modes. */
  maxSize: number
  /** Video bitrate in Mbps (decimals allowed). */
  bitrateMbps: number
  maxFps: number
  /** Extra CLI args for external scrcpy windows, e.g. "--turn-screen-off --stay-awake". */
  extraArgs: string
  /** Folder for screenshots. Empty = Desktop. */
  screenshotDir: string
  /** Copy text that the user copies on a device in the grid to the Mac clipboard. */
  syncClipboardToMac: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  adbPath: '',
  scrcpyPath: '',
  windowHeight: 760,
  maxSize: 1024,
  bitrateMbps: 4,
  maxFps: 30,
  extraArgs: '',
  screenshotDir: '',
  syncClipboardToMac: true
}

export interface ToolStatus {
  adb?: string
  scrcpy?: string
  adbError?: string
}

/** Video packet forwarded from main → renderer for in-app grid. */
export type VideoPacket =
  | { type: 'configuration'; data: Uint8Array }
  | { type: 'data'; keyframe?: boolean; pts?: string; data: Uint8Array }
  | { type: 'session'; isClientResize: boolean; width: number; height: number }

export interface GridSessionInfo {
  serial: string
  /** Identifies one server run, so that a late 'ended' event from an earlier run is ignored. */
  sessionId: number
  codec: number
  width: number
  height: number
  deviceName?: string
}

export interface TouchInput {
  /** AndroidMotionEventAction: 0 down, 1 up, 2 move */
  action: number
  /** normalized 0..1 */
  x: number
  y: number
  pressure: number
}

export interface ScrollInput {
  x: number
  y: number
  scrollX: number
  scrollY: number
}

export type NavButton = 'back' | 'home' | 'recents' | 'volUp' | 'volDown' | 'rotate'

export interface KeyInput {
  /** KeyboardEvent.code */
  code: string
  /** printable text to inject instead of keycode (when set) */
  text?: string
  down: boolean
  meta: number
}

/** Part of the screen, as fractions (0...1) of the screen size, origin at top left. */
export interface OcrRegion {
  x: number
  y: number
  w: number
  h: number
}

export interface OcrResult {
  /** 'code' = the content of QR codes or barcodes in the region, 'text' = the text on the screen. */
  kind: 'text' | 'code'
  /** Type of the first code, for example "QR" or "EAN13". Only for kind 'code'. */
  codeType?: string
  text: string
  /** Number of text lines, or number of codes. */
  lines: number
}

export interface Api {
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<ToolStatus>
  toolStatus(): Promise<ToolStatus>
  onDevices(cb: (devices: DeviceInfo[]) => void): () => void
  refreshDevices(): Promise<void>

  /** Mode A: open a native scrcpy window, tiled. */
  openWindow(serial: string, title: string): Promise<void>
  closeWindow(serial: string): Promise<void>
  onWindowsChanged(cb: (serials: string[]) => void): () => void

  /** Mode B: in-app grid streaming. */
  gridStart(serial: string): Promise<GridSessionInfo>
  gridStop(serial: string): Promise<void>
  onGridPacket(cb: (serial: string, sessionId: number, p: VideoPacket) => void): () => void
  onGridEnded(cb: (serial: string, sessionId: number, reason?: string) => void): () => void
  touch(serials: string[], t: TouchInput): void
  scroll(serials: string[], s: ScrollInput): void
  key(serials: string[], k: KeyInput): void
  nav(serials: string[], b: NavButton): void
  resetVideo(serial: string): void

  /** Full-resolution PNG from the device, saved to the screenshot folder and, if asked, copied to the clipboard. */
  screenshot(serial: string, label: string, copyToClipboard: boolean): Promise<{ path: string }>
  /** Show a screenshot that this app saved in Finder. */
  revealFile(path: string): Promise<void>
  /** Read the text on the screen (or the QR codes and barcodes in a region of it) and copy it to the Mac clipboard. */
  copyScreenText(serial: string, region?: OcrRegion): Promise<OcrResult>

  onError(cb: (msg: string) => void): () => void
}
