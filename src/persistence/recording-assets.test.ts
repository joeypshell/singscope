// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'

import { SingScopeDatabase } from './db'
import { IndexedDbBinaryStore } from './indexeddb-binary-store'
import {
  PROJECT_MAX_BINARY_BYTES,
  RecordingAssetWriter,
  finalizeRecoveredRecording,
  recoverBinaryState,
} from './recording-assets'

const resources: { database: SingScopeDatabase; store: IndexedDbBinaryStore }[] = []

afterEach(() => {
  for (const { database, store } of resources.splice(0)) {
    database.close()
    store.close()
  }
})

function setup(): { database: SingScopeDatabase; store: IndexedDbBinaryStore } {
  const id = crypto.randomUUID()
  const database = new SingScopeDatabase(`singscope:test:recording-meta:${id}`)
  const store = new IndexedDbBinaryStore({ databaseName: `singscope:test:recording-bin:${id}` })
  resources.push({ database, store })
  return { database, store }
}

describe('recording asset journal', () => {
  it('commits an interrupted recording as a recoverable partial take', async () => {
    const { database, store } = setup()
    const assetId = '62ec47d5-b7f2-4399-800c-b5a29d99d45c'
    const writer = new RecordingAssetWriter(
      database,
      store,
      '86ccca85-1343-498d-91e4-b8e65aa94b3a',
      assetId,
      'audio/mp4',
    )
    await writer.appendOneSecondChunk(new Blob(['partial audio']))
    const result = await writer.finalizeInterrupted('app-backgrounded')

    expect(result.partial).toBe(true)
    expect(result.asset.status).toBe('committed')
    expect(result.asset.payload).toMatchObject({ interruptionReason: 'app-backgrounded' })
    expect(await store.read(assetId)).not.toBeNull()
    expect((await database.commitStates.get(assetId))?.state).toBe('committed')
  })

  it('preserves journaled temporary files and deletes unreferenced startup orphans', async () => {
    const { database, store } = setup()
    const projectId = '86ccca85-1343-498d-91e4-b8e65aa94b3a'
    const now = new Date().toISOString()
    await database.projects.put({
      id: projectId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      payload: {},
    })
    const writer = new RecordingAssetWriter(
      database,
      store,
      projectId,
      '62ec47d5-b7f2-4399-800c-b5a29d99d45c',
      'audio/mp4',
    )
    await writer.appendOneSecondChunk(new Blob(['recover me']))
    const orphan = await store.beginTemporary('tmp-orphan')
    await store.appendTemporary(orphan.id, new Blob(['delete me']))

    const result = await recoverBinaryState(database, store)
    expect(result.recoverable).toHaveLength(1)
    expect(result.recoverable[0]?.temporary.byteLength).toBe(10)
    expect(result.deletedOrphanTemporaryIds).toEqual(['tmp-orphan'])

    const recoverable = result.recoverable[0]
    expect(recoverable).toBeDefined()
    if (recoverable === undefined) return
    const asset = await finalizeRecoveredRecording(database, store, recoverable)
    expect(asset.status).toBe('committed')
    expect(asset.payload).toEqual({
      partial: true,
      interruptionReason: 'startup-recovery',
      temporaryId: null,
    })
    expect(await store.read(asset.logicalAssetId)).not.toBeNull()
    expect((await database.commitStates.get(asset.logicalAssetId))?.state).toBe('committed')
  })

  it('deletes temporary recordings whose project no longer exists', async () => {
    const { database, store } = setup()
    const assetId = '62ec47d5-b7f2-4399-800c-b5a29d99d45c'
    const writer = new RecordingAssetWriter(
      database,
      store,
      '86ccca85-1343-498d-91e4-b8e65aa94b3a',
      assetId,
      'audio/mp4',
    )
    await writer.appendOneSecondChunk(new Blob(['orphaned take']))

    const result = await recoverBinaryState(database, store)
    expect(result.recoverable).toEqual([])
    expect(result.deletedOrphanTemporaryIds).toHaveLength(1)
    expect(await database.assets.get(assetId)).toBeUndefined()
    expect(await database.commitStates.get(assetId)).toBeUndefined()
    expect(await database.journals.get(assetId)).toBeUndefined()
  })

  it('refuses a new take after the project binary budget is exhausted', async () => {
    const { database, store } = setup()
    const projectId = '86ccca85-1343-498d-91e4-b8e65aa94b3a'
    const now = new Date().toISOString()
    await database.assets.put({
      id: '35ac5fc4-717d-4480-a222-d6ace3d54531',
      projectId,
      logicalAssetId: '35ac5fc4-717d-4480-a222-d6ace3d54531',
      backend: 'indexeddb',
      status: 'committed',
      mimeType: 'audio/mp4',
      byteLength: PROJECT_MAX_BINARY_BYTES,
      sha256: '0'.repeat(64),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      payload: {},
    })
    const writer = new RecordingAssetWriter(
      database,
      store,
      projectId,
      '62ec47d5-b7f2-4399-800c-b5a29d99d45c',
      'audio/mp4',
    )

    await expect(writer.begin()).rejects.toMatchObject({ code: 'quota-exceeded' })
    expect(await store.listTemporary()).toEqual([])
  })
})
