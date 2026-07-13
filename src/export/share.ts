import { IPHONE_LIMITS } from './limits'
import { assertSafeDownloadName } from './safety'

export interface PreparedPackage {
  blob: Blob
  filename: string
  sha256: string
}

export function canSharePreparedPackage(prepared: PreparedPackage): boolean {
  if (prepared.blob.size > IPHONE_LIMITS.sharePackageBytes) return false
  if (typeof navigator.share !== 'function' || typeof File === 'undefined') return false
  const file = new File([prepared.blob], assertSafeDownloadName(prepared.filename), {
    type: 'application/zip',
  })
  const optionalNavigator = navigator as unknown as {
    canShare?: (data?: ShareData) => boolean
  }
  return optionalNavigator.canShare?.({ files: [file] }) ?? true
}

export async function sharePreparedPackage(prepared: PreparedPackage): Promise<void> {
  if (!canSharePreparedPackage(prepared)) {
    throw new Error('This package cannot use the Share Sheet. Use Save to Files instead.')
  }
  const file = new File([prepared.blob], assertSafeDownloadName(prepared.filename), {
    type: 'application/zip',
  })
  await navigator.share({ files: [file], title: 'SingScope package' })
}

export function savePreparedPackage(prepared: PreparedPackage): void {
  assertSafeDownloadName(prepared.filename)
  if (prepared.blob.size > IPHONE_LIMITS.savedPackageBytes) {
    throw new Error('This package exceeds the 160 MiB Save to Files limit.')
  }
  const url = URL.createObjectURL(prepared.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = prepared.filename
  anchor.rel = 'noopener'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
