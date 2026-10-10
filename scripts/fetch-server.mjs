// Downloads scrcpy-server into resources/ so the app works offline
// and the packaged .app bundles it (see build.extraResources in package.json).
// The version and SHA-256 come from src/shared/scrcpy-server.json. The script fails if the hash does not match.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const { version, sha256 } = JSON.parse(readFileSync(new URL('../src/shared/scrcpy-server.json', import.meta.url), 'utf8'))
const out = `resources/scrcpy-server-v${version}`
const hash = (buf) => createHash('sha256').update(buf).digest('hex')

// Remove other server versions and partial downloads, so that the packaged app gets only this version.
if (existsSync('resources')) {
  for (const f of readdirSync('resources')) {
    if (f.startsWith('scrcpy-server-') && `resources/${f}` !== out) {
      rmSync(`resources/${f}`)
      console.log(`✗ removed resources/${f}`)
    }
  }
}

if (existsSync(out)) {
  if (hash(readFileSync(out)) === sha256) {
    console.log(`✓ ${out} already exists`)
    process.exit(0)
  }
  console.log(`✗ ${out} has an incorrect SHA-256. Downloading it again.`)
  rmSync(out)
}

const url = `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`
console.log(`↓ ${url}`)
const res = await fetch(url)
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const buf = Buffer.from(await res.arrayBuffer())
const actual = hash(buf)
if (actual !== sha256) throw new Error(`SHA-256 mismatch for ${url}: expected ${sha256}, got ${actual}`)

mkdirSync('resources', { recursive: true })
writeFileSync(`${out}.tmp`, buf)
renameSync(`${out}.tmp`, out)
console.log(`✓ saved ${out}`)
