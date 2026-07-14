import type { AnalysisDebugPackageInput } from './analysis-debug-package'
import type { FeedbackPackageInput } from './feedback-package'
import type { ProjectBackupInput } from './backup-package'
import { assertSafeDownloadName } from './safety'
import type { PreparedPackage } from './share'
import type { AnalysisDebugManifest, FeedbackManifest } from './schemas'
import {
  isExportScratchName,
  type ExportWorkerRequest,
  type ExportWorkerResponse,
} from './worker-protocol'

interface PendingJob {
  resolve: (value: ExportWorkerResponse & { ok: true }) => void
  reject: (reason: Error) => void
  scratchName: string
}

const EXPORT_SCRATCH_DIRECTORY = 'export-scratch'
const MAX_STARTUP_SCRATCH_ENTRIES = 256
const SCRATCH_CLEANUP_RETRY_DELAYS_MS = [0, 50, 250] as const

export interface ExportScratchPruneResult {
  inspected: number
  removed: number
}

function assertSafeExportScratchName(name: string): void {
  if (!isExportScratchName(name)) {
    throw new Error('Prepared OPFS package name was invalid.')
  }
}

function exportScratchName(id: string): string {
  const name = `${id}.zip`
  assertSafeExportScratchName(name)
  return name
}

export interface PreparedExportHandle {
  filename: string
  sha256: string
  byteLength: number
  location: 'memory' | 'opfs'
  blob?: Blob
  scratchName?: string
  feedbackManifest?: FeedbackManifest
  analysisDebugManifest?: AnalysisDebugManifest
}

export class ExportPreparer {
  private readonly worker: Worker
  private readonly pending = new Map<string, PendingJob>()

  constructor(
    worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), {
      type: 'module',
    }),
  ) {
    this.worker = worker
    this.worker.addEventListener('message', (event: MessageEvent<ExportWorkerResponse>) => {
      const job = this.pending.get(event.data.id)
      if (job === undefined) return
      this.pending.delete(event.data.id)
      if (event.data.ok) job.resolve(event.data)
      else {
        job.reject(new Error(event.data.error))
        scheduleScratchRemoval(job.scratchName)
      }
    })
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'Export worker failed.')
      for (const job of this.pending.values()) {
        job.reject(error)
        scheduleScratchRemoval(job.scratchName)
      }
      this.pending.clear()
    })
  }

  prepareFeedback(input: FeedbackPackageInput): Promise<PreparedExportHandle> {
    const id = crypto.randomUUID()
    return this.prepare({ id, scratchName: exportScratchName(id), kind: 'feedback', input })
  }

  prepareBackup(input: ProjectBackupInput): Promise<PreparedExportHandle> {
    const id = crypto.randomUUID()
    return this.prepare({ id, scratchName: exportScratchName(id), kind: 'backup', input })
  }

  prepareAnalysisDebug(input: AnalysisDebugPackageInput): Promise<PreparedExportHandle> {
    const id = crypto.randomUUID()
    return this.prepare({ id, scratchName: exportScratchName(id), kind: 'analysis-debug', input })
  }

  terminate(): void {
    this.worker.terminate()
    const error = new Error('Export preparation was cancelled.')
    for (const job of this.pending.values()) {
      job.reject(error)
      scheduleScratchRemoval(job.scratchName)
    }
    this.pending.clear()
  }

  private prepare(request: ExportWorkerRequest): Promise<PreparedExportHandle> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject, scratchName: request.scratchName })
      try {
        this.worker.postMessage(request)
      } catch (error) {
        this.pending.delete(request.id)
        scheduleScratchRemoval(request.scratchName)
        reject(error instanceof Error ? error : new Error('Export worker could not start.'))
      }
    })
  }
}

function storageManagerWithOpfs():
  | (StorageManager & {
      getDirectory: () => Promise<FileSystemDirectoryHandle>
    })
  | null {
  const candidate: unknown = Reflect.get(navigator, 'storage')
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('getDirectory' in candidate) ||
    typeof candidate.getDirectory !== 'function'
  ) {
    return null
  }
  return candidate as StorageManager & {
    getDirectory: () => Promise<FileSystemDirectoryHandle>
  }
}

async function getScratchDirectory(create: boolean): Promise<FileSystemDirectoryHandle> {
  const storage = storageManagerWithOpfs()
  if (storage === null) throw new Error('OPFS is unavailable in this browser.')
  const root = await storage.getDirectory()
  const app = await root.getDirectoryHandle('singscope', { create })
  return app.getDirectoryHandle(EXPORT_SCRATCH_DIRECTORY, { create })
}

async function getExistingScratchDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await getScratchDirectory(false)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null
    if (storageManagerWithOpfs() === null) return null
    throw error
  }
}

async function removeScratchName(name: string): Promise<void> {
  assertSafeExportScratchName(name)
  const scratch = await getExistingScratchDirectory()
  if (scratch === null) return
  await scratch.removeEntry(name)
}

function scheduleScratchRemoval(name: string): void {
  void (async () => {
    for (const delayMs of SCRATCH_CLEANUP_RETRY_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      try {
        await removeScratchName(name)
        return
      } catch {
        // A terminated worker may briefly retain its file lock. Retry on a later task.
      }
    }
  })()
}

/**
 * Removes prepared exports left by an earlier page lifetime. Prepared handles are
 * in-memory only, so every recognized UUID ZIP is orphaned after a reload. Unknown
 * entries are preserved and the scan is bounded to avoid attacker-controlled work.
 */
export async function pruneExportScratch(): Promise<ExportScratchPruneResult> {
  const scratch = await getExistingScratchDirectory()
  if (scratch === null) return { inspected: 0, removed: 0 }

  let inspected = 0
  let removed = 0
  for await (const [name, handle] of scratch.entries()) {
    if (inspected >= MAX_STARTUP_SCRATCH_ENTRIES) break
    inspected += 1
    if (handle.kind !== 'file' || !isExportScratchName(name)) continue
    try {
      await scratch.removeEntry(name)
      removed += 1
    } catch {
      // Startup recovery is best-effort. A later reload can retry a locked entry.
    }
  }
  return { inspected, removed }
}

export async function materializePreparedExport(
  handle: PreparedExportHandle,
): Promise<PreparedPackage> {
  assertSafeDownloadName(handle.filename)
  if (handle.location === 'memory') {
    if (handle.blob === undefined) throw new Error('Prepared in-memory package is missing.')
    return { blob: handle.blob, filename: handle.filename, sha256: handle.sha256 }
  }
  if (handle.scratchName === undefined) throw new Error('Prepared OPFS package is missing.')
  assertSafeExportScratchName(handle.scratchName)
  const scratch = await getScratchDirectory(false)
  const file = await (await scratch.getFileHandle(handle.scratchName)).getFile()
  if (file.size !== handle.byteLength) throw new Error('Prepared package length changed.')
  return { blob: file, filename: handle.filename, sha256: handle.sha256 }
}

export async function discardPreparedExport(handle: PreparedExportHandle): Promise<void> {
  if (handle.location !== 'opfs' || handle.scratchName === undefined) return
  assertSafeExportScratchName(handle.scratchName)
  const scratch = await getExistingScratchDirectory()
  if (scratch === null) return
  await scratch.removeEntry(handle.scratchName).catch(() => undefined)
}
