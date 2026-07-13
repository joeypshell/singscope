import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'

import { IPHONE_LIMITS, assertWithinBytes } from './limits'
import {
  backupManifestSchema,
  feedbackManifestSchema,
  isAllowedBackupPath,
  isAllowedFeedbackPath,
  type BackupManifest,
  type FeedbackManifest,
} from './schemas'
import { assertSafeArchivePath, hashBytesIncrementally, validateJsonShape } from './safety'

export type ArchiveKind = 'backup' | 'feedback'

export interface StagedArchive {
  kind: ArchiveKind
  manifest: BackupManifest | FeedbackManifest
  entries: ReadonlyMap<string, Uint8Array>
  compressedBytes: number
  expandedBytes: number
}

function allowedPath(kind: ArchiveKind, path: string): boolean {
  return kind === 'backup' ? isAllowedBackupPath(path) : isAllowedFeedbackPath(path)
}

function decodeJson(bytes: Uint8Array, path: string): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    validateJsonShape(value)
    return value
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}.`, { cause: error })
  }
}

function validateRequiredManifestPaths(
  kind: ArchiveKind,
  manifest: BackupManifest | FeedbackManifest,
): void {
  const paths = new Set(manifest.files.map((file) => file.path))
  const required =
    kind === 'backup'
      ? [
          'project.json',
          'references.json',
          'targets.json',
          'sections.json',
          'takes.json',
          'settings.json',
          'README.txt',
        ]
      : [
          'pitch-data.csv',
          'target-notes.csv',
          'session.json',
          'pitch-chart.png',
          'report.html',
          'README.txt',
        ]
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`Manifest is missing required file ${path}.`)
  }
  if (kind === 'feedback') {
    const encodedRecordings = [...paths].filter((path) =>
      /^recording\.(?:m4a|mp4|webm)$/.test(path),
    )
    if (encodedRecordings.length !== 1) {
      throw new Error('Feedback package must contain exactly one encoded recording.')
    }
    const references = [...paths].filter((path) => /^reference\.(?:m4a|mp4|webm|wav)$/.test(path))
    const feedbackManifest = feedbackManifestSchema.parse(manifest)
    if (feedbackManifest.includesReferenceAudio !== (references.length === 1)) {
      throw new Error('Reference-audio contents do not match the manifest.')
    }
  }
}

export async function stageArchive(blob: Blob, kind: ArchiveKind): Promise<StagedArchive> {
  assertWithinBytes(blob.size, IPHONE_LIMITS.savedPackageBytes, 'Import package')
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false })
  try {
    const zipEntries = await reader.getEntries()
    const files = zipEntries.filter((entry) => !entry.directory)
    const paths = new Set<string>()
    let declaredExpandedBytes = 0

    for (const entry of files) {
      const path = assertSafeArchivePath(entry.filename)
      if (!allowedPath(kind, path)) throw new Error(`Archive contains an unexpected path: ${path}`)
      if (paths.has(path)) throw new Error(`Archive contains a duplicate path: ${path}`)
      if (entry.encrypted) throw new Error('Encrypted archives are not supported.')
      paths.add(path)
      declaredExpandedBytes += entry.uncompressedSize
      assertWithinBytes(
        declaredExpandedBytes,
        IPHONE_LIMITS.expandedPackageBytes,
        'Expanded import',
      )
    }
    if (!paths.has('manifest.json')) throw new Error('Archive is missing manifest.json.')

    const extracted = new Map<string, Uint8Array>()
    let actualExpandedBytes = 0
    for (const entry of files) {
      const remaining = IPHONE_LIMITS.expandedPackageBytes - actualExpandedBytes
      const bytes = await entry.getData(new Uint8ArrayWriter(), {
        useWebWorkers: false,
        onprogress(progress) {
          if (progress > remaining) throw new Error('Expanded import exceeded its byte limit.')
        },
      })
      actualExpandedBytes += bytes.byteLength
      assertWithinBytes(actualExpandedBytes, IPHONE_LIMITS.expandedPackageBytes, 'Expanded import')
      if (bytes.byteLength !== entry.uncompressedSize) {
        throw new Error(`Expanded size mismatch for ${entry.filename}.`)
      }
      extracted.set(entry.filename, bytes)
    }

    const manifestBytes = extracted.get('manifest.json')
    if (manifestBytes === undefined) throw new Error('Archive is missing manifest.json.')
    const rawManifest = decodeJson(manifestBytes, 'manifest.json')
    const manifest =
      kind === 'backup'
        ? backupManifestSchema.parse(rawManifest)
        : feedbackManifestSchema.parse(rawManifest)
    validateRequiredManifestPaths(kind, manifest)

    const listedPaths = new Set<string>()
    for (const file of manifest.files) {
      assertSafeArchivePath(file.path)
      if (!allowedPath(kind, file.path) || file.path === 'manifest.json') {
        throw new Error(`Manifest contains an unexpected path: ${file.path}`)
      }
      if (listedPaths.has(file.path)) throw new Error(`Manifest repeats ${file.path}.`)
      listedPaths.add(file.path)
      const bytes = extracted.get(file.path)
      if (bytes === undefined) throw new Error(`Archive is missing ${file.path}.`)
      if (bytes.byteLength !== file.byteLength) throw new Error(`Length mismatch for ${file.path}.`)
      if (hashBytesIncrementally(bytes) !== file.sha256)
        throw new Error(`Hash mismatch for ${file.path}.`)
    }

    for (const path of extracted.keys()) {
      if (path !== 'manifest.json' && !listedPaths.has(path)) {
        throw new Error(`Archive contains unlisted file ${path}.`)
      }
      if (path.endsWith('.json')) decodeJson(extracted.get(path) ?? new Uint8Array(), path)
    }

    return {
      kind,
      manifest,
      entries: extracted,
      compressedBytes: blob.size,
      expandedBytes: actualExpandedBytes,
    }
  } finally {
    await reader.close()
  }
}

export async function commitStagedImport<T>(
  staged: StagedArchive,
  commit: (validated: StagedArchive) => Promise<T>,
): Promise<T> {
  return commit(staged)
}
