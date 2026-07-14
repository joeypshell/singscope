import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBackupInput } from './backup-package'
import {
  discardPreparedExport,
  ExportPreparer,
  pruneExportScratch,
  type PreparedExportHandle,
} from './preparer'
import type { ExportWorkerRequest } from './worker-protocol'

const EMPTY_BACKUP: ProjectBackupInput = {
  projectId: 'project-1',
  project: {},
  references: [],
  targets: [],
  sections: [],
  takes: [],
  settings: {},
}

interface ScratchHarness {
  removed: string[]
  install: () => void
}

function scratchHarness(
  entries: readonly { name: string; kind: FileSystemHandleKind }[] = [],
): ScratchHarness {
  const removed: string[] = []
  const scratch = {
    async *entries() {
      await Promise.resolve()
      for (const entry of entries) {
        yield [entry.name, { name: entry.name, kind: entry.kind }] as const
      }
    },
    removeEntry(name: string) {
      removed.push(name)
      return Promise.resolve()
    },
  } as unknown as FileSystemDirectoryHandle
  const app = {
    getDirectoryHandle(name: string) {
      expect(name).toBe('export-scratch')
      return Promise.resolve(scratch)
    },
  } as unknown as FileSystemDirectoryHandle
  const root = {
    getDirectoryHandle(name: string) {
      expect(name).toBe('singscope')
      return Promise.resolve(app)
    },
  } as unknown as FileSystemDirectoryHandle

  return {
    removed,
    install() {
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { getDirectory: () => Promise.resolve(root) },
      })
    },
  }
}

class FakeWorker {
  readonly posted: ExportWorkerRequest[] = []
  terminated = false

  addEventListener(): void {
    // The lifecycle tests drive cancellation directly and do not emit worker events.
  }

  postMessage(request: ExportWorkerRequest): void {
    this.posted.push(request)
  }

  terminate(): void {
    this.terminated = true
  }
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'storage')
  vi.restoreAllMocks()
})

describe('export scratch lifecycle', () => {
  it('prunes only bounded, recognized UUID ZIP files from an earlier page lifetime', async () => {
    const recognized = '00000000-0000-4000-8000-000000000001.zip'
    const directoryLookalike = '00000000-0000-4000-8000-000000000002.zip'
    const harness = scratchHarness([
      { name: recognized, kind: 'file' },
      { name: directoryLookalike, kind: 'directory' },
      { name: 'not-a-uuid.zip', kind: 'file' },
      { name: '../assets/recording.bin', kind: 'file' },
      ...Array.from({ length: 253 }, (_, index) => ({
        name: `unknown-${index}.tmp`,
        kind: 'file' as const,
      })),
    ])
    harness.install()

    await expect(pruneExportScratch()).resolves.toEqual({ inspected: 256, removed: 1 })
    expect(harness.removed).toEqual([recognized])
  })

  it('makes a pending request scratch name known and removes it when cancelled', async () => {
    const harness = scratchHarness()
    harness.install()
    const worker = new FakeWorker()
    const preparer = new ExportPreparer(worker as unknown as Worker)

    const pending = preparer.prepareBackup(EMPTY_BACKUP)
    expect(worker.posted).toHaveLength(1)
    const request = worker.posted[0]
    expect(request?.scratchName).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i,
    )

    preparer.terminate()

    await expect(pending).rejects.toThrow('Export preparation was cancelled.')
    await vi.waitFor(() => expect(harness.removed).toEqual([request?.scratchName]))
    expect(worker.terminated).toBe(true)
  })

  it('refuses to discard an unrecognized OPFS entry name', async () => {
    const forged: PreparedExportHandle = {
      filename: 'singscope-project-backup.zip',
      sha256: '0'.repeat(64),
      byteLength: 1,
      location: 'opfs',
      scratchName: '../assets/recording.bin',
    }

    await expect(discardPreparedExport(forged)).rejects.toThrow(
      'Prepared OPFS package name was invalid.',
    )
  })
})
