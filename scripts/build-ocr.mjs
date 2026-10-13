// Builds the OCR helper (native/ocr/main.swift) into resources/mobhub-ocr as a universal binary,
// so the packaged .app bundles it (see build.extraResources in package.json).
// Needs the Xcode Command Line Tools (xcode-select --install). Only for macOS.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const src = 'native/ocr/main.swift'
const out = 'resources/mobhub-ocr'

if (process.platform !== 'darwin') {
  console.log('(skip) the OCR helper is only for macOS')
  process.exit(0)
}
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
  console.log(`✓ ${out} is up to date`)
  process.exit(0)
}

mkdirSync('resources', { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'mobhub-ocr-'))
try {
  const parts = ['arm64', 'x86_64'].map((arch) => {
    const file = join(tmp, arch)
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos12`, '-o', file, src], { stdio: 'inherit' })
    return file
  })
  execFileSync('lipo', ['-create', '-output', out, ...parts], { stdio: 'inherit' })
  console.log(`✓ built ${out}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
