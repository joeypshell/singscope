export const CLEANUP_FORMAT = 'singscope-analysis-report-cleanup' as const
export const CLEANUP_SCHEMA_VERSION = 1 as const
export const CLEANUP_TOKEN_HEADER = 'x-singscope-cleanup-token'
export const REPORT_BUCKET = 'singscope-analysis-reports'

export const EXPIRED_REPORT_BATCH_SIZE = 25
export const ORPHAN_ROOT_BATCH_SIZE = 50
export const ORPHAN_FOLDER_LIST_LIMIT = 10
export const ORPHAN_OBJECT_CHECK_LIMIT = 50
export const MAX_ORPHAN_SCAN_OFFSET = 100_000
export const ORPHAN_GRACE_MILLISECONDS = 24 * 60 * 60 * 1_000

const PACKAGE_DIRECTORY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PACKAGE_FILE_PATTERN = /^[0-9a-f]{64}\.zip$/

export class CleanupConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CleanupConfigurationError'
  }
}

function isStringRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveSupabaseSecretKey(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const namedKeys = environment.SUPABASE_SECRET_KEYS?.trim()
  if (namedKeys) {
    let parsed: unknown
    try {
      parsed = JSON.parse(namedKeys)
    } catch {
      throw new CleanupConfigurationError('SUPABASE_SECRET_KEYS is not valid JSON.')
    }
    if (isStringRecord(parsed)) {
      const defaultKey = parsed.default
      if (typeof defaultKey === 'string' && defaultKey.trim() !== '') return defaultKey
    }
    throw new CleanupConfigurationError(
      'SUPABASE_SECRET_KEYS does not contain a non-empty default key.',
    )
  }

  const singleKey =
    environment.SUPABASE_SECRET_KEY?.trim() ?? environment.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!singleKey) {
    throw new CleanupConfigurationError('No Supabase server secret key is available.')
  }
  return singleKey
}

export function resolveCleanupToken(value: string | undefined): string {
  const token = value?.trim()
  if (token === undefined || token.length < 32 || token.length > 512) {
    throw new CleanupConfigurationError(
      'REPORT_CLEANUP_TOKEN must contain between 32 and 512 characters.',
    )
  }
  return token
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export async function cleanupTokenMatches(
  presented: string | null,
  expected: string,
): Promise<boolean> {
  const [presentedDigest, expectedDigest] = await Promise.all([
    digest(presented ?? ''),
    digest(expected),
  ])
  let difference = presented === null ? 1 : 0
  for (let index = 0; index < expectedDigest.byteLength; index += 1) {
    difference |= (presentedDigest[index] ?? 0) ^ (expectedDigest[index] ?? 0)
  }
  return difference === 0
}

export type DatabaseCleanupTokenVerifier = (presented: string) => Promise<boolean>

export function cleanupTokenFallbackForRuntime(
  supabaseUrl: string | undefined,
  configuredFallback: string | undefined,
): string | undefined {
  if (configuredFallback === undefined || supabaseUrl === undefined) return undefined

  try {
    const url = new URL(supabaseUrl)
    const hostname = url.hostname.toLowerCase()
    const isLocalHostname =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      hostname === 'kong' ||
      hostname.startsWith('supabase_kong_')
    return url.protocol === 'http:' && isLocalHostname ? configuredFallback : undefined
  } catch {
    return undefined
  }
}

/**
 * Hosted deployments omit the local fallback and validate through the
 * service-role-only database RPC. The environment-token path is retained only
 * for local function development where Vault-backed migrations may not be
 * running yet.
 */
export async function authorizeCleanupRequest(
  presented: string | null,
  localFallback: string | undefined,
  verifyDatabaseToken: DatabaseCleanupTokenVerifier,
): Promise<boolean> {
  if (localFallback !== undefined) {
    return await cleanupTokenMatches(presented, resolveCleanupToken(localFallback))
  }

  if (presented === null || presented.length < 32 || presented.length > 512) return false
  return await verifyDatabaseToken(presented)
}

export function isPackageDirectory(value: string): boolean {
  return PACKAGE_DIRECTORY_PATTERN.test(value)
}

export function isExpectedObjectPath(folder: string, fileName: string): boolean {
  return isPackageDirectory(folder) && PACKAGE_FILE_PATTERN.test(fileName)
}

export function splitExpectedObjectPath(
  objectPath: string,
): { readonly folder: string; readonly fileName: string } | null {
  const segments = objectPath.split('/')
  if (segments.length !== 2) return null
  const folder = segments[0]
  const fileName = segments[1]
  if (folder === undefined || fileName === undefined || !isExpectedObjectPath(folder, fileName)) {
    return null
  }
  return { folder, fileName }
}

export function isPastOrphanGrace(createdAt: string | null, now: Date): boolean {
  if (createdAt === null) return false
  const createdAtMilliseconds = Date.parse(createdAt)
  if (!Number.isFinite(createdAtMilliseconds)) return false
  return createdAtMilliseconds <= now.valueOf() - ORPHAN_GRACE_MILLISECONDS
}

export function nextOrphanScanOffset(currentOffset: number, listedRoots: number): number {
  if (
    !Number.isSafeInteger(currentOffset) ||
    currentOffset < 0 ||
    currentOffset > MAX_ORPHAN_SCAN_OFFSET
  ) {
    return 0
  }
  if (listedRoots < ORPHAN_ROOT_BATCH_SIZE) return 0
  const next = currentOffset + ORPHAN_ROOT_BATCH_SIZE
  return next > MAX_ORPHAN_SCAN_OFFSET ? 0 : next
}
