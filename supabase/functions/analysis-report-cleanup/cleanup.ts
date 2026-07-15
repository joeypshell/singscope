import {
  CLEANUP_FORMAT,
  CLEANUP_SCHEMA_VERSION,
  EXPIRED_REPORT_BATCH_SIZE,
  ORPHAN_FOLDER_LIST_LIMIT,
  ORPHAN_OBJECT_CHECK_LIMIT,
  ORPHAN_ROOT_BATCH_SIZE,
  isExpectedObjectPath,
  isPackageDirectory,
  isPastOrphanGrace,
  nextOrphanScanOffset,
  splitExpectedObjectPath,
} from './contract.ts'

export interface ExpiredReport {
  readonly reportId: string
  readonly objectPath: string
}

export interface StorageListEntry {
  readonly name: string
  readonly id: string | null
  readonly createdAt: string | null
}

export interface CleanupBackend {
  claimLease(leaseToken: string): Promise<number | null>
  finishLease(leaseToken: string, nextOffset: number): Promise<boolean>
  listExpiredReports(expiresAtOrBefore: string, limit: number): Promise<readonly ExpiredReport[]>
  removeStorageObject(objectPath: string): Promise<void>
  deleteReportReceipt(reportId: string): Promise<void>
  listStorageRoots(offset: number, limit: number): Promise<readonly StorageListEntry[]>
  listStorageFolder(folder: string, limit: number): Promise<readonly StorageListEntry[]>
  reportReceiptExists(objectPath: string): Promise<boolean>
}

export interface CleanupResult {
  readonly format: typeof CLEANUP_FORMAT
  readonly schemaVersion: typeof CLEANUP_SCHEMA_VERSION
  readonly status: 'already-running' | 'completed' | 'partial'
  readonly expiredObjectsDeleted: number
  readonly expiredReceiptsDeleted: number
  readonly orphanObjectsDeleted: number
  readonly unsafeReceiptPaths: number
  readonly ambiguousFoldersSkipped: number
  readonly operationErrors: number
  readonly nextOrphanScanOffset: number | null
}

function emptyResult(status: CleanupResult['status']): CleanupResult {
  return {
    format: CLEANUP_FORMAT,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    status,
    expiredObjectsDeleted: 0,
    expiredReceiptsDeleted: 0,
    orphanObjectsDeleted: 0,
    unsafeReceiptPaths: 0,
    ambiguousFoldersSkipped: 0,
    operationErrors: 0,
    nextOrphanScanOffset: null,
  }
}

export async function runAnalysisReportCleanup(
  backend: CleanupBackend,
  now: Date,
  leaseToken: string = crypto.randomUUID(),
): Promise<CleanupResult> {
  if (!Number.isFinite(now.valueOf())) throw new TypeError('Cleanup requires a valid date.')

  const claimedOffset = await backend.claimLease(leaseToken)
  if (claimedOffset === null) return emptyResult('already-running')

  let expiredObjectsDeleted = 0
  let expiredReceiptsDeleted = 0
  let orphanObjectsDeleted = 0
  let unsafeReceiptPaths = 0
  let ambiguousFoldersSkipped = 0
  let orphanObjectsChecked = 0
  let operationErrors = 0
  let nextOffset = claimedOffset

  try {
    let expiredReports: readonly ExpiredReport[] = []
    try {
      expiredReports = (
        await backend.listExpiredReports(now.toISOString(), EXPIRED_REPORT_BATCH_SIZE)
      ).slice(0, EXPIRED_REPORT_BATCH_SIZE)
    } catch {
      operationErrors += 1
    }

    for (const report of expiredReports) {
      if (splitExpectedObjectPath(report.objectPath) === null) {
        unsafeReceiptPaths += 1
        operationErrors += 1
        continue
      }
      try {
        await backend.removeStorageObject(report.objectPath)
        expiredObjectsDeleted += 1
      } catch {
        operationErrors += 1
        continue
      }
      try {
        await backend.deleteReportReceipt(report.reportId)
        expiredReceiptsDeleted += 1
      } catch {
        // The object is already gone. Keep the expired receipt so the next run
        // can idempotently retry the Storage removal and database deletion.
        operationErrors += 1
      }
    }

    let roots: readonly StorageListEntry[] | null = null
    try {
      roots = (await backend.listStorageRoots(claimedOffset, ORPHAN_ROOT_BATCH_SIZE)).slice(
        0,
        ORPHAN_ROOT_BATCH_SIZE,
      )
      nextOffset = nextOrphanScanOffset(claimedOffset, roots.length)
    } catch {
      operationErrors += 1
    }

    for (const root of roots ?? []) {
      if (orphanObjectsChecked >= ORPHAN_OBJECT_CHECK_LIMIT) break
      if (root.id !== null || !isPackageDirectory(root.name)) continue

      let entries: readonly StorageListEntry[]
      try {
        entries = await backend.listStorageFolder(root.name, ORPHAN_FOLDER_LIST_LIMIT)
      } catch {
        operationErrors += 1
        continue
      }

      // A failed concurrent write can leave more than one hash-named object in
      // a UUID folder. Validate and reconcile each aged object independently;
      // never infer safety merely from there being one entry.
      for (const entry of entries) {
        if (orphanObjectsChecked >= ORPHAN_OBJECT_CHECK_LIMIT) break
        if (!entry.id || !isExpectedObjectPath(root.name, entry.name)) {
          ambiguousFoldersSkipped += 1
          continue
        }
        if (!isPastOrphanGrace(entry.createdAt, now)) continue
        orphanObjectsChecked += 1
        const objectPath = `${root.name}/${entry.name}`
        let receiptExists: boolean
        try {
          receiptExists = await backend.reportReceiptExists(objectPath)
        } catch {
          operationErrors += 1
          continue
        }
        if (receiptExists) continue

        try {
          await backend.removeStorageObject(objectPath)
          orphanObjectsDeleted += 1
        } catch {
          operationErrors += 1
        }
      }
    }
  } finally {
    try {
      if (!(await backend.finishLease(leaseToken, nextOffset))) operationErrors += 1
    } catch {
      operationErrors += 1
    }
  }

  return {
    format: CLEANUP_FORMAT,
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    status: operationErrors === 0 ? 'completed' : 'partial',
    expiredObjectsDeleted,
    expiredReceiptsDeleted,
    orphanObjectsDeleted,
    unsafeReceiptPaths,
    ambiguousFoldersSkipped,
    operationErrors,
    nextOrphanScanOffset: nextOffset,
  }
}
