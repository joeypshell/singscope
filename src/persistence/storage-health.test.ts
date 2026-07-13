import { afterEach, describe, expect, it } from 'vitest'

import { createBestBinaryStore, probeStorage } from './storage-health'

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')

afterEach(() => {
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage)
  else Reflect.deleteProperty(navigator, 'storage')
})

describe('storage capability fallback', () => {
  it('keeps IndexedDB available when WebKit omits navigator.storage', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: undefined,
    })

    const result = await probeStorage()
    expect(result.indexedDb).toBe(true)
    expect(result.opfs).toBe(false)
    expect(result.persistent).toBe(false)

    const store = await createBestBinaryStore()
    expect(store.kind).toBe('indexeddb')
    const closeable = store as { close?: () => void }
    closeable.close?.()
  })
})
