import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

Object.defineProperty(globalThis, 'crypto', {
  value: globalThis.crypto,
  configurable: true,
})
