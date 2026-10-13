import { app, clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OcrRegion, OcrResult } from '@shared/types'
import { captureScreen } from './screenshot'

const HELPER = 'mobhub-ocr'
const TIMEOUT_MS = 20_000
/** Text that ends above this part of the short screen side is in the status bar (clock, battery). */
const STATUS_BAR = 0.1

interface Box {
  text: string
  x: number
  y: number
  w: number
  h: number
}

interface Code {
  type: string
  payload: string
  y: number
  x: number
}

function helperPath(): string {
  const paths = [
    join(process.resourcesPath ?? '', HELPER), // packaged app (extraResources)
    join(app.getAppPath(), 'resources', HELPER) // dev
  ]
  const found = paths.find((p) => existsSync(p))
  if (!found) throw new Error('The OCR helper is missing. Run "npm run build-ocr" (needs the Xcode Command Line Tools).')
  return found
}

function recognize(png: Uint8Array, region?: OcrRegion): Promise<{ width: number; height: number; lines: Box[]; codes?: Code[] }> {
  const args = region ? ['--region', [region.x, region.y, region.w, region.h].join(',')] : []
  return new Promise((resolve, reject) => {
    const child = execFile(helperPath(), args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Text recognition failed: ${stderr.trim() || err.message}`))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error('Text recognition failed: bad output from the OCR helper'))
      }
    })
    child.stdin?.end(png)
  })
}

/** Put boxes on the same row when their vertical centers overlap, then read rows top to bottom, left to right. */
function toText(boxes: Box[]): string {
  const rows: Box[][] = []
  for (const b of [...boxes].sort((a, c) => a.y - c.y)) {
    const row = rows[rows.length - 1]
    const center = b.y + b.h / 2
    if (row && center >= row[0].y && center <= row[0].y + row[0].h) row.push(b)
    else rows.push([b])
  }
  return rows.map((r) => r.sort((a, c) => a.x - c.x).map((b) => b.text).join(' ')).join('\n')
}

/**
 * Read the text on the device screen (all of it, or only a region) with Apple Vision
 * and copy it to the Mac clipboard. Without a region, the status bar text is dropped.
 * When the region has QR codes or barcodes, copy their content instead of the text,
 * one code per line, top to bottom.
 */
export async function copyScreenText(serial: string, region?: OcrRegion): Promise<OcrResult> {
  const png = await captureScreen(serial)
  const { width, height, lines, codes = [] } = await recognize(png, region)

  if (region && codes.length) {
    const sorted = [...codes].sort((a, c) => a.y - c.y || a.x - c.x)
    const text = sorted.map((c) => c.payload).join('\n')
    clipboard.writeText(text)
    return { kind: 'code', codeType: sorted[0].type, text, lines: sorted.length }
  }

  const statusBar = (STATUS_BAR * Math.min(width, height)) / height
  const boxes = region ? lines : lines.filter((b) => b.y + b.h > statusBar)
  const text = toText(boxes)
  if (!text) throw new Error('No text found')
  clipboard.writeText(text)
  return { kind: 'text', text, lines: text.split('\n').length }
}
