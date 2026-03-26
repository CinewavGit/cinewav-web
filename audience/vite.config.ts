import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  plugins: [
    VitePWA({
      // Use our custom service worker instead of Workbox auto-generation.
      // 'injectManifest' tells Vite PWA to compile our custom SW file and
      // inject the precache manifest into it.
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sync-worker.js',
      registerType: 'autoUpdate',
      injectManifest: {
        // Don't inject a precache manifest — our SW handles fetch pass-through
        injectionPoint: undefined,
      },
      manifest: {
        name: 'Cinewav — Audience',
        short_name: 'Cinewav',
        description: 'Synchronized cinema audio experience',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});
