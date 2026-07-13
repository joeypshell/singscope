export type StorageErrorCode =
  'corrupt-data' | 'not-found' | 'quota-exceeded' | 'storage-unavailable' | 'validation-failed'

export class SingScopeStorageError extends Error {
  readonly code: StorageErrorCode
  readonly causeValue: unknown

  constructor(code: StorageErrorCode, message: string, causeValue?: unknown) {
    super(message)
    this.name = 'SingScopeStorageError'
    this.code = code
    this.causeValue = causeValue
  }
}

export function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

export function mapStorageError(error: unknown, operation: string): SingScopeStorageError {
  if (error instanceof SingScopeStorageError) return error
  if (isQuotaError(error)) {
    return new SingScopeStorageError(
      'quota-exceeded',
      `${operation} could not finish because local storage is full. Export a backup and free space.`,
      error,
    )
  }
  return new SingScopeStorageError(
    'storage-unavailable',
    `${operation} could not access local storage.`,
    error,
  )
}
