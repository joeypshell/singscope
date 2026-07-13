import type { FeedbackPackageInput } from './feedback-package'
import type { ProjectBackupInput } from './backup-package'
import type { FeedbackManifest } from './schemas'

export type ExportWorkerRequest =
  | { id: string; kind: 'feedback'; input: FeedbackPackageInput }
  | { id: string; kind: 'backup'; input: ProjectBackupInput }

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
    }
  | { id: string; ok: false; error: string }
