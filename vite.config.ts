import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
      '/api': backend,
      '/health': backend,
    },
  },
});
