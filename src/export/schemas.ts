import { z } from 'zod'

export const PROJECT_BACKUP_SCHEMA_VERSION = 1
export const FEEDBACK_PACKAGE_SCHEMA_VERSION = 1

const uuid = z.uuid()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const utc = z.iso.datetime({ offset: true })

export const archiveFileManifestSchema = z.object({
  path: z.string().min(1).max(160),
  byteLength: z.number().int().nonnegative(),
  sha256: hash,
  mediaType: z.string().min(1).max(255),
})

export const backupManifestSchema = z.object({
  format: z.literal('singscope-project-backup'),
  schemaVersion: z.literal(PROJECT_BACKUP_SCHEMA_VERSION),
  packageId: uuid,
  projectId: uuid,
  createdAt: utc,
  databaseSchemaVersion: z.number().int().positive(),
  files: z.array(archiveFileManifestSchema).max(2_100),
})

export const feedbackManifestSchema = z.object({
  format: z.literal('singscope-feedback-package'),
  schemaVersion: z.literal(FEEDBACK_PACKAGE_SCHEMA_VERSION),
  packageId: uuid,
  projectId: uuid,
  takeId: uuid,
  createdAt: utc,
  detectorVersion: z.string().min(1).max(100),
  metricsVersion: z.string().min(1).max(100),
  includesReferenceAudio: z.boolean(),
  files: z.array(archiveFileManifestSchema).max(64),
  omissions: z.array(z.string().max(500)).max(20),
})

export type ArchiveFileManifest = z.infer<typeof archiveFileManifestSchema>
export type BackupManifest = z.infer<typeof backupManifestSchema>
export type FeedbackManifest = z.infer<typeof feedbackManifestSchema>

export const BACKUP_EXACT_PATHS = new Set([
  'manifest.json',
  'project.json',
  'references.json',
  'targets.json',
  'sections.json',
  'takes.json',
  'settings.json',
  'README.txt',
])

export const FEEDBACK_EXACT_PATHS = new Set([
  'manifest.json',
  'recording.m4a',
  'recording.mp4',
  'recording.webm',
  'recording.wav',
  'reference.m4a',
  'reference.mp4',
  'reference.webm',
  'reference.wav',
  'pitch-data.csv',
  'target-notes.csv',
  'session.json',
  'pitch-chart.png',
  'report.html',
  'README.txt',
])

export function isAllowedBackupPath(path: string): boolean {
  if (BACKUP_EXACT_PATHS.has(path)) return true
  return /^(?:pitch|assets)\/[a-z0-9][a-z0-9._-]{0,79}$/.test(path)
}

export function isAllowedFeedbackPath(path: string): boolean {
  return FEEDBACK_EXACT_PATHS.has(path)
}
