/// <reference lib="webworker" />

import { createProjectBackup } from '../export/backup-package'
import { createFeedbackPackage } from '../export/feedback-package'
import type { ExportWorkerRequest, ExportWorkerResponse } from '../export/worker-protocol'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

async function writeScratch(name: string, blob: Blob): Promise<boolean> {
  const candidate: unknown = Reflect.get(navigator, 'storage')
  if (typeof candidate !== 'object' || candidate === null || !('getDirectory' in candidate)) {
    return false
  }
  const storage = candidate as { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  if (typeof storage.getDirectory !== 'function') return false
  const root = await storage.getDirectory()
  const app = await root.getDirectoryHandle('singscope', { create: true })
  const scratch = await app.getDirectoryHandle('export-scratch', { create: true })
  const file = await scratch.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
    return true
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

workerScope.addEventListener('message', (event: MessageEvent<ExportWorkerRequest>) => {
  void (async () => {
    const request = event.data
    try {
      const result =
        request.kind === 'feedback'
          ? await createFeedbackPackage(request.input)
          : await createProjectBackup(request.input)
      const feedbackManifest =
        result.manifest.format === 'singscope-feedback-package' ? result.manifest : null
      const scratchName = `${request.id}.zip`
      const stored = await writeScratch(scratchName, result.blob).catch(() => false)
      const response: ExportWorkerResponse = stored
        ? {
            id: request.id,
            ok: true,
            filename: result.filename,
            sha256: result.sha256,
            byteLength: result.blob.size,
            location: 'opfs',
            scratchName,
            ...(feedbackManifest ? { feedbackManifest } : {}),
          }
        : {
            id: request.id,
            ok: true,
            filename: result.filename,
            sha256: result.sha256,
            byteLength: result.blob.size,
            location: 'memory',
            blob: result.blob,
            ...(feedbackManifest ? { feedbackManifest } : {}),
          }
      workerScope.postMessage(response)
    } catch (error) {
      const response: ExportWorkerResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Package preparation failed.',
      }
      workerScope.postMessage(response)
    }
  })()
})

export {}
