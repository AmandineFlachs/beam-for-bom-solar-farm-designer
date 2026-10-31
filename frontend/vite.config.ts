import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import cesiumPkg from 'vite-plugin-cesium'
const cesium = (cesiumPkg as any).default ?? cesiumPkg
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), cesium()],
  server: {
    proxy: { '/api': 'http://localhost:8000', '/exports': 'http://localhost:8000' },
  },
})
