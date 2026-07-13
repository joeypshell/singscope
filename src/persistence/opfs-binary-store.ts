import type { BinaryStore } from './binary-store'
import { createTemporaryId } from './binary-store'
import { SingScopeStorageError, mapStorageError } from './errors'
import { sha256Blob } from './hash'
import type { BinaryCommitInput, BinaryMetadata, TemporaryBinary } from './types'

const ROOT_DIRECTORY = 'singscope'
const TEMP_DIRECTORY = 'temporary'
const ASSET_DIRECTORY = 'assets'
const MAX_BYTES = 128 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/

interface OpfsManifest extends BinaryMetadata {
  format: 'singscope-opfs-asset'
  version: 1
}

function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new SingScopeStorageError('validation-failed', 'A binary identifier was not safe.')
  }
}

async function getRootDirectory(): Promise<FileSystemDirectoryHandle> {
  const storage = navigator.storage as unknown as {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>
  }
  if (storage.getDirectory === undefined) {
    throw new SingScopeStorageError('storage-unavailable', 'OPFS is not available in this browser.')
  }
  return storage.getDirectory()
}

async function getDirectories(): Promise<{
  temporary: FileSystemDirectoryHandle
  assets: FileSystemDirectoryHandle
}> {
  const root = await getRootDirectory()
  const app = await root.getDirectoryHandle(ROOT_DIRECTORY, { create: true })
  const temporary = await app.getDirectoryHandle(TEMP_DIRECTORY, { create: true })
  const assets = await app.getDirectoryHandle(ASSET_DIRECTORY, { create: true })
  return { temporary, assets }
}

async function readJsonManifest(handle: FileSystemFileHandle): Promise<OpfsManifest> {
  const text = await (await handle.getFile()).text()
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== 'object' ||
    value === null ||
    !('format' in value) ||
    value.format !== 'singscope-opfs-asset' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('byteLength' in value) ||
    typeof value.byteLength !== 'number' ||
    !('mimeType' in value) ||
    typeof value.mimeType !== 'string' ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new SingScopeStorageError('corrupt-data', 'An OPFS asset manifest was invalid.')
  }
  return value as OpfsManifest
}

async function writeFile(handle: FileSystemFileHandle, value: Blob | string): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(value)
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

export class OpfsBinaryStore implements BinaryStore {
  readonly kind = 'opfs' as const

  async beginTemporary(id = createTemporaryId()): Promise<TemporaryBinary> {
    assertSafeId(id)
    const createdAt = new Date().toISOString()
    try {
      const { temporary } = await getDirectories()
      const file = await temporary.getFileHandle(`${id}.bin`, { create: true })
      await writeFile(file, new Blob())
      const metadata = await temporary.getFileHandle(`${id}.json`, { create: true })
      await writeFile(metadata, JSON.stringify({ createdAt }))
      return { id, byteLength: 0, createdAt }
    } catch (error) {
      throw mapStorageError(error, 'Start recording')
    }
  }

