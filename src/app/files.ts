import {
  ExportPreparer,
  IPHONE_LIMITS,
  commitStagedImport,
  materializePreparedExport,
  savePreparedPackage,
  stageArchive,
  type PreparedPackage,
} from '../export'
import {
  createBestBinaryStore,
  getDatabase,
  type AssetRecord,
  type BinaryStore,
} from '../persistence'
import { appProjectSchema } from './project-schema'
import type { AppProject } from './types'

export const APP_FILE_LIMITS = {
  backingBytes: 64 * 1024 * 1024,
  backingDurationSeconds: 20 * 60,
  isolatedBytes: 32 * 1024 * 1024,
  isolatedDurationSeconds: 8 * 60,
} as const

let binaryStorePromise: Promise<BinaryStore> | undefined

export function getBinaryStore(): Promise<BinaryStore> {
  binaryStorePromise ??= createBestBinaryStore()
  return binaryStorePromise
}

export async function audioDurationSeconds(file: Blob): Promise<number> {
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<number>((resolve, reject) => {
      const audio = new Audio()
      const timeout = window.setTimeout(
        () => reject(new Error('Audio metadata took too long to load.')),
        15_000,
      )
      const finish = () => window.clearTimeout(timeout)
      audio.preload = 'metadata'
      audio.addEventListener(
        'loadedmetadata',
        () => {
          finish()
          if (!Number.isFinite(audio.duration) || audio.duration <= 0)
            reject(new Error('Audio duration is invalid.'))
          else resolve(audio.duration)
        },
        { once: true },
      )
      audio.addEventListener(
        'error',
        () => {
          finish()
          reject(new Error('Safari could not decode this audio file.'))
        },
        { once: true },
      )
      audio.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function validateAudioFile(file: File, kind: 'backing' | 'isolated'): Promise<number> {
  const byteLimit =
    kind === 'backing' ? APP_FILE_LIMITS.backingBytes : APP_FILE_LIMITS.isolatedBytes
  const durationLimit =
    kind === 'backing'
      ? APP_FILE_LIMITS.backingDurationSeconds
      : APP_FILE_LIMITS.isolatedDurationSeconds
  if (file.size === 0 || file.size > byteLimit) {
    throw new Error(
      `${kind === 'backing' ? 'Backing audio' : 'Isolated-vocal audio'} exceeds its iPhone size limit.`,
    )
  }
  if (file.type && !file.type.startsWith('audio/') && file.type !== 'video/mp4') {
    throw new Error('Choose a locally stored audio file Safari can decode.')
  }
  const duration = await audioDurationSeconds(file)
  if (duration > durationLimit) {
    throw new Error(
      `${kind === 'backing' ? 'Backing audio' : 'Isolated-vocal audio'} exceeds its duration limit.`,
    )
  }
  return duration
}

export async function storeBinary(
  blob: Blob,
  projectId: string,
  id: string = crypto.randomUUID(),
  mimeType: string | undefined = blob.type,
): Promise<string> {
  const store = await getBinaryStore()
  const existingAssets = await getDatabase().assets.where('projectId').equals(projectId).toArray()
  const projectedBytes = existingAssets
    .filter((asset) => asset.status === 'committed' && asset.logicalAssetId !== id)
    .reduce((total, asset) => total + asset.byteLength, blob.size)
  if (projectedBytes > IPHONE_LIMITS.projectBinaryBytes) {
    throw new Error('This project would exceed the 128 MiB iPhone binary-payload limit.')
  }
  const temporary = await store.beginTemporary()
  let committed = false
  try {
    await store.appendTemporary(temporary.id, blob)
    const metadata = await store.commitTemporary(temporary.id, {
      id,
      mimeType: mimeType || 'application/octet-stream',
    })
    committed = true
    const now = new Date().toISOString()
    const asset: AssetRecord = {
      id,
      projectId,
      logicalAssetId: id,
      backend: store.kind,
      status: 'committed',
      mimeType: metadata.mimeType,
      byteLength: metadata.byteLength,
      sha256: metadata.sha256,
      schemaVersion: 1,
      createdAt: metadata.createdAt,
      updatedAt: now,
      payload: { source: 'validated-import' },
    }
    await getDatabase().assets.put(asset)
    return id
  } catch (error) {
    if (committed) {
      await Promise.allSettled([store.delete(id), getDatabase().assets.delete(id)])
    } else {
      await store.abortTemporary(temporary.id).catch(() => undefined)
    }
    throw error
  }
}

export async function referenceAudioUrl(
  project: AppProject,
): Promise<{ url: string; revoke: () => void }> {
  if (project.isSyntheticDemo) {
    return {
      url: new URL(`${import.meta.env.BASE_URL}demo-reference.wav`, window.location.origin).href,
      revoke: () => undefined,
    }
  }
  if (!project.referenceAssetId) throw new Error('This project has no backing audio.')
  const blob = await (await getBinaryStore()).read(project.referenceAssetId)
  if (!blob) throw new Error('The backing audio is missing from local storage. Restore a backup.')
  const url = URL.createObjectURL(blob)
  return { url, revoke: () => URL.revokeObjectURL(url) }
}

export async function readProjectAudio(project: AppProject, assetId: string): Promise<Blob | null> {
  if (project.isSyntheticDemo && assetId === project.referenceAssetId) {
    const response = await fetch(
      new URL(`${import.meta.env.BASE_URL}demo-reference.wav`, window.location.origin),
    )
    return response.blob()
  }
  return (await getBinaryStore()).read(assetId)
}

export async function prepareProjectBackup(project: AppProject): Promise<PreparedPackage> {
  const store = await getBinaryStore()
  const ids = [
    project.referenceAssetId,
    project.targetSourceAssetId,
    ...project.takes.map((take) => take.audioAssetId),
  ].filter((id): id is string => id !== null)
  const assets = (
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const blob = await store.read(id)
        return blob ? { filename: id, blob } : null
      }),
    )
  ).filter((asset): asset is { filename: string; blob: Blob } => asset !== null)

  const preparer = new ExportPreparer()
  try {
    const handle = await preparer.prepareBackup({
      projectId: project.id,
      project,
      references: project.referenceAssetId
        ? [{ id: project.referenceAssetId, name: project.referenceName }]
        : [],
      targets: { revision: project.targetRevision, mode: project.targetMode, notes: project.notes },
      sections: project.loops,
      takes: project.takes.map((take) => ({
        id: take.id,
        createdAt: take.createdAt,
        label: take.label,
        durationSeconds: take.durationSeconds,
        audioAssetId: take.audioAssetId,
        audioMimeType: take.audioMimeType,
        partialReason: take.partialReason,
      })),
      settings: {
        transpositionSemitones: project.transpositionSemitones,
        alignmentSeconds: project.alignmentSeconds,
        timingOffsetSeconds: project.timingOffsetSeconds,
      },
      pitchChunks: project.takes.map((take) => ({
        filename: `${take.id}.json`,
        value: take.points,
      })),
      assets,
    })
    return await materializePreparedExport(handle)
  } finally {
    preparer.terminate()
  }
}

