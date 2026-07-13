import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const UNSAFE_CSV_START = /^[=+\-@\t\r]/
const SAFE_DOWNLOAD_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function neutralizeCsvFormula(value: string): string {
  return UNSAFE_CSV_START.test(value) ? `'${value}` : value
}

export function csvCell(value: boolean | number | string | null): string {
  if (value === null) return ''
  const raw = neutralizeCsvFormula(String(value))
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw
}

export function createCsv(
  headers: readonly string[],
  rows: readonly (readonly (boolean | number | string | null)[])[],
): string {
  const header = headers.map(csvCell).join(',')
  const body = rows.map((row) => row.map(csvCell).join(','))
  return `${[header, ...body].join('\r\n')}\r\n`
}

export function assertSafeDownloadName(name: string): string {
  if (!SAFE_DOWNLOAD_NAME.test(name) || name.includes('..')) {
    throw new Error('The download filename was not safe.')
  }
  return name
}

export function assertSafeArchivePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 160 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe archive path: ${path || '(empty)'}`)
  }
  return path
}

export function hashBytesIncrementally(bytes: Uint8Array, chunkBytes = 1024 * 1024): string {
  const hash = sha256.create()
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    hash.update(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)))
  }
  return bytesToHex(hash.digest())
}

export function validateJsonShape(
  value: unknown,
  options: { maxDepth?: number; maxArrayLength?: number; maxObjectKeys?: number } = {},
): void {
  const maxDepth = options.maxDepth ?? 32
  const maxArrayLength = options.maxArrayLength ?? 500_000
  const maxObjectKeys = options.maxObjectKeys ?? 2_000
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.depth > maxDepth) throw new Error('Imported JSON exceeded the nesting limit.')
    if (Array.isArray(current.value)) {
      if (current.value.length > maxArrayLength) {
        throw new Error('Imported JSON exceeded the array-length limit.')
      }
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 })
    } else if (typeof current.value === 'object' && current.value !== null) {
      const entries = Object.entries(current.value)
      if (entries.length > maxObjectKeys) {
        throw new Error('Imported JSON exceeded the object-key limit.')
      }
      for (const [, child] of entries) stack.push({ value: child, depth: current.depth + 1 })
    } else if (
      current.value !== null &&
      typeof current.value !== 'string' &&
      typeof current.value !== 'number' &&
      typeof current.value !== 'boolean'
    ) {
      throw new Error('Imported JSON contained an unsupported value.')
    }
  }
}
