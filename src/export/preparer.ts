import type { FeedbackPackageInput } from './feedback-package'
import type { ProjectBackupInput } from './backup-package'
import { assertSafeDownloadName } from './safety'
import type { PreparedPackage } from './share'
import type { FeedbackManifest } from './schemas'
import type { ExportWorkerRequest, ExportWorkerResponse } from './worker-protocol'

interface PendingJob {
  resolve: (value: ExportWorkerResponse & { ok: true }) => void
  reject: (reason: Error) => void
}

export interface PreparedExportHandle {
  filename: string
  sha256: string
  byteLength: number
  location: 'memory' | 'opfs'
  blob?: Blob
  scratchName?: string
  feedbackManifest?: FeedbackManifest
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
      else job.reject(new Error(event.data.error))
    })
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'Export worker failed.')
      for (const job of this.pending.values()) job.reject(error)
      this.pending.clear()
    })
  }

  prepareFeedback(input: FeedbackPackageInput): Promise<PreparedExportHandle> {
    return this.prepare({ id: crypto.randomUUID(), kind: 'feedback', input })
  }

  prepareBackup(input: ProjectBackupInput): Promise<PreparedExportHandle> {
    return this.prepare({ id: crypto.randomUUID(), kind: 'backup', input })
  }

  terminate(): void {
    this.worker.terminate()
    const error = new Error('Export preparation was cancelled.')
    for (const job of this.pending.values()) job.reject(error)
    this.pending.clear()
  }

  private prepare(request: ExportWorkerRequest): Promise<PreparedExportHandle> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      this.worker.postMessage(request)
    })
  }
}

async function getScratchDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const app = await root.getDirectoryHandle('singscope', { create: true })
  return app.getDirectoryHandle('export-scratch', { create: true })
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
  const scratch = await getScratchDirectory()
  const file = await (await scratch.getFileHandle(handle.scratchName)).getFile()
  if (file.size !== handle.byteLength) throw new Error('Prepared package length changed.')
  return { blob: file, filename: handle.filename, sha256: handle.sha256 }
}

export async function discardPreparedExport(handle: PreparedExportHandle): Promise<void> {
  if (handle.location !== 'opfs' || handle.scratchName === undefined) return
  const scratch = await getScratchDirectory()
  await scratch.removeEntry(handle.scratchName).catch(() => undefined)
}
