import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,   // expose on LAN (0.0.0.0)
    port: 5173,
  }
})
