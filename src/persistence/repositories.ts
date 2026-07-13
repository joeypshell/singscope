import { z } from 'zod'

import type { SingScopeDatabase } from './db'
import { SingScopeStorageError, mapStorageError } from './errors'
import type {
  AssetRecord,
  CommitStateRecord,
  JournalRecord,
  JsonValue,
  PitchChunkRecord,
  ProjectRecord,
  RevisionRecord,
  VersionedRecord,
} from './types'

const utcDateSchema = z.iso.datetime({ offset: true })
const idSchema = z.uuid()
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
)

export const versionedRecordSchema = z.object({
  id: idSchema,
  schemaVersion: z.number().int().positive(),
  createdAt: utcDateSchema,
  updatedAt: utcDateSchema,
  payload: jsonSchema,
})

export const projectRecordSchema = versionedRecordSchema.extend({ projectId: idSchema })
export const revisionRecordSchema = projectRecordSchema.extend({
  revision: z.number().int().nonnegative(),
})
export const pitchChunkRecordSchema = projectRecordSchema.extend({
  takeId: idSchema,
  index: z.number().int().nonnegative(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
})

type PrimaryKey = IDBValidKey | [IDBValidKey, IDBValidKey]

interface RepositoryTable<T> {
  get(key: PrimaryKey): Promise<T | undefined>
  put(value: T): Promise<unknown>
  delete(key: PrimaryKey): Promise<void>
  toArray(): Promise<T[]>
}

export class ValidatedRepository<T> {
  constructor(
    private readonly table: RepositoryTable<T>,
    private readonly schema: z.ZodType<T>,
  ) {}

  async get(key: PrimaryKey): Promise<T | null> {
    try {
      const record = await this.table.get(key)
      if (record === undefined) return null
      return this.parse(record)
    } catch (error) {
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'Read')
    }
  }

  async list(): Promise<T[]> {
    try {
      return (await this.table.toArray()).map((record) => this.parse(record))
    } catch (error) {
      if (error instanceof SingScopeStorageError) throw error
      throw mapStorageError(error, 'List')
    }
  }

  async put(value: T): Promise<void> {
    const validated = this.parse(value)
    try {
      await this.table.put(validated)
    } catch (error) {
      throw mapStorageError(error, 'Save')
    }
  }

  async delete(key: PrimaryKey): Promise<void> {
    try {
      await this.table.delete(key)
    } catch (error) {
      throw mapStorageError(error, 'Delete')
    }
  }

  private parse(value: T): T {
    const parsed = this.schema.safeParse(value)
    if (!parsed.success) {
      throw new SingScopeStorageError(
        'corrupt-data',
        'A local record did not match its versioned schema.',
        parsed.error,
      )
    }
    return parsed.data
  }
}

const assetRecordSchema: z.ZodType<AssetRecord> = projectRecordSchema.extend({
  logicalAssetId: idSchema,
  backend: z.enum(['indexeddb', 'opfs']),
  status: z.enum(['committed', 'temporary']),
  mimeType: z.string().max(255),
  byteLength: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
})

const journalRecordSchema: z.ZodType<JournalRecord> = projectRecordSchema.extend({
  operation: z.enum(['asset-commit', 'asset-delete', 'import']),
  state: z.enum(['committed', 'failed', 'pending']),
})

const commitStateRecordSchema: z.ZodType<CommitStateRecord> = projectRecordSchema.extend({
  logicalAssetId: idSchema,
  state: z.enum(['committed', 'temporary']),
  temporaryId: idSchema.nullable(),
})

export interface Repositories {
  projects: ValidatedRepository<VersionedRecord>
  references: ValidatedRepository<ProjectRecord>
  targets: ValidatedRepository<RevisionRecord>
  sections: ValidatedRepository<ProjectRecord>
  takes: ValidatedRepository<ProjectRecord>
  pitchChunks: ValidatedRepository<PitchChunkRecord>
  settings: ValidatedRepository<ProjectRecord>
  assets: ValidatedRepository<AssetRecord>
  journals: ValidatedRepository<JournalRecord>
  commitStates: ValidatedRepository<CommitStateRecord>
}

export function createRepositories(database: SingScopeDatabase): Repositories {
  return {
    projects: new ValidatedRepository<VersionedRecord>(database.projects, versionedRecordSchema),
    references: new ValidatedRepository<ProjectRecord>(database.references, projectRecordSchema),
    targets: new ValidatedRepository<RevisionRecord>(database.targetSets, revisionRecordSchema),
    sections: new ValidatedRepository<ProjectRecord>(database.sections, projectRecordSchema),
    takes: new ValidatedRepository<ProjectRecord>(database.takes, projectRecordSchema),
    pitchChunks: new ValidatedRepository<PitchChunkRecord>(
      database.pitchChunks,
      pitchChunkRecordSchema,
    ),
    settings: new ValidatedRepository<ProjectRecord>(database.settings, projectRecordSchema),
    assets: new ValidatedRepository<AssetRecord>(database.assets, assetRecordSchema),
    journals: new ValidatedRepository<JournalRecord>(database.journals, journalRecordSchema),
    commitStates: new ValidatedRepository<CommitStateRecord>(
      database.commitStates,
      commitStateRecordSchema,
    ),
  }
}
