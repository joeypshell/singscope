import { z } from 'zod'

export const PROJECT_BACKUP_SCHEMA_VERSION = 1
export const FEEDBACK_PACKAGE_SCHEMA_VERSION = 1
export const ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION = 1

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

export const analysisDebugManifestSchema = z.object({
  format: z.literal('singscope-analysis-debug-package'),
  schemaVersion: z.literal(ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION),
  packageId: uuid,
  createdAt: utc,
  detectorVersion: z.string().min(1).max(100),
  sourceAudioPath: z.enum([
    'source-audio.aac',
    'source-audio.m4a',
    'source-audio.mp3',
    'source-audio.mp4',
    'source-audio.webm',
    'source-audio.wav',
  ]),
  contourPointCount: z.number().int().nonnegative().max(5_000),
  candidateNoteCount: z.number().int().nonnegative().max(1_000),
  files: z.array(archiveFileManifestSchema).min(5).max(5),
})

export type ArchiveFileManifest = z.infer<typeof archiveFileManifestSchema>
export type BackupManifest = z.infer<typeof backupManifestSchema>
export type FeedbackManifest = z.infer<typeof feedbackManifestSchema>
export type AnalysisDebugManifest = z.infer<typeof analysisDebugManifestSchema>

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

export const ANALYSIS_DEBUG_EXACT_PATHS = new Set([
  'manifest.json',
  'diagnostics.json',
  'contour.csv',
  'estimated-notes.csv',
  'README.txt',
  'source-audio.aac',
  'source-audio.m4a',
  'source-audio.mp3',
  'source-audio.mp4',
  'source-audio.webm',
  'source-audio.wav',
])

export function isAllowedBackupPath(path: string): boolean {
  if (BACKUP_EXACT_PATHS.has(path)) return true
  return /^(?:pitch|assets)\/[a-z0-9][a-z0-9._-]{0,79}$/.test(path)
}

export function isAllowedFeedbackPath(path: string): boolean {
  return FEEDBACK_EXACT_PATHS.has(path)
}

export function isAllowedAnalysisDebugPath(path: string): boolean {
  return ANALYSIS_DEBUG_EXACT_PATHS.has(path)
}
