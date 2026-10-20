import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    port: 5373,
    proxy: { '/api': 'http://localhost:3300', '/auth': 'http://localhost:3300', '/healthz': 'http://localhost:3300' },
  },
});
