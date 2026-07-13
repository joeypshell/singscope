import { IndexedDbBinaryStore } from './indexeddb-binary-store'
import { OpfsBinaryStore } from './opfs-binary-store'
import type { BinaryStore } from './binary-store'
import type { StorageProbeResult } from './types'

interface OptionalStorageManager {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
  estimate?: () => Promise<StorageEstimate>
}

function optionalStorage(): OptionalStorageManager {
  if (typeof navigator === 'undefined') return {}
  const storage: unknown = Reflect.get(navigator, 'storage')
  return isOptionalStorageManager(storage) ? storage : {}
}

function isOptionalStorageManager(value: unknown): value is OptionalStorageManager {
  return typeof value === 'object' && value !== null
}

export async function probeStorage(): Promise<StorageProbeResult> {
  const errors: string[] = []
  let indexedDb = false
  let opfs = false
  let persistent = false
  let usage: number | null = null
  let quota: number | null = null

  const databaseName = `singscope:probe:${crypto.randomUUID()}`
  const fallback = new IndexedDbBinaryStore({ databaseName, maxBytes: 1024 })
  try {
    const temporary = await fallback.beginTemporary()
    await fallback.appendTemporary(temporary.id, new Blob(['ok']))
    await fallback.abortTemporary(temporary.id)
    indexedDb = true
  } catch (error) {
    errors.push(`IndexedDB: ${error instanceof Error ? error.message : 'unknown failure'}`)
  } finally {
    fallback.close()
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(databaseName)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
  }

  if (optionalStorage().getDirectory !== undefined) {
    const primary = new OpfsBinaryStore()
    try {
      const temporary = await primary.beginTemporary(`probe-${crypto.randomUUID()}`)
      await primary.appendTemporary(temporary.id, new Blob(['ok']))
      await primary.abortTemporary(temporary.id)
      opfs = true
    } catch (error) {
      errors.push(`OPFS: ${error instanceof Error ? error.message : 'unknown failure'}`)
    }
  }

  try {
    persistent = (await optionalStorage().persisted?.()) ?? false
    const estimate = await optionalStorage().estimate?.()
    usage = estimate?.usage ?? null
    quota = estimate?.quota ?? null
  } catch (error) {
    errors.push(`Estimate: ${error instanceof Error ? error.message : 'unknown failure'}`)
  }

  return { indexedDb, opfs, persistent, usage, quota, errors }
}

export async function requestPersistentStorageAfterExplicitSave(): Promise<boolean> {
  return (await optionalStorage().persist?.()) ?? false
}

export async function createBestBinaryStore(): Promise<BinaryStore> {
  if (optionalStorage().getDirectory !== undefined) {
    const opfs = new OpfsBinaryStore()
    try {
      const probe = await opfs.beginTemporary(`probe-${crypto.randomUUID()}`)
      await opfs.abortTemporary(probe.id)
      return opfs
    } catch {
      // IndexedDB is the bounded compatibility fallback.
    }
  }
  return new IndexedDbBinaryStore()
}
