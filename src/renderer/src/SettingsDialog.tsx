import { useEffect, useState } from 'react'
import server from '@shared/scrcpy-server.json'
import type { Settings, ToolStatus } from '@shared/types'

interface Props {
  settings: Settings
  tools?: ToolStatus
  onSave(s: Settings): Promise<void>
  onClose(): void
}

export function SettingsDialog({ settings, tools, onSave, onClose }: Props) {
  const [s, setS] = useState(settings)
  // show the values that main saved (it clamps numbers that are out of range)
  useEffect(() => setS(settings), [settings])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }))

  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      await onSave({ ...s, adbPath: s.adbPath.trim(), scrcpyPath: s.scrcpyPath.trim(), screenshotDir: s.screenshotDir.trim() })
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <section className="status">
          <Status label="adb" path={tools?.adb} error={tools?.adbError} hint="brew install android-platform-tools" />
          <Status label="scrcpy" path={tools?.scrcpy} hint="brew install scrcpy" />
        </section>

        <label>
          adb path <small>(empty = auto-detect)</small>
          <input value={s.adbPath} placeholder={tools?.adb ?? '/opt/homebrew/bin/adb'} onChange={(e) => set('adbPath', e.target.value)} />
        </label>
        <label>
          scrcpy path <small>(empty = auto-detect)</small>
          <input value={s.scrcpyPath} placeholder={tools?.scrcpy ?? '/opt/homebrew/bin/scrcpy'} onChange={(e) => set('scrcpyPath', e.target.value)} />
        </label>

        <div className="row">
          <label>
            Max size (px, 0 = original)
            <input type="number" min={0} step={64} value={s.maxSize} onChange={(e) => set('maxSize', +e.target.value)} />
          </label>
          <label>
            Bitrate (Mbps)
            <input type="number" min={0.1} max={200} step={0.5} value={s.bitrateMbps} onChange={(e) => set('bitrateMbps', +e.target.value)} />
          </label>
          <label>
            Max FPS (0 = no limit)
            <input type="number" min={0} max={240} value={s.maxFps} onChange={(e) => set('maxFps', +e.target.value)} />
          </label>
        </div>

        <div className="row">
          <label>
            scrcpy window height (px)
            <input type="number" min={200} max={4000} step={20} value={s.windowHeight} onChange={(e) => set('windowHeight', +e.target.value)} />
          </label>
        </div>
        <label>
          Extra arguments for the scrcpy window
          <input value={s.extraArgs} placeholder="--turn-screen-off --stay-awake --always-on-top" onChange={(e) => set('extraArgs', e.target.value)} />
        </label>

        <label>
          Screenshot folder <small>(empty = Desktop)</small>
          <input value={s.screenshotDir} placeholder="~/Desktop" onChange={(e) => set('screenshotDir', e.target.value)} />
        </label>

        <p className="muted small">Grid view uses the built-in scrcpy-server v{server.version} (downloaded on first use). It does not depend on the installed scrcpy.</p>
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button className="link" onClick={onClose}>Close</button>
          <button className="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

function Status({ label, path, error, hint }: { label: string; path?: string; error?: string; hint: string }) {
  const ok = !!path && !error
  return (
    <div className={`status-row ${ok ? 'ok' : 'bad'}`}>
      <span className="dot" />
      <b>{label}</b>
      <span className="status-text">
        {ok ? path : error ?? <>Not found — run <code>{hint}</code></>}
      </span>
    </div>
  )
}
