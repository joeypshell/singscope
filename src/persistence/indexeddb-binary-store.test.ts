// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'

import { IndexedDbBinaryStore } from './indexeddb-binary-store'

const openStores: IndexedDbBinaryStore[] = []

function createStore(maxBytes = 1024): IndexedDbBinaryStore {
  const store = new IndexedDbBinaryStore({
    databaseName: `singscope:test:binary:${crypto.randomUUID()}`,
    maxBytes,
    chunkBytes: 3,
  })
  openStores.push(store)
  return store
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close()
})

describe('IndexedDbBinaryStore', () => {
  it('appends chunks, commits an immutable logical asset, and hashes it', async () => {
    const store = createStore()
    const temporary = await store.beginTemporary('tmp-take')
    await store.appendTemporary(temporary.id, new Blob(['hello']))
    const appended = await store.appendTemporary(temporary.id, new Blob([' world']))

    expect(appended.byteLength).toBe(11)
    const committed = await store.commitTemporary(temporary.id, {
      id: 'take-audio',
      mimeType: 'audio/mp4',
    })
    expect(await (await store.read('take-audio'))?.text()).toBe('hello world')
    expect(committed.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    )
    expect(await store.listTemporary()).toEqual([])
    expect(await store.listCommitted()).toEqual([committed])
  })

  it('rejects appends beyond the configured bounded fallback size', async () => {
    const store = createStore(4)
    const temporary = await store.beginTemporary('tmp-limit')

    await expect(store.appendTemporary(temporary.id, new Blob(['12345']))).rejects.toMatchObject({
      code: 'quota-exceeded',
    })
    expect((await store.listTemporary())[0]?.byteLength).toBe(0)
  })

  it('deletes temporary and committed data without leaking chunks', async () => {
    const store = createStore()
    const temporary = await store.beginTemporary('tmp-delete')
    await store.appendTemporary(temporary.id, new Blob(['value']))
    await store.abortTemporary(temporary.id)
    expect(await store.listTemporary()).toEqual([])

    const other = await store.beginTemporary('tmp-commit-delete')
    await store.appendTemporary(other.id, new Blob(['value']))
    await store.commitTemporary(other.id, { id: 'asset-delete', mimeType: 'audio/mp4' })
    await store.delete('asset-delete')
    expect(await store.read('asset-delete')).toBeNull()
  })
})
