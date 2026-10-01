import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    exclude: ['node_modules/**', 'dist/**', 'dist-electron/**', 'release/**'],
  },
})
