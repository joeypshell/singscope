import { describe, expect, it } from 'vitest'

import {
  type CleanupBackend,
  type ExpiredReport,
  type StorageListEntry,
  runAnalysisReportCleanup,
} from './cleanup.ts'

const NOW = new Date('2026-07-14T20:00:00.000Z')
const FOLDER_A = '123e4567-e89b-42d3-a456-426614174000'
const FOLDER_B = '223e4567-e89b-42d3-a456-426614174000'
const FILE_A = `${'a'.repeat(64)}.zip`
const FILE_B = `${'b'.repeat(64)}.zip`
const PATH_A = `${FOLDER_A}/${FILE_A}`
const PATH_B = `${FOLDER_B}/${FILE_B}`
const OLD = '2026-07-12T00:00:00.000Z'

class FakeBackend implements CleanupBackend {
  claimedOffset: number | null = 0
  expired: readonly ExpiredReport[] = []
  roots: readonly StorageListEntry[] = []
  readonly folders = new Map<string, readonly StorageListEntry[]>()
  readonly receiptPaths = new Set<string>()
  readonly removeFailures = new Set<string>()
  readonly events: string[] = []
  failExpiredList = false
  failRootList = false
  finishResult = true

  async claimLease(leaseToken: string): Promise<number | null> {
    this.events.push(`claim:${leaseToken}`)
    return await Promise.resolve(this.claimedOffset)
  }

  async finishLease(leaseToken: string, nextOffset: number): Promise<boolean> {
    this.events.push(`finish:${leaseToken}:${nextOffset}`)
    return await Promise.resolve(this.finishResult)
  }

  async listExpiredReports(): Promise<readonly ExpiredReport[]> {
    if (this.failExpiredList) throw new Error('expired unavailable')
    return await Promise.resolve(this.expired)
  }

  async removeStorageObject(objectPath: string): Promise<void> {
    this.events.push(`remove:${objectPath}`)
    if (this.removeFailures.has(objectPath)) throw new Error('remove failed')
    await Promise.resolve()
  }

  async deleteReportReceipt(reportId: string): Promise<void> {
    this.events.push(`delete:${reportId}`)
    await Promise.resolve()
  }

  async listStorageRoots(): Promise<readonly StorageListEntry[]> {
    if (this.failRootList) throw new Error('root list unavailable')
    return await Promise.resolve(this.roots)
  }

  async listStorageFolder(folder: string): Promise<readonly StorageListEntry[]> {
    return await Promise.resolve(this.folders.get(folder) ?? [])
  }

  async reportReceiptExists(objectPath: string): Promise<boolean> {
    return await Promise.resolve(this.receiptPaths.has(objectPath))
  }
}

function folder(name: string): StorageListEntry {
  return { name, id: null, createdAt: null }
}

function file(name: string, createdAt = OLD): StorageListEntry {
  return { name, id: 'storage-object-id', createdAt }
}

describe('runAnalysisReportCleanup', () => {
  it('deletes expired Storage objects before rows and removes old, unreferenced objects', async () => {
    const backend = new FakeBackend()
    backend.expired = [{ reportId: 'report-a', objectPath: PATH_A }]
    backend.roots = [folder(FOLDER_B)]
    backend.folders.set(FOLDER_B, [file(FILE_B)])

    const result = await runAnalysisReportCleanup(backend, NOW, 'lease-a')

    expect(result).toMatchObject({
      status: 'completed',
      expiredObjectsDeleted: 1,
      expiredReceiptsDeleted: 1,
      orphanObjectsDeleted: 1,
      operationErrors: 0,
      nextOrphanScanOffset: 0,
    })
    expect(backend.events).toEqual([
      'claim:lease-a',
      `remove:${PATH_A}`,
      'delete:report-a',
      `remove:${PATH_B}`,
      'finish:lease-a:0',
    ])
  })

  it('keeps the receipt when its Storage deletion fails', async () => {
    const backend = new FakeBackend()
    backend.expired = [{ reportId: 'report-a', objectPath: PATH_A }]
    backend.removeFailures.add(PATH_A)

    const result = await runAnalysisReportCleanup(backend, NOW, 'lease-b')

    expect(result.status).toBe('partial')
    expect(result.expiredReceiptsDeleted).toBe(0)
    expect(result.operationErrors).toBe(1)
    expect(backend.events).not.toContain('delete:report-a')
    expect(backend.events.at(-1)).toBe('finish:lease-b:0')
  })

  it('reconciles multiple aged objects independently and keeps recent or referenced files', async () => {
    const recentFolder = '323e4567-e89b-42d3-a456-426614174000'
    const referencedFolder = '423e4567-e89b-42d3-a456-426614174000'
    const recentFile = `${'c'.repeat(64)}.zip`
    const referencedFile = `${'d'.repeat(64)}.zip`
    const referencedPath = `${referencedFolder}/${referencedFile}`
    const backend = new FakeBackend()
    backend.expired = [{ reportId: 'unsafe', objectPath: '../unexpected.zip' }]
    backend.roots = [folder(FOLDER_A), folder(recentFolder), folder(referencedFolder)]
    backend.folders.set(FOLDER_A, [file(FILE_A), file(FILE_B)])
    backend.folders.set(recentFolder, [file(recentFile, '2026-07-14T19:30:00.000Z')])
    backend.folders.set(referencedFolder, [file(referencedFile)])
    backend.receiptPaths.add(referencedPath)

    const result = await runAnalysisReportCleanup(backend, NOW, 'lease-c')

    expect(result).toMatchObject({
      status: 'partial',
      unsafeReceiptPaths: 1,
      ambiguousFoldersSkipped: 0,
      orphanObjectsDeleted: 2,
      operationErrors: 1,
    })
    expect(backend.events.filter((event) => event.startsWith('remove:'))).toEqual([
      `remove:${PATH_A}`,
      `remove:${FOLDER_A}/${FILE_B}`,
    ])
  })

  it('returns idempotently when another invocation holds the lease', async () => {
    const backend = new FakeBackend()
    backend.claimedOffset = null

    const result = await runAnalysisReportCleanup(backend, NOW, 'lease-d')

    expect(result.status).toBe('already-running')
    expect(backend.events).toEqual(['claim:lease-d'])
  })

  it('releases the lease and reports partial progress when bounded list operations fail', async () => {
    const backend = new FakeBackend()
    backend.claimedOffset = 50
    backend.failExpiredList = true
    backend.failRootList = true

    const result = await runAnalysisReportCleanup(backend, NOW, 'lease-e')

    expect(result).toMatchObject({
      status: 'partial',
      operationErrors: 2,
      nextOrphanScanOffset: 50,
    })
    expect(backend.events.at(-1)).toBe('finish:lease-e:50')
  })
})
