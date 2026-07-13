import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'

import { IPHONE_LIMITS, assertWithinBytes } from './limits'
import { assertSafeArchivePath } from './safety'
import { sha256Blob } from '../persistence/hash'
import type { ArchiveFileManifest } from './schemas'

export interface ArchiveSource {
  path: string
  data: Blob | string | Uint8Array
  mediaType: string
  compression: 'deflate' | 'store'
}

export interface BuiltArchive {
  blob: Blob
  files: ArchiveFileManifest[]
  sha256: string
  expandedBytes: number
}

export interface DescribedArchiveSources {
  files: ArchiveFileManifest[]
  expandedBytes: number
}

function sourceToBlob(source: ArchiveSource): Blob {
  if (source.data instanceof Blob) return source.data.slice(0, source.data.size, source.mediaType)
  if (typeof source.data === 'string') return new Blob([source.data], { type: source.mediaType })
  const copy = new Uint8Array(source.data.byteLength)
  copy.set(source.data)
  return new Blob([copy.buffer], { type: source.mediaType })
}

function prepareSources(sources: readonly ArchiveSource[]): {
  prepared: { source: ArchiveSource; blob: Blob }[]
  expandedBytes: number
} {
  const paths = new Set<string>()
  const prepared: { source: ArchiveSource; blob: Blob }[] = []
  let expandedBytes = 0

  for (const source of sources) {
    assertSafeArchivePath(source.path)
    if (paths.has(source.path)) throw new Error(`Duplicate archive path: ${source.path}`)
    paths.add(source.path)
    const blob = sourceToBlob(source)
    expandedBytes += blob.size
    assertWithinBytes(expandedBytes, IPHONE_LIMITS.expandedPackageBytes, 'Expanded package')
    prepared.push({ source, blob })
  }

  return { prepared, expandedBytes }
}

export async function describeArchiveSources(
  sources: readonly ArchiveSource[],
): Promise<DescribedArchiveSources> {
  const { prepared, expandedBytes } = prepareSources(sources)
  const files: ArchiveFileManifest[] = []
  for (const { source, blob } of prepared) {
    files.push({
      path: source.path,
      byteLength: blob.size,
      sha256: await sha256Blob(blob),
      mediaType: source.mediaType,
    })
  }
  return { files, expandedBytes }
}

export async function buildZipArchive(sources: readonly ArchiveSource[]): Promise<BuiltArchive> {
  const { prepared, expandedBytes } = prepareSources(sources)

  const files: ArchiveFileManifest[] = []
  for (const { source, blob } of prepared) {
    files.push({
      path: source.path,
      byteLength: blob.size,
      sha256: await sha256Blob(blob),
      mediaType: source.mediaType,
    })
  }

  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
  try {
    for (const { source, blob } of prepared) {
      await writer.add(source.path, new BlobReader(blob), {
        level: source.compression === 'store' ? 0 : 6,
        useWebWorkers: false,
      })
    }
    const blob = await writer.close()
    assertWithinBytes(blob.size, IPHONE_LIMITS.savedPackageBytes, 'Prepared package')
    return { blob, files, sha256: await sha256Blob(blob), expandedBytes }
  } catch (error) {
    await writer.close().catch(() => undefined)
    throw error
  }
}
