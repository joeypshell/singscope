/// <reference lib="webworker" />

import { createAnalysisDebugPackage } from '../export/analysis-debug-package'
import { createProjectBackup } from '../export/backup-package'
import { createFeedbackPackage } from '../export/feedback-package'
import {
  isExportScratchName,
  type ExportWorkerRequest,
  type ExportWorkerResponse,
} from '../export/worker-protocol'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

async function writeScratch(name: string, blob: Blob): Promise<boolean> {
  if (!isExportScratchName(name)) {
    throw new Error('Export scratch name was invalid.')
  }
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
  let writable: FileSystemWritableFileStream | null = null
  try {
    writable = await file.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch (error) {
    if (writable !== null) await writable.abort().catch(() => undefined)
    await scratch.removeEntry(name).catch(() => undefined)
    throw error
  }
}

workerScope.addEventListener('message', (event: MessageEvent<ExportWorkerRequest>) => {
  void (async () => {
    const request = event.data
    try {
      if (!isExportScratchName(request.scratchName)) {
        throw new Error('Export scratch name was invalid.')
      }
      const result =
        request.kind === 'feedback'
          ? await createFeedbackPackage(request.input)
          : request.kind === 'backup'
            ? await createProjectBackup(request.input)
            : await createAnalysisDebugPackage(request.input)
      const feedbackManifest =
        result.manifest.format === 'singscope-feedback-package' ? result.manifest : null
      const analysisDebugManifest =
        result.manifest.format === 'singscope-analysis-debug-package' ? result.manifest : null
      const { scratchName } = request
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
            ...(analysisDebugManifest ? { analysisDebugManifest } : {}),
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
            ...(analysisDebugManifest ? { analysisDebugManifest } : {}),
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
