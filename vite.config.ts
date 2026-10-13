/**
 * Renderer build (Vite). Root is `src/renderer`; the output is loaded by main from
 * `app://yami/index.html`. No CSP meta tag is injected here: in packaged builds
 * main's `app://` protocol handler sends the strict CSP as a response header, and
 * in development main adds a (dev-server-compatible) CSP header to the Vite
 * responses itself.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(rootDir, 'src/renderer'),
  base: './',
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src/renderer')
    }
  },
  css: {
    postcss: path.resolve(rootDir, 'postcss.config.mjs')
  },
  build: {
    outDir: path.resolve(rootDir, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/framer-motion')) return 'motion';
          if (id.includes('node_modules/lucide-react')) return 'icons';
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react-vendor';
          if (id.includes('node_modules/zustand')) return 'state';
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 }
  }
});
