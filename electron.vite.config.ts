import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// All packages are in devDependencies, so electron-vite bundles every import into out/.
// The packaged app needs no node_modules (the @yume-chan packages are ESM-only and must be bundled).
const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: { resolve: { alias }, plugins: [react()] }
})
