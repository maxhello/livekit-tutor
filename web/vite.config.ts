import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages 托管在仓库子路径下
export default defineConfig({
  base: '/livekit-tutor/',
  plugins: [react(), tailwindcss()],
})
