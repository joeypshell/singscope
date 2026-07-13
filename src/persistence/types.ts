export type JsonPrimitive = boolean | number | string | null

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface VersionedRecord<T extends JsonValue = JsonValue> {
  id: string
  schemaVersion: number
  createdAt: string
  updatedAt: string
  payload: T
}

export interface ProjectRecord<T extends JsonValue = JsonValue> extends VersionedRecord<T> {
  projectId: string
}

export interface RevisionRecord<T extends JsonValue = JsonValue> extends ProjectRecord<T> {
  revision: number
}

export interface PitchChunkRecord<T extends JsonValue = JsonValue> extends ProjectRecord<T> {
  takeId: string
  index: number
  startSeconds: number
  endSeconds: number
}

export type AssetStatus = 'committed' | 'temporary'

export interface AssetRecord extends ProjectRecord {
  logicalAssetId: string
  backend: 'indexeddb' | 'opfs'
  status: AssetStatus
  mimeType: string
  byteLength: number
  sha256: string | null
}

export interface JournalRecord extends ProjectRecord {
  operation: 'asset-commit' | 'asset-delete' | 'import'
  state: 'committed' | 'failed' | 'pending'
}

export interface CommitStateRecord extends ProjectRecord {
  logicalAssetId: string
  state: AssetStatus
  temporaryId: string | null
}

export interface BinaryMetadata {
  id: string
  byteLength: number
  mimeType: string
  sha256: string
  createdAt: string
}

export interface TemporaryBinary {
  id: string
  byteLength: number
  createdAt: string
}

export interface BinaryCommitInput {
  id: string
  mimeType: string
}

export interface StorageProbeResult {
  indexedDb: boolean
  opfs: boolean
  persistent: boolean
  usage: number | null
  quota: number | null
  errors: string[]
}