  async appendTemporary(id: string, chunk: Blob): Promise<TemporaryBinary> {
    assertSafeId(id)
    try {
      const { temporary } = await getDirectories()
      const handle = await temporary.getFileHandle(`${id}.bin`)
      const existing = await handle.getFile()
      if (existing.size + chunk.size > MAX_BYTES) {
        throw new SingScopeStorageError(
          'quota-exceeded',
          'This recording reached SingScope’s local iPhone size limit.',
        )
      }
      const writable = await handle.createWritable({ keepExistingData: true })
      try {
        await writable.seek(existing.size)
        await writable.write(chunk)
        await writable.close()
      } catch (error) {
        await writable.abort().catch(() => undefined)
        throw error
      }
      const createdAt = await this.readTemporaryCreatedAt(temporary, id)
      return { id, byteLength: existing.size + chunk.size, createdAt }
    } catch (error) {
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'Append recording data')
    }
  }

  async commitTemporary(temporaryId: string, input: BinaryCommitInput): Promise<BinaryMetadata> {
    assertSafeId(temporaryId)
    assertSafeId(input.id)
    try {
      const { temporary, assets } = await getDirectories()
      const sourceHandle = await temporary.getFileHandle(`${temporaryId}.bin`)
      const source = await sourceHandle.getFile()
      const metadata: BinaryMetadata = {
        id: input.id,
        byteLength: source.size,
        mimeType: input.mimeType,
        sha256: await sha256Blob(source),
        createdAt: await this.readTemporaryCreatedAt(temporary, temporaryId),
      }

      const committed = await assets.getFileHandle(`${input.id}.bin`, { create: true })
      await writeFile(committed, source)
      const manifest = await assets.getFileHandle(`${input.id}.json`, { create: true })
      const manifestValue: OpfsManifest = {
        format: 'singscope-opfs-asset',
        version: 1,
        ...metadata,
      }
      await writeFile(manifest, JSON.stringify(manifestValue))

      await temporary.removeEntry(`${temporaryId}.bin`).catch(() => undefined)
      await temporary.removeEntry(`${temporaryId}.json`).catch(() => undefined)
      return metadata
    } catch (error) {
      throw mapStorageError(error, 'Commit recording')
    }
  }

  async abortTemporary(id: string): Promise<void> {
    assertSafeId(id)
    const { temporary } = await getDirectories()
    await temporary.removeEntry(`${id}.bin`).catch(() => undefined)
    await temporary.removeEntry(`${id}.json`).catch(() => undefined)
  }

  async read(id: string): Promise<Blob | null> {
    assertSafeId(id)
    try {
      const { assets } = await getDirectories()
      const manifest = await readJsonManifest(await assets.getFileHandle(`${id}.json`))
      const file = await (await assets.getFileHandle(`${id}.bin`)).getFile()
      if (manifest.id !== id || file.size !== manifest.byteLength) {
        throw new SingScopeStorageError('corrupt-data', 'Stored audio did not match its manifest.')
      }
      return file.slice(0, file.size, manifest.mimeType)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'Read audio')
    }
  }

  async delete(id: string): Promise<void> {
    assertSafeId(id)
    const { assets } = await getDirectories()
    await assets.removeEntry(`${id}.json`).catch(() => undefined)
    await assets.removeEntry(`${id}.bin`).catch(() => undefined)
    await assets.removeEntry(`${id}.pending`).catch(() => undefined)
  }

  async listTemporary(): Promise<TemporaryBinary[]> {
    const { temporary } = await getDirectories()
    const result: TemporaryBinary[] = []
    for await (const [name, handle] of temporary.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.bin')) continue
      const id = name.slice(0, -4)
      const file = await handle.getFile()
      result.push({
        id,
        byteLength: file.size,
        createdAt: await this.readTemporaryCreatedAt(temporary, id),
      })
    }
    return result
  }

  async listCommitted(): Promise<BinaryMetadata[]> {
    const { assets } = await getDirectories()
    const result: BinaryMetadata[] = []
    for await (const [name, handle] of assets.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue
      const manifest = await readJsonManifest(handle)
      result.push({
        id: manifest.id,
        byteLength: manifest.byteLength,
        mimeType: manifest.mimeType,
        sha256: manifest.sha256,
        createdAt: manifest.createdAt,
      })
    }
    return result
  }

  private async readTemporaryCreatedAt(
    temporary: FileSystemDirectoryHandle,
    id: string,
  ): Promise<string> {
    try {
      const text = await (await temporary.getFileHandle(`${id}.json`)).getFile()
      const value: unknown = JSON.parse(await text.text())
      if (
        typeof value === 'object' &&
        value !== null &&
        'createdAt' in value &&
        typeof value.createdAt === 'string'
      ) {
        return value.createdAt
      }
    } catch {
      // The data remains recoverable even if its optional timestamp sidecar was interrupted.
    }
    return new Date(0).toISOString()
  }
}
