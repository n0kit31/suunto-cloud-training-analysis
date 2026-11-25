import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: true,
    license: { fileName: 'frontend-licenses.md' },
  },
})
