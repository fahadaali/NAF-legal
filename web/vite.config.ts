import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /* `es2022` لأجل `await` في أعلى الوحدة — تستعمله حزمة MuPDF لتهيئة
       WebAssembly. وهو مدعومٌ منذ Chrome 89 و Safari 15 و Firefox 89، أي
       أقدمُ من كل متصفّحٍ يفتح هذه المنصة. */
    target: 'es2022',
  },
  /* MuPDF حزمةُ WebAssembly تُحمَّل عند أوّل PDF يُرفَق لا مع الصفحة، فتُترك
     خارج التحسين المسبق: تحسينُها يدمجها في حزمة البدء ويجعل كلَّ زائرٍ
     يحمّل عشرة ميغابايت لا يحتاجها. */
  optimizeDeps: { exclude: ['mupdf'] },
  server: {
    port: 5173,
    proxy: {
      // في التطوير: مرّر طلبات الـ API إلى Worker المحلي (wrangler dev على 8787)
      '/api': 'http://localhost:8787',
    },
  },
});
