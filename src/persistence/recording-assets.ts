import type { SingScopeDatabase } from './db'
import type { BinaryStore } from './binary-store'
import { SingScopeStorageError, mapStorageError } from './errors'
import type { AssetRecord, CommitStateRecord, JournalRecord, TemporaryBinary } from './types'

export const TAKE_MAX_BYTES = 48 * 1024 * 1024
export const PROJECT_MAX_BINARY_BYTES = 128 * 1024 * 1024

export type InterruptionReason =
  | 'app-backgrounded'
  | 'audio-context-interrupted'
  | 'device-route-lost'
  | 'media-track-ended'
  | 'none'

export interface RecordingCommitResult {
  asset: AssetRecord
  partial: boolean
  interruptionReason: InterruptionReason
}

export class RecordingAssetWriter {
  private temporaryId: string | null = null
  private bytes = 0
  private projectBytesAtStart = 0
  private finalized = false

  constructor(
    private readonly database: SingScopeDatabase,
    private readonly store: BinaryStore,
    private readonly projectId: string,
    private readonly logicalAssetId: string,
    private readonly mimeType: string,
  ) {}

  async begin(): Promise<void> {
    if (this.temporaryId !== null) return
    const projectAssets = await this.database.assets
      .where('projectId')
      .equals(this.projectId)
      .toArray()
    this.projectBytesAtStart = projectAssets
      .filter(
        (asset) => asset.status === 'committed' && asset.logicalAssetId !== this.logicalAssetId,
      )
      .reduce((total, asset) => total + asset.byteLength, 0)
    if (this.projectBytesAtStart >= PROJECT_MAX_BINARY_BYTES) {
      throw new SingScopeStorageError(
        'quota-exceeded',
        'This project has reached the 128 MiB iPhone binary-payload limit.',
      )
    }
    const temporary = await this.store.beginTemporary()
    this.temporaryId = temporary.id
    const now = new Date().toISOString()
    const asset = this.createAssetRecord(now, 'temporary', 0, null, {
      partial: false,
      interruptionReason: 'none',
      temporaryId: temporary.id,
    })
    const commitState = this.createCommitState(now, 'temporary', temporary.id)
    const journal = this.createJournal(now, 'pending')

    try {
      await this.database.transaction(
        'rw',
        this.database.assets,
        this.database.commitStates,
        this.database.journals,
        async () => {
          await this.database.assets.put(asset)
          await this.database.commitStates.put(commitState)
          await this.database.journals.put(journal)
        },
      )
    } catch (error) {
      await this.store.abortTemporary(temporary.id)
      throw mapStorageError(error, 'Start recording journal')
    }
  }

  async appendOneSecondChunk(chunk: Blob): Promise<number> {
    if (this.finalized) throw new Error('The recording has already been finalized.')
    if (this.temporaryId === null) await this.begin()
    if (this.bytes + chunk.size > TAKE_MAX_BYTES) {
      throw new SingScopeStorageError(
        'quota-exceeded',
        'This take reached the 48 MiB iPhone limit. The partial take can still be saved.',
      )
    }
    if (this.projectBytesAtStart + this.bytes + chunk.size > PROJECT_MAX_BINARY_BYTES) {
      throw new SingScopeStorageError(
        'quota-exceeded',
        'This project reached the 128 MiB iPhone binary-payload limit. The partial take can still be saved.',
      )
    }
    const temporaryId = this.requireTemporaryId()
    const state = await this.store.appendTemporary(temporaryId, chunk)
    this.bytes = state.byteLength
    return this.bytes
  }

  async finalize(
    partial = false,
    interruptionReason: InterruptionReason = 'none',
  ): Promise<RecordingCommitResult> {
    if (this.finalized) throw new Error('The recording has already been finalized.')
    if (this.temporaryId === null) await this.begin()
    const temporaryId = this.requireTemporaryId()
    const metadata = await this.store.commitTemporary(temporaryId, {
      id: this.logicalAssetId,
      mimeType: this.mimeType,
    })
    const now = new Date().toISOString()
    const asset = this.createAssetRecord(now, 'committed', metadata.byteLength, metadata.sha256, {
      partial,
      interruptionReason,
      temporaryId: null,
    })

    try {
      await this.database.transaction(
        'rw',
        this.database.assets,
        this.database.commitStates,
        this.database.journals,
        async () => {
          await this.database.assets.put(asset)
          await this.database.commitStates.put(this.createCommitState(now, 'committed', null))
          await this.database.journals.put(this.createJournal(now, 'committed'))
        },
      )
      this.finalized = true
      return { asset, partial, interruptionReason }
    } catch (error) {
      throw mapStorageError(error, 'Commit recording metadata')
    }
  }

  async finalizeInterrupted(
    reason: Exclude<InterruptionReason, 'none'>,
  ): Promise<RecordingCommitResult> {
    return this.finalize(true, reason)
  }

  async abort(): Promise<void> {
    if (this.finalized) return
    if (this.temporaryId !== null) await this.store.abortTemporary(this.temporaryId)
    await this.database.transaction(
      'rw',
      this.database.assets,
      this.database.commitStates,
      this.database.journals,
      async () => {
        await this.database.assets.delete(this.logicalAssetId)
        await this.database.commitStates.delete(this.logicalAssetId)
        await this.database.journals.delete(this.logicalAssetId)
      },
    )
    this.finalized = true
  }

  private requireTemporaryId(): string {
    if (this.temporaryId === null) throw new Error('Recording has not started.')
    return this.temporaryId
  }

