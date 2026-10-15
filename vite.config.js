import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

const TILE_HOSTS = /^https:\/\/([abc]\.tile\.opentopomap\.org|tile\.openstreetmap\.org|server\.arcgisonline\.com)\//;

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // `npm run dev:phone` serves over HTTPS on your LAN so an iPhone can open it.
    mode === 'phone' && basicSsl(),
    VitePWA({
      // 'prompt': a new version waits until the app is next opened instead of reloading the
      // page immediately — an auto-reload could wipe out a video while it's being recorded.
      registerType: 'prompt',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Trail Reel',
        short_name: 'Trail Reel',
        description: 'Turn a GPX track, photos and videos into a finished hiking video.',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0d1513',
        theme_color: '#0d1513',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // heic2any chunk
        runtimeCaching: [
          {
            // Re-rendering the same hike (or working offline afterwards) reuses tiles.
            urlPattern: TILE_HOSTS,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 3000, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),
  base: './',
  server: {
    port: 5173,
    open: mode !== 'phone',
    // On the phone, live reload would refresh the page whenever the connection to this PC
    // blips (common during a long recording). Reload manually after code changes instead.
    hmr: mode === 'phone' ? false : undefined,
  },
  build: { chunkSizeWarningLimit: 1500 }, // heic2any is lazy-loaded only when a HEIC needs decoding
}));
