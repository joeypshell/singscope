import Dexie, { type EntityTable, type Table } from 'dexie'

import type { BinaryStore } from './binary-store'
import { createTemporaryId } from './binary-store'
import { SingScopeStorageError, mapStorageError } from './errors'
import { sha256Blob } from './hash'
import type { BinaryCommitInput, BinaryMetadata, TemporaryBinary } from './types'

const BINARY_DATABASE_NAME = 'singscope:binary:v1'
export const BINARY_DATABASE_SCHEMA_VERSION = 2
const DEFAULT_CHUNK_BYTES = 1024 * 1024
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024

interface BinaryChunk {
  storageId: string
  index: number
  data: ArrayBuffer | Blob
}

interface BinaryManifest {
  id: string
  storageId: string
  state: 'committed' | 'temporary'
  byteLength: number
  mimeType: string
  sha256: string | null
  createdAt: string
  nextIndex: number
}

class BinaryDatabase extends Dexie {
  manifests!: EntityTable<BinaryManifest, 'id'>
  chunks!: Table<BinaryChunk, [string, number]>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      manifests: 'id, storageId, state, createdAt',
      chunks: '[storageId+index], storageId',
    })
    // Version 2 writes ArrayBuffer chunks for WebKit compatibility. Readers keep
    // accepting v1 Blob chunks so existing local projects migrate lazily.
    this.version(BINARY_DATABASE_SCHEMA_VERSION).stores({
      manifests: 'id, storageId, state, createdAt',
      chunks: '[storageId+index], storageId',
    })
  }
}

export interface IndexedDbBinaryStoreOptions {
  databaseName?: string
  maxBytes?: number
  chunkBytes?: number
}

export class IndexedDbBinaryStore implements BinaryStore {
  readonly kind = 'indexeddb' as const
  private readonly database: BinaryDatabase
  private readonly maxBytes: number
  private readonly chunkBytes: number

  constructor(options: IndexedDbBinaryStoreOptions = {}) {
    this.database = new BinaryDatabase(options.databaseName ?? BINARY_DATABASE_NAME)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  }

  async beginTemporary(id = createTemporaryId()): Promise<TemporaryBinary> {
    const createdAt = new Date().toISOString()
    try {
      await this.database.manifests.add({
        id,
        storageId: id,
        state: 'temporary',
        byteLength: 0,
        mimeType: '',
        sha256: null,
        createdAt,
        nextIndex: 0,
      })
      return { id, byteLength: 0, createdAt }
    } catch (error) {
      throw mapStorageError(error, 'Start recording')
    }
  }

