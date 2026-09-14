import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      zod: path.resolve(__dirname, 'node_modules/zod'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
    // TEMPORARY dev-only: allow ngrok tunnel hosts for phone testing.
    // Revert before any prod-adjacent work (never affects `vite build`).
    allowedHosts: ['.ngrok-free.dev', '.ngrok.io'],
  },
})
