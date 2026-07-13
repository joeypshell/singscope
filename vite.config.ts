import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
].join('; ')

function productionCsp(): Plugin {
  return {
    name: 'singscope-production-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
  }
}

export default defineConfig(({ mode }) => {
  const base = mode === 'pages' ? '/singscope/' : '/'
  return {
    base,
    plugins: [
      productionCsp(),
      react(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        // Manifest icons are added by vite-plugin-pwa; these two are referenced
        // directly by the HTML shell and therefore need explicit precache entries.
        includeAssets: ['mask-icon.svg', 'apple-touch-icon.png'],
        manifest: {
          id: base,
          name: 'SingScope',
          short_name: 'SingScope',
          description: 'Private, local-first singing practice and pitch review.',
          start_url: `${base}#/`,
          scope: base,
          display: 'standalone',
          orientation: 'any',
          background_color: '#08111f',
          theme_color: '#0c1628',
          categories: ['music', 'education', 'utilities'],
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        },
        workbox: {
          cacheId: 'singscope-app-shell-v1',
          globPatterns: ['**/*.{js,css,html,wav,woff2}'],
          maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          navigateFallback: 'index.html',
          runtimeCaching: [],
        },
      }),
    ],
    build: { target: 'es2023', sourcemap: false },
    worker: { format: 'es' },
  }
})
