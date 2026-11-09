import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    // keys/tokens.json fica fora do pacote
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
})
