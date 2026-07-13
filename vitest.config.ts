import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'src/domain/**/*.ts',
        'src/audio/dsp/**/*.ts',
        'src/persistence/**/*.ts',
        'src/export/**/*.ts',
      ],
      // These adapters require real OPFS, StorageManager, Worker, share, and download
      // behavior. WebKit/device flows cover them; unit coverage measures their pure cores.
      exclude: [
        'src/persistence/opfs-binary-store.ts',
        'src/persistence/storage-health.ts',
        'src/export/preparer.ts',
        'src/export/share.ts',
      ],
      thresholds: { statements: 75, branches: 70, functions: 75, lines: 75 },
    },
  },
})
