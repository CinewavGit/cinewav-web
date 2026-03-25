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
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
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
      workbox: {
        // Cache the app shell
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // Don't cache audio files — they are stored in IndexedDB
        navigateFallback: 'index.html',
      },
    }),
  ],
});