  async appendTemporary(id: string, chunk: Blob): Promise<TemporaryBinary> {
    const preparedChunks: ArrayBuffer[] = []
    for (let offset = 0; offset < chunk.size; offset += this.chunkBytes) {
      const end = Math.min(offset + this.chunkBytes, chunk.size)
      preparedChunks.push(await chunk.slice(offset, end).arrayBuffer())
    }
    try {
      return await this.database.transaction(
        'rw',
        this.database.manifests,
        this.database.chunks,
        async () => {
          const manifest = await this.database.manifests.get(id)
          if (manifest?.state !== 'temporary') {
            throw new SingScopeStorageError('not-found', 'The temporary recording was not found.')
          }
          if (manifest.byteLength + chunk.size > this.maxBytes) {
            throw new SingScopeStorageError(
              'quota-exceeded',
              'This recording reached SingScope’s local iPhone size limit.',
            )
          }

          let index = manifest.nextIndex
          for (const data of preparedChunks) {
            await this.database.chunks.put({ storageId: id, index, data })
            index += 1
          }
          const byteLength = manifest.byteLength + chunk.size
          await this.database.manifests.update(id, { byteLength, nextIndex: index })
          return { id, byteLength, createdAt: manifest.createdAt }
        },
      )
    } catch (error) {
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'Append recording data')
    }
  }

  async commitTemporary(temporaryId: string, input: BinaryCommitInput): Promise<BinaryMetadata> {
    const temporary = await this.database.manifests.get(temporaryId)
    if (temporary?.state !== 'temporary') {
      throw new SingScopeStorageError('not-found', 'The temporary recording was not found.')
    }
    const data = await this.readStorageBlob(temporary.storageId, input.mimeType)
    const digest = await sha256Blob(data)
    const metadata: BinaryMetadata = {
      id: input.id,
      byteLength: data.size,
      mimeType: input.mimeType,
      sha256: digest,
      createdAt: temporary.createdAt,
    }

    try {
      await this.database.transaction('rw', this.database.manifests, async () => {
        const current = await this.database.manifests.get(temporaryId)
        if (current?.state !== 'temporary') {
          throw new SingScopeStorageError(
            'not-found',
            'The temporary recording changed before commit.',
          )
        }
        await this.database.manifests.put({
          id: input.id,
          storageId: current.storageId,
          state: 'committed',
          byteLength: metadata.byteLength,
          mimeType: metadata.mimeType,
          sha256: metadata.sha256,
          createdAt: metadata.createdAt,
          nextIndex: current.nextIndex,
        })
        if (temporaryId !== input.id) await this.database.manifests.delete(temporaryId)
      })
      return metadata
    } catch (error) {
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'Commit recording')
    }
  }

  async abortTemporary(id: string): Promise<void> {
    const manifest = await this.database.manifests.get(id)
    if (manifest?.state !== 'temporary') return
    await this.deleteManifestAndChunks(manifest)
  }

  async read(id: string): Promise<Blob | null> {
    try {
      const manifest = await this.database.manifests.get(id)
      if (manifest?.state !== 'committed') return null
      const blob = await this.readStorageBlob(manifest.storageId, manifest.mimeType)
      if (blob.size !== manifest.byteLength) {
        throw new SingScopeStorageError(
          'corrupt-data',
          'Stored audio length did not match its manifest.',
        )
      }
      return blob
    } catch (error) {
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'Read audio')
    }
  }

  async delete(id: string): Promise<void> {
    const manifest = await this.database.manifests.get(id)
    if (manifest === undefined) return
    await this.deleteManifestAndChunks(manifest)
  }

  async listTemporary(): Promise<TemporaryBinary[]> {
    const manifests = await this.database.manifests.where('state').equals('temporary').toArray()
    return manifests.map(({ id, byteLength, createdAt }) => ({ id, byteLength, createdAt }))
  }

  async listCommitted(): Promise<BinaryMetadata[]> {
    const manifests = await this.database.manifests.where('state').equals('committed').toArray()
    return manifests.map((manifest) => {
      if (manifest.sha256 === null) {
        throw new SingScopeStorageError('corrupt-data', 'A committed binary is missing its hash.')
      }
      return {
        id: manifest.id,
        byteLength: manifest.byteLength,
        mimeType: manifest.mimeType,
        sha256: manifest.sha256,
        createdAt: manifest.createdAt,
      }
    })
  }

  close(): void {
    this.database.close()
  }

  private async readStorageBlob(storageId: string, mimeType: string): Promise<Blob> {
    const chunks = await this.database.chunks.where('storageId').equals(storageId).sortBy('index')
    return new Blob(
      chunks.map((chunk) => (chunk.data instanceof Blob ? chunk.data : chunk.data.slice(0))),
      { type: mimeType },
    )
  }

  private async deleteManifestAndChunks(manifest: BinaryManifest): Promise<void> {
    try {
      await this.database.transaction(
        'rw',
        this.database.manifests,
        this.database.chunks,
        async () => {
          await this.database.manifests.delete(manifest.id)
          const keys = await this.database.chunks
            .where('storageId')
            .equals(manifest.storageId)
            .primaryKeys()
          await this.database.chunks.bulkDelete(keys)
        },
      )
    } catch (error) {
      throw mapStorageError(error, 'Delete audio')
    }
  }
}
