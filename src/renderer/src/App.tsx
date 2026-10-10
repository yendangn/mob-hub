import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, GridSessionInfo, Settings, ToolStatus } from '@shared/types'
import { GridTile } from './GridTile'
import { Icon } from './icons'
import { discard, prepare } from './gridBus'
import { SettingsDialog } from './SettingsDialog'

const api = window.api
const label = (d: DeviceInfo) => d.model || d.serial

type GridEntry = { status: 'starting' } | { status: 'live'; info: GridSessionInfo }
type Toast = { id: number; msg: string; kind: 'error' | 'info'; action?: { label: string; run(): void } }

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [windows, setWindows] = useState<string[]>([])
  const [grid, setGrid] = useState<Record<string, GridEntry>>({})
  const [sync, setSync] = useState(false)
  const [tileH, setTileH] = useState(560)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [settings, setSettings] = useState<Settings>()
  const [tools, setTools] = useState<ToolStatus>()
  const [showSettings, setShowSettings] = useState(false)

  const gridRef = useRef(grid)
  /**
   * Change the grid and gridRef at once. IPC events (grid:ended) read gridRef, and they can
   * arrive before React renders the change, so the ref must not wait for the render.
   */
  const updateGrid = useCallback((fn: (g: Record<string, GridEntry>) => Record<string, GridEntry>) => {
    gridRef.current = fn(gridRef.current)
    setGrid(gridRef.current)
  }, [])
  const syncRef = useRef(sync)
  syncRef.current = sync
  /** Latest start attempt per serial. A remove or a new add makes an older attempt stale. */
  const startToken = useRef(new Map<string, number>())

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const pushToast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random()
      setToasts((x) => [...x, { ...t, id }])
      setTimeout(() => dismiss(id), 9000)
    },
    [dismiss]
  )
  const pushError = useCallback((msg: string) => pushToast({ msg, kind: 'error' }), [pushToast])

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.toolStatus().then((t) => {
      setTools(t)
      if (!t.adb || !t.scrcpy || t.adbError) setShowSettings(true)
    })
    const offs = [
      api.onDevices(setDevices),
      api.onWindowsChanged(setWindows),
      api.onError(pushError),
      api.onGridEnded((serial, sessionId, reason) => {
        // Ignore a late event from an earlier run of this device (the tile may already show a new run).
        const entry = gridRef.current[serial]
        if (entry?.status !== 'live' || entry.info.sessionId !== sessionId) return
        discard(serial)
        updateGrid(({ [serial]: _, ...rest }) => rest)
        if (reason) pushError(`${serial}: ${reason}`)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [pushError, updateGrid])

  // Drop grid tiles whose device disappeared
  useEffect(() => {
    const online = new Set(devices.filter((d) => d.state === 'device').map((d) => d.serial))
    for (const serial of Object.keys(gridRef.current)) {
      if (!online.has(serial)) void removeFromGrid(serial)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices])

  const toggleWindow = async (d: DeviceInfo) => {
    if (d.state !== 'device') return
    try {
      if (windows.includes(d.serial)) await api.closeWindow(d.serial)
      else await api.openWindow(d.serial, label(d))
    } catch (e) {
      pushError(cleanErr(e))
    }
  }

  const addToGrid = async (serial: string) => {
    if (gridRef.current[serial]) return
    const token = Math.random()
    startToken.current.set(serial, token)
    const current = () => startToken.current.get(serial) === token
    prepare(serial)
    updateGrid((g) => ({ ...g, [serial]: { status: 'starting' } }))
    try {
      const info = await api.gridStart(serial)
      if (current()) updateGrid((g) => (g[serial] ? { ...g, [serial]: { status: 'live', info } } : g))
    } catch (e) {
      if (!current()) return // removed while starting: nothing to report
      startToken.current.delete(serial)
      discard(serial)
      updateGrid(({ [serial]: _, ...rest }) => rest)
      pushError(`${serial}: ${cleanErr(e)}`)
    }
  }

  const removeFromGrid = async (serial: string) => {
    startToken.current.delete(serial)
    updateGrid(({ [serial]: _, ...rest }) => rest)
    discard(serial)
    await api.gridStop(serial)
  }

  const online = devices.filter((d) => d.state === 'device')
  const gridSerials = Object.keys(grid)
  const liveSerials = () =>
    Object.entries(gridRef.current)
      .filter(([, v]) => v.status === 'live')
      .map(([k]) => k)

  /** Screenshots of these devices, all at the same time. The image goes to the clipboard only for one device. */
  const takeScreenshots = async (serials: string[]) => {
    const nameOf = (serial: string) => {
      const d = devices.find((x) => x.serial === serial)
      return d ? label(d) : serial
    }
    const copy = serials.length === 1
    const results = await Promise.allSettled(serials.map((s) => api.screenshot(s, nameOf(s), copy)))
    const paths: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') paths.push(r.value.path)
      else pushError(`${nameOf(serials[i])}: ${cleanErr(r.reason)}`)
    })
    if (!paths.length) return
    const last = paths[paths.length - 1]
    const file = last.split('/').pop()
    pushToast({
      kind: 'info',
      msg: paths.length === 1 ? `Saved ${file}${copy ? ' and copied it to the clipboard' : ''}` : `Saved ${paths.length} screenshots`,
      action: { label: 'Show in Finder', run: () => void api.revealFile(last).catch((e) => pushError(cleanErr(e))) }
    })
  }

  const saveSettings = async (s: Settings) => {
    const t = await api.saveSettings(s)
    setSettings(await api.getSettings()) // main corrects out-of-range values
    setTools(t)
    if (t.adb && t.scrcpy && !t.adbError) setShowSettings(false)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="side-head">
          <h1>Devices</h1>
          <span className="count">{online.length}</span>
          <button className="square-btn" title="Refresh" aria-label="Refresh" onClick={() => api.refreshDevices()}>
            <Icon name="refresh" />
          </button>
        </div>

        <ul className="device-list">
          {devices.length === 0 && (
            <li className="empty">
              No devices found.
              <br />
              Connect a USB cable and turn on <b>USB debugging</b>.
            </li>
          )}
          {devices.map((d) => {
            const open = windows.includes(d.serial)
            const inGrid = !!grid[d.serial]
            return (
              <li
                key={d.serial}
                className={`dev ${d.state}${open ? ' open' : ''}`}
                onClick={() => toggleWindow(d)}
                title={d.state === 'device' ? (open ? 'Click to close the scrcpy window' : 'Click to open scrcpy') : undefined}
              >
                <span className={`dot ${d.state}`} />
                <div className="device-text">
                  <div className="device-name">{label(d)}</div>
                  <div className="device-sub">
                    {d.wireless ? 'Wi-Fi · ' : 'USB · '}
                    {d.serial}
                  </div>
                  {d.state === 'unauthorized' && <div className="device-warn">Accept "Allow USB debugging" on the device</div>}
                  {d.state === 'offline' && <div className="device-warn">Offline — unplug the cable and plug it in again</div>}
                </div>
                {d.state === 'device' && (
                  <button
                    className={`chip icon${inGrid ? ' on' : ''}`}
                    title={inGrid ? 'Remove from grid' : 'Add to the in-app grid'}
                    aria-label={inGrid ? 'Remove from grid' : 'Add to grid'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void (inGrid ? removeFromGrid(d.serial) : addToGrid(d.serial))
                    }}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path d={inGrid ? 'M3 8h10' : 'M3 8h10M8 3v10'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </li>
            )
          })}
        </ul>

        <div className="side-actions">
          <button className="link with-icon" onClick={() => setShowSettings(true)}>
            <Icon name="settings" />
            Settings
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="toolbar">
          <div className="drag-region" />
          <h2>Grid</h2>
          <button disabled={!online.length} onClick={() => online.forEach((d) => addToGrid(d.serial))}>
            + All
          </button>
          <button disabled={!gridSerials.length} onClick={() => gridSerials.forEach(removeFromGrid)}>
            Clear all
          </button>
          <label className={`toggle${sync ? ' on' : ''}`} title="Input on one device is sent to all devices in the grid">
            <input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} />
            Sync control
          </label>
          <span className="spacer" />
          <label className="slider">
            Size
            <input type="range" min={320} max={900} step={20} value={tileH} onChange={(e) => setTileH(+e.target.value)} />
          </label>
        </header>

        {gridSerials.length === 0 ? (
          <div className="grid-empty">
            <p>Click <b>+</b> next to a device to see its screen in the app.</p>
            <p className="muted">Click a device name to open it in a separate scrcpy window.</p>
          </div>
        ) : (
          <div className="grid" style={{ ['--tile-h' as string]: `${tileH}px` }}>
            {gridSerials.map((serial) => {
              const entry = grid[serial]
              const d = devices.find((x) => x.serial === serial)
              const title = d ? label(d) : serial
              if (entry.status === 'starting')
                return (
                  <div key={serial} className="tile loading">
                    <div className="tile-head"><span className="tile-title">{title}</span></div>
                    <div className="tile-screen"><div className="spinner" />Starting scrcpy-server…</div>
                  </div>
                )
              return (
                <GridTile
                  key={serial}
                  info={entry.info}
                  title={title}
                  synced={sync}
                  targets={() => (syncRef.current ? liveSerials() : [serial])}
                  onClose={() => removeFromGrid(serial)}
                  onScreenshot={takeScreenshots}
                />
              )
            })}
          </div>
        )}
      </main>

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          tools={tools}
          onSave={saveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
            <span className="toast-msg">{t.msg}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation()
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function cleanErr(e: unknown) {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