export async function saveProjectBackup(project: AppProject): Promise<void> {
  savePreparedPackage(await prepareProjectBackup(project))
}

function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

export async function importProjectBackup(file: File): Promise<AppProject> {
  const staged = await stageArchive(file, 'backup')
  return commitStagedImport(staged, async (validated) => {
    const projectBytes = validated.entries.get('project.json')
    if (!projectBytes) throw new Error('Backup is missing project.json.')
    const project = appProjectSchema.parse(decodeJson(projectBytes))
    const database = getDatabase()
    if (await database.projects.get(project.id)) {
      throw new Error(
        'A project with this ID already exists. Delete it before restoring this backup.',
      )
    }
    const mimeById = new Map<string, string>()
    if (project.referenceAssetId)
      mimeById.set(
        project.referenceAssetId,
        project.referenceMimeType ?? 'application/octet-stream',
      )
    if (project.targetSourceAssetId)
      mimeById.set(
        project.targetSourceAssetId,
        project.targetSourceMimeType ?? 'application/octet-stream',
      )
    for (const take of project.takes) {
      if (take.audioAssetId)
        mimeById.set(take.audioAssetId, take.audioMimeType ?? 'application/octet-stream')
    }
    const stagedAssets = [...mimeById].map(([id, mimeType]) => {
      const bytes = validated.entries.get(`assets/${id}`)
      if (!bytes) throw new Error(`Backup is missing required binary asset ${id}.`)
      return { id, mimeType, bytes }
    })
    const binaryBytes = stagedAssets.reduce((total, asset) => total + asset.bytes.byteLength, 0)
    if (binaryBytes > IPHONE_LIMITS.projectBinaryBytes) {
      throw new Error('Backup exceeds the 128 MiB per-project binary-payload limit.')
    }
    const collisions = await database.assets.bulkGet(stagedAssets.map((asset) => asset.id))
    if (collisions.some((asset) => asset !== undefined)) {
      throw new Error('Backup asset identifiers already exist. Delete the existing project first.')
    }

    const committedIds: string[] = []
    try {
      for (const { id, mimeType, bytes } of stagedAssets) {
        await storeBinary(
          new Blob([bytes.slice().buffer], { type: mimeType }),
          project.id,
          id,
          mimeType,
        )
        committedIds.push(id)
      }
    } catch (error) {
      const store = await getBinaryStore()
      await Promise.allSettled(
        committedIds.flatMap((id) => [store.delete(id), database.assets.delete(id)]),
      )
      throw error
    }
    return project
  })
}
