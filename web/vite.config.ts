import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // في التطوير: مرّر طلبات الـ API إلى Worker المحلي (wrangler dev على 8787)
      '/api': 'http://localhost:8787',
    },
  },
});
