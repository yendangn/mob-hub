# Mob Hub

**Website:** https://mobhub.phindev.dev/

> This is an unofficial project. It is not affiliated with or endorsed by Genymobile or the scrcpy project.

An Electron wrapper for [scrcpy](https://github.com/Genymobile/scrcpy) on macOS:

- **Device list**: shows the connected devices (USB and Wi-Fi). The list updates every 1.5 seconds.
- **Click a device** to open a native scrcpy window. The app arranges the windows in a grid to the right of the app.
- **In-app grid**: click `+` next to a device to see and control a phone screen in the app window. You can show many devices at the same time.
- **Sync control**: when you use one device, all devices in the grid repeat the same action: tap, swipe, key input, or Home or Back.
- **Screenshot**: click the camera button on a grid tile to save a full-resolution PNG from the device, through `adb screencap`. The app saves the file to the Desktop, or to the folder set in Settings, and copies it to the clipboard. With Sync control on, the app takes a screenshot of every device in the grid. A protected screen, for example a banking app or DRM video, appears black.
- **Copy text**: press `Cmd+Shift+T` on a grid tile. Then drag a box over text or a QR code or barcode, or click to read the whole screen. The app reads the selected area with Apple Vision. For a QR code or barcode, it copies the decoded payload to the clipboard. For plain text, it copies the recognized text. The app does not yet support QR codes with a binary payload.

![Mob Hub grid view with two connected devices](docs/screenshot.png)

## Requirements

```bash
brew install scrcpy android-platform-tools   # scrcpy + adb
xcode-select --install                       # Xcode Command Line Tools, to build the Copy text OCR helper
```

Node.js 20.19 or later (or 22.12 or later).

## Run

```bash
npm install        # postinstall downloads scrcpy-server v5.0.1 and builds the Copy text OCR helper into resources/
npm run dev        # dev mode with hot reload
npm run dist:mac   # build .dmg files (arm64 and x64) into dist/
```

The `.dmg` is not signed or notarized. On first launch, macOS blocks it. To open it, right-click the app in Applications and select **Open**, or run `xattr -dr com.apple.quarantine "/Applications/Mob Hub.app"`.

When you open the app for the first time, if it cannot find adb or scrcpy, it opens Settings. Set the paths there.

## How it works

| | Mode A: scrcpy window | Mode B: in-app grid |
|---|---|---|
| Start | Click the device name | `+` button next to the device |
| Runs | The installed `scrcpy` binary (`-s <serial> --window-x/y/height`) | Only `scrcpy-server` v5.0.1, pushed to the device through adb |
| Video | scrcpy SDL window | H.264 → IPC → WebCodecs → `<canvas>` |
| Control | All scrcpy controls | Tap/swipe, scroll, key input, right-click = Back, nav buttons, screenshot |

Mode B uses the [Tango / ya-webadb](https://github.com/yume-chan/ya-webadb) libraries. Refer to [Libraries](#libraries).

## Libraries

### Runtime

| Library | License | Used for |
|---|---|---|
| [scrcpy-server](https://github.com/Genymobile/scrcpy) | Apache-2.0 | Server that runs on the device. It captures the screen and receives the control messages. |
| [`@yume-chan/adb`](https://github.com/yume-chan/ya-webadb) | MIT | adb protocol: connect to a device, push files, run commands. |
| [`@yume-chan/adb-server-node-tcp`](https://github.com/yume-chan/ya-webadb) | MIT | Connect to the local adb server through TCP. |
| [`@yume-chan/adb-scrcpy`](https://github.com/yume-chan/ya-webadb) | MIT | Push and start scrcpy-server through adb. |
| [`@yume-chan/scrcpy`](https://github.com/yume-chan/ya-webadb) | MIT | scrcpy protocol: server options, video packets, control messages (touch, key, scroll). |
| [`@yume-chan/scrcpy-decoder-webcodecs`](https://github.com/yume-chan/ya-webadb) | MIT | Decode H.264 with WebCodecs and draw the frames on a `<canvas>` (WebGL or bitmap). |
| [`@yume-chan/stream-extra`](https://github.com/yume-chan/ya-webadb) | MIT | Web stream types that the other `@yume-chan` packages use. |
| [React](https://react.dev) | MIT | Renderer UI. |

The `@yume-chan` packages are at `3.0.0-beta.3`. Only this beta version supports scrcpy-server versions later than 3.3.3.

### Development and build

| Library | License | Used for |
|---|---|---|
| [Electron](https://www.electronjs.org) | MIT | Desktop app shell. |
| [electron-vite](https://electron-vite.org) | MIT | Dev server and build for the main, preload, and renderer processes. |
| [Vite](https://vite.dev) + [`@vitejs/plugin-react`](https://github.com/vitejs/vite-plugin-react) | MIT | Renderer bundler with React hot reload. |
| [electron-builder](https://www.electron.build) | MIT | Package the app as a `.dmg` file. |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Type checking. |

### External tools (not bundled)

| Tool | Used for |
|---|---|
| [scrcpy](https://github.com/Genymobile/scrcpy) | Mode A: native scrcpy windows. |
| [adb](https://developer.android.com/tools/adb) (Android platform-tools) | Device list and the adb server. |
| [Apple Vision](https://developer.apple.com/documentation/vision) (macOS system framework) | Copy text: OCR and QR code or barcode decoding in `native/ocr/main.swift`. |

## Structure

```
src/main/      index.ts (window + IPC), adb.ts (device list), external.ts (mode A), grid.ts (mode B),
               screenshot.ts, ocr.ts (Copy text: screenshot → OCR helper → clipboard), settings.ts,
               tools.ts (find adb/scrcpy)
src/preload/   IPC bridge → window.api
src/renderer/  React UI: App.tsx, GridTile.tsx (decoder + input), gridBus.ts (video packet routing),
               SettingsDialog.tsx, icons.tsx
src/shared/    shared data types, scrcpy-server.json (server version + SHA-256)
native/        ocr/main.swift (Copy text helper: Apple Vision OCR + barcode decode, reads a PNG on stdin)
scripts/       fetch-server.mjs (download scrcpy-server), build-ocr.mjs (build the OCR helper),
               make-icon.py (app icon)
build/         app icon for electron-builder
third_party/   licenses of bundled third-party software
```

## Notes

- **The server version must match the library.** The server version and its SHA-256 are in `src/shared/scrcpy-server.json`. The app and `scripts/fetch-server.mjs` read the version and the hash from this file. They reject a file with a different hash. The server protocol must be one that `@yume-chan/scrcpy` supports: `ScrcpyOptionsLatest`, protocol 4.1 in `3.0.0-beta.3`. Server 5.0.1 uses the same protocol as 4.1. When you change the server version, update the two values in the JSON file.
- **macOS does not let an app embed the window of another process.** As a result, Mode A arranges the scrcpy windows next to the app.
- **A device can run in both modes at the same time.** This doubles the bandwidth use.
- **Text input in the grid:** the grid reads text from a hidden text field. As a result, macOS input methods work, for example Vietnamese Telex or VNI. The app sends ASCII text with `injectText`. scrcpy-server cannot type other characters as key events, for example Vietnamese diacritics or emoji. So the app sends these characters through the device clipboard and a paste action. When the pastes stop, the app restores the text that you last copied on the device. The app can restore this text only if you copied it while the device was in the grid. On Android 6 and earlier, the paste action does not exist. So the app cannot type these characters.
- **Keyboard shortcuts in the grid:** the app does not send Cmd to the device. If you press Meta alone, Android opens the Assistant. The app sends Cmd+A, Cmd+C, Cmd+X, Cmd+Z, and Cmd+Y to the device as Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+Z, and Ctrl+Y. Cmd+V pastes the Mac clipboard text into the device. Other Cmd shortcuts, for example Cmd+Q, Cmd+W, and Cmd+Tab, stay on the Mac.
- **Press and hold:** the app disables the macOS accent popup that appears when you hold a key. As a result, a held key repeats on the device.
- **Copy text** needs the Xcode Command Line Tools at install time, to build the OCR helper. The install step runs `npm run build-ocr`. If these tools are missing, it skips the step silently. Apple Vision exposes only the string payload of a QR code or barcode. So the app cannot read a code that encodes binary data.

## License

This project uses the [MIT License](LICENSE).

The packaged app contains `scrcpy-server` from [scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0). Refer to [third_party/README.md](third_party/README.md).
