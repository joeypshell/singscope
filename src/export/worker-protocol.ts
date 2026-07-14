import type { AnalysisDebugPackageInput } from './analysis-debug-package'
import type { FeedbackPackageInput } from './feedback-package'
import type { ProjectBackupInput } from './backup-package'
import type { AnalysisDebugManifest, FeedbackManifest } from './schemas'

export const EXPORT_SCRATCH_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i

export function isExportScratchName(name: string): boolean {
  return EXPORT_SCRATCH_NAME_PATTERN.test(name)
}

export type ExportWorkerRequest =
  | { id: string; scratchName: string; kind: 'feedback'; input: FeedbackPackageInput }
  | { id: string; scratchName: string; kind: 'backup'; input: ProjectBackupInput }
  | {
      id: string
      scratchName: string
      kind: 'analysis-debug'
      input: AnalysisDebugPackageInput
    }

export type ExportWorkerResponse =
  | {
      id: string
      ok: true
      filename: string
      sha256: string
      byteLength: number
      location: 'memory' | 'opfs'
      blob?: Blob
      scratchName?: string
      feedbackManifest?: FeedbackManifest
      analysisDebugManifest?: AnalysisDebugManifest
    }
  | { id: string; ok: false; error: string }
