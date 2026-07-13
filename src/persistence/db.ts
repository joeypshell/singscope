import Dexie, { type EntityTable, type Table } from 'dexie'

import type {
  AssetRecord,
  CommitStateRecord,
  JournalRecord,
  PitchChunkRecord,
  ProjectRecord,
  RevisionRecord,
  VersionedRecord,
} from './types'

export const DATABASE_SCHEMA_VERSION = 2
export const DATABASE_NAME = 'singscope:app:v1'

export type MetadataRecord = ProjectRecord

export class SingScopeDatabase extends Dexie {
  projects!: EntityTable<VersionedRecord, 'id'>
  references!: EntityTable<MetadataRecord, 'id'>
  targetSets!: EntityTable<RevisionRecord, 'id'>
  sections!: EntityTable<MetadataRecord, 'id'>
  takes!: EntityTable<MetadataRecord, 'id'>
  pitchChunks!: Table<PitchChunkRecord, [string, number]>
  settings!: EntityTable<MetadataRecord, 'id'>
  assets!: EntityTable<AssetRecord, 'id'>
  journals!: EntityTable<JournalRecord, 'id'>
  commitStates!: EntityTable<CommitStateRecord, 'id'>

  constructor(name = DATABASE_NAME) {
    super(name)

    this.version(1).stores({
      projects: 'id, updatedAt, createdAt',
      references: 'id, projectId, updatedAt',
      targetSets: 'id, projectId, [projectId+revision], updatedAt',
      sections: 'id, projectId, updatedAt',
      takes: 'id, projectId, updatedAt',
      pitchChunks: '[takeId+index], takeId, projectId, startSeconds',
      settings: 'id, projectId, updatedAt',
      assets: 'id, projectId, logicalAssetId, status, updatedAt',
    })

    this.version(DATABASE_SCHEMA_VERSION)
      .stores({
        projects: 'id, updatedAt, createdAt',
        references: 'id, projectId, updatedAt',
        targetSets: 'id, projectId, [projectId+revision], updatedAt',
        sections: 'id, projectId, updatedAt',
        takes: 'id, projectId, updatedAt',
        pitchChunks: '[takeId+index], takeId, projectId, startSeconds',
        settings: 'id, projectId, updatedAt',
        assets: 'id, projectId, logicalAssetId, status, updatedAt',
        journals: 'id, projectId, operation, state, updatedAt',
        commitStates: 'id, projectId, logicalAssetId, state, updatedAt',
      })
      .upgrade(async (transaction) => {
        const tables = ['projects', 'references', 'targetSets', 'sections', 'takes', 'settings']
        await Promise.all(
          tables.map(async (tableName) => {
            await transaction
              .table(tableName)
              .toCollection()
              .modify((record: Record<string, unknown>) => {
                if (typeof record['schemaVersion'] !== 'number') record['schemaVersion'] = 1
              })
          }),
        )
      })
  }
}

let database: SingScopeDatabase | undefined

export function getDatabase(): SingScopeDatabase {
  database ??= new SingScopeDatabase()
  return database
}

export function closeDatabase(): void {
  database?.close()
  database = undefined
}
