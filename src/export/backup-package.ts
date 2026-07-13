import {
  buildZipArchive,
  describeArchiveSources,
  type ArchiveSource,
  type BuiltArchive,
} from './archive'
import { DATABASE_SCHEMA_VERSION } from '../persistence/db'
import {
  PROJECT_BACKUP_SCHEMA_VERSION,
  backupManifestSchema,
  isAllowedBackupPath,
  type BackupManifest,
} from './schemas'

export interface BackupAssetInput {
  filename: string
  blob: Blob
}

export interface BackupPitchChunkInput {
  filename: string
  value: unknown
}

export interface ProjectBackupInput {
  projectId: string
  createdAt?: string
  project: unknown
  references: unknown
  targets: unknown
  sections: unknown
  takes: unknown
  settings: unknown
  pitchChunks?: readonly BackupPitchChunkInput[]
  assets?: readonly BackupAssetInput[]
}

export interface ProjectBackupResult extends BuiltArchive {
  filename: 'singscope-project-backup.zip'
  manifest: BackupManifest
}

function jsonSource(path: string, value: unknown): ArchiveSource {
  return {
    path,
    data: `${JSON.stringify(value, null, 2)}\n`,
    mediaType: 'application/json',
    compression: 'deflate',
  }
}

export async function createProjectBackup(input: ProjectBackupInput): Promise<ProjectBackupResult> {
  const sources: ArchiveSource[] = [
    jsonSource('project.json', input.project),
    jsonSource('references.json', input.references),
    jsonSource('targets.json', input.targets),
    jsonSource('sections.json', input.sections),
    jsonSource('takes.json', input.takes),
    jsonSource('settings.json', input.settings),
    {
      path: 'README.txt',
      data: [
        'SingScope project backup',
        '',
        'Import this ZIP from SingScope. Do not edit or rename its contents.',
        'Safari and an installed Home Screen app can have separate storage; transfer with this backup.',
        '',
      ].join('\r\n'),
      mediaType: 'text/plain;charset=utf-8',
      compression: 'deflate',
    },
  ]

  for (const chunk of input.pitchChunks ?? []) {
    sources.push(jsonSource(`pitch/${chunk.filename}`, chunk.value))
  }
  for (const asset of input.assets ?? []) {
    sources.push({
      path: `assets/${asset.filename}`,
      data: asset.blob,
      mediaType: asset.blob.type || 'application/octet-stream',
      compression: 'store',
    })
  }
  for (const source of sources) {
    if (!isAllowedBackupPath(source.path)) throw new Error(`Unexpected backup path: ${source.path}`)
  }

  const contentDescription = await describeArchiveSources(sources)
  const manifest: BackupManifest = backupManifestSchema.parse({
    format: 'singscope-project-backup',
    schemaVersion: PROJECT_BACKUP_SCHEMA_VERSION,
    packageId: crypto.randomUUID(),
    projectId: input.projectId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
    files: contentDescription.files,
  })

  const archive = await buildZipArchive([...sources, jsonSource('manifest.json', manifest)])
  return { ...archive, filename: 'singscope-project-backup.zip', manifest }
}