  private createAssetRecord(
    now: string,
    status: AssetRecord['status'],
    byteLength: number,
    sha256: string | null,
    payload: AssetRecord['payload'],
  ): AssetRecord {
    return {
      id: this.logicalAssetId,
      projectId: this.projectId,
      logicalAssetId: this.logicalAssetId,
      backend: this.store.kind,
      status,
      mimeType: this.mimeType,
      byteLength,
      sha256,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      payload,
    }
  }

  private createCommitState(
    now: string,
    state: CommitStateRecord['state'],
    temporaryId: string | null,
  ): CommitStateRecord {
    return {
      id: this.logicalAssetId,
      projectId: this.projectId,
      logicalAssetId: this.logicalAssetId,
      state,
      temporaryId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      payload: {},
    }
  }

  private createJournal(now: string, state: JournalRecord['state']): JournalRecord {
    return {
      id: this.logicalAssetId,
      projectId: this.projectId,
      operation: 'asset-commit',
      state,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      payload: { logicalAssetId: this.logicalAssetId },
    }
  }
}

export interface RecoverableRecording {
  logicalAssetId: string
  projectId: string
  temporary: TemporaryBinary
}

export interface RecoveryResult {
  recoverable: RecoverableRecording[]
  committedRecordings: AssetRecord[]
  deletedOrphanTemporaryIds: string[]
  deletedOrphanCommittedIds: string[]
}

export async function recoverBinaryState(
  database: SingScopeDatabase,
  store: BinaryStore,
): Promise<RecoveryResult> {
  const [temporary, committed, states, assets, projects] = await Promise.all([
    store.listTemporary(),
    store.listCommitted(),
    database.commitStates.toArray(),
    database.assets.toArray(),
    database.projects.toArray(),
  ])
  const projectIds = new Set(projects.map((project) => project.id))
  const temporaryById = new Map(temporary.map((item) => [item.id, item]))
  const referencedTemporary = new Set(
    states.flatMap((state) =>
      state.state === 'temporary' && state.temporaryId && projectIds.has(state.projectId)
        ? [state.temporaryId]
        : [],
    ),
  )
  const recoverable = states.flatMap((state) => {
    if (
      state.state !== 'temporary' ||
      state.temporaryId === null ||
      !projectIds.has(state.projectId)
    )
      return []
    const value = temporaryById.get(state.temporaryId)
    return value === undefined
      ? []
      : [{ logicalAssetId: state.logicalAssetId, projectId: state.projectId, temporary: value }]
  })
  const committedRecordings = assets.filter(
    (asset) =>
      asset.status === 'committed' &&
      projectIds.has(asset.projectId) &&
      typeof asset.payload === 'object' &&
      asset.payload !== null &&
      !Array.isArray(asset.payload) &&
      typeof asset.payload['partial'] === 'boolean',
  )

  const deletedOrphanTemporaryIds: string[] = []
  for (const item of temporary) {
    if (referencedTemporary.has(item.id)) continue
    await store.abortTemporary(item.id)
    const staleIds = states
      .filter((state) => state.temporaryId === item.id)
      .map((state) => state.logicalAssetId)
    await database.transaction(
      'rw',
      database.assets,
      database.commitStates,
      database.journals,
      async () => {
        await database.assets.bulkDelete(staleIds)
        await database.commitStates.bulkDelete(staleIds)
        await database.journals.bulkDelete(staleIds)
      },
    )
    deletedOrphanTemporaryIds.push(item.id)
  }

  const knownCommitted = new Set(
    assets.flatMap((asset) =>
      asset.status === 'committed' && projectIds.has(asset.projectId) ? [asset.logicalAssetId] : [],
    ),
  )
  const deletedOrphanCommittedIds: string[] = []
  for (const item of committed) {
    if (knownCommitted.has(item.id)) continue
    await store.delete(item.id)
    await database.transaction(
      'rw',
      database.assets,
      database.commitStates,
      database.journals,
      async () => {
        await database.assets.delete(item.id)
        await database.commitStates.delete(item.id)
        await database.journals.delete(item.id)
      },
    )
    deletedOrphanCommittedIds.push(item.id)
  }

  return {
    recoverable,
    committedRecordings,
    deletedOrphanTemporaryIds,
    deletedOrphanCommittedIds,
  }
}

export async function finalizeRecoveredRecording(
  database: SingScopeDatabase,
  store: BinaryStore,
  recoverable: RecoverableRecording,
): Promise<AssetRecord> {
  const [asset, state, journal] = await Promise.all([
    database.assets.get(recoverable.logicalAssetId),
    database.commitStates.get(recoverable.logicalAssetId),
    database.journals.get(recoverable.logicalAssetId),
  ])
  if (
    asset?.status !== 'temporary' ||
    state?.state !== 'temporary' ||
    state.temporaryId !== recoverable.temporary.id ||
    journal === undefined
  ) {
    throw new SingScopeStorageError(
      'corrupt-data',
      'Interrupted recording metadata was incomplete.',
    )
  }

  const metadata = await store.commitTemporary(recoverable.temporary.id, {
    id: recoverable.logicalAssetId,
    mimeType: asset.mimeType,
  })
  const now = new Date().toISOString()
  const committedAsset: AssetRecord = {
    ...asset,
    status: 'committed',
    byteLength: metadata.byteLength,
    sha256: metadata.sha256,
    updatedAt: now,
    payload: {
      partial: true,
      interruptionReason: 'startup-recovery',
      temporaryId: null,
    },
  }
  await database.transaction(
    'rw',
    database.assets,
    database.commitStates,
    database.journals,
    async () => {
      await database.assets.put(committedAsset)
      await database.commitStates.put({
        ...state,
        state: 'committed',
        temporaryId: null,
        updatedAt: now,
      })
      await database.journals.put({ ...journal, state: 'committed', updatedAt: now })
    },
  )
  return committedAsset
}
