import type { BinaryCommitInput, BinaryMetadata, TemporaryBinary } from './types'

export interface BinaryStore {
  readonly kind: 'indexeddb' | 'opfs'
  beginTemporary(id?: string): Promise<TemporaryBinary>
  appendTemporary(id: string, chunk: Blob): Promise<TemporaryBinary>
  commitTemporary(temporaryId: string, input: BinaryCommitInput): Promise<BinaryMetadata>
  abortTemporary(id: string): Promise<void>
  read(id: string): Promise<Blob | null>
  delete(id: string): Promise<void>
  listTemporary(): Promise<TemporaryBinary[]>
  listCommitted(): Promise<BinaryMetadata[]>
}

export function createTemporaryId(): string {
  return `tmp-${crypto.randomUUID()}`
}
