export const REPORT_FORMAT = 'singscope-analysis-report-receipt' as const
export const REPORT_SCHEMA_VERSION = 1 as const
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
export const REPORT_BUCKET = 'singscope-analysis-reports'
export const DEFAULT_ALLOWED_ORIGIN = 'https://joeypshell.github.io'
export const REPORT_TICKET_REQUEST_FORMAT = 'singscope-analysis-report-ticket-request' as const
export const REPORT_TICKET_FORMAT = 'singscope-analysis-report-ticket' as const
export const REPORT_TICKET_SCHEMA_VERSION = 1 as const
export const MAX_TICKET_REQUEST_BYTES = 256

const PACKAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/

export const ALLOWED_REQUEST_HEADERS = new Set([
  'apikey',
  'cache-control',
  'content-type',
  'pragma',
  'x-client-info',
  'x-singscope-package-id',
  'x-singscope-package-bytes',
  'x-singscope-package-sha256',
  'x-singscope-report-proof',
  'x-singscope-report-ticket',
  'x-singscope-schema-version',
])

export class RequestProblem extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RequestProblem'
    this.status = status
    this.code = code
  }
}

export interface ValidatedReportRequest {
  readonly packageId: string
  readonly packageSha256: string
  readonly packageBytes: number
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION
  readonly declaredLength: number | null
}

export interface StoredReportIdentity {
  readonly package_id: string
  readonly schema_version: number
  readonly package_sha256: string
  readonly package_bytes: number
  readonly object_path: string
}

export interface ServiceErrorIdentity {
  readonly code?: string
  readonly message: string
}

function headerValue(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim()
  if (!value) {
    throw new RequestProblem(400, 'MISSING_HEADER', `Missing required ${name} header.`)
  }
  return value
}

export function allowedOriginFromValue(value: string | undefined): string {
  const configured = value?.trim()
  const candidate =
    configured === undefined || configured === '' ? DEFAULT_ALLOWED_ORIGIN : configured
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('REPORT_ALLOWED_ORIGIN must be a valid serialized HTTP(S) origin.')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.origin !== candidate ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('REPORT_ALLOWED_ORIGIN must be an exact origin without a path.')
  }
  return parsed.origin
}

export function assertAllowedOrigin(request: Request, allowedOrigin: string): void {
  if (request.headers.get('origin') !== allowedOrigin) {
    throw new RequestProblem(403, 'ORIGIN_NOT_ALLOWED', 'This request origin is not allowed.')
  }
}

export function validatePreflight(request: Request): void {
  const requestedMethod = request.headers.get('access-control-request-method')
  if (requestedMethod !== null && requestedMethod.toUpperCase() !== 'POST') {
    throw new RequestProblem(405, 'METHOD_NOT_ALLOWED', 'Only POST reports are allowed.')
  }

  const requestedHeaders = request.headers.get('access-control-request-headers')
  if (requestedHeaders === null || requestedHeaders.trim() === '') return
  for (const requestedHeader of requestedHeaders.split(',')) {
    const normalized = requestedHeader.trim().toLowerCase()
    if (normalized === '' || !ALLOWED_REQUEST_HEADERS.has(normalized)) {
      throw new RequestProblem(
        400,
        'HEADER_NOT_ALLOWED',
        'The preflight requested an unsupported header.',
      )
    }
  }
}

export function requestMediaType(headers: Headers): string {
  return headerValue(headers, 'Content-Type').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export function validateReportIdentityHeaders(headers: Headers): ValidatedReportRequest {
  const packageId = headerValue(headers, 'X-SingScope-Package-Id').toLowerCase()
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    throw new RequestProblem(400, 'INVALID_PACKAGE_ID', 'The package ID must be an RFC UUID.')
  }

  const packageSha256 = headerValue(headers, 'X-SingScope-Package-Sha256')
  if (!SHA256_PATTERN.test(packageSha256)) {
    throw new RequestProblem(
      400,
      'INVALID_PACKAGE_SHA256',
      'The package digest must be 64 lowercase hexadecimal characters.',
    )
  }

  if (headerValue(headers, 'X-SingScope-Schema-Version') !== String(REPORT_SCHEMA_VERSION)) {
    throw new RequestProblem(
      422,
      'UNSUPPORTED_SCHEMA_VERSION',
      'Unsupported report schema version.',
    )
  }

  const rawPackageBytes = headerValue(headers, 'X-SingScope-Package-Bytes')
  if (!DECIMAL_PATTERN.test(rawPackageBytes)) {
    throw new RequestProblem(400, 'INVALID_PACKAGE_BYTES', 'The package byte length is invalid.')
  }
  const packageBytes = Number(rawPackageBytes)
  if (!Number.isSafeInteger(packageBytes) || packageBytes < 4) {
    throw new RequestProblem(400, 'INVALID_PACKAGE_BYTES', 'The package byte length is invalid.')
  }
  if (packageBytes > MAX_PACKAGE_BYTES) {
    throw new RequestProblem(413, 'PACKAGE_TOO_LARGE', 'The report exceeds the 16 MiB limit.')
  }

  return {
    packageId,
    packageSha256,
    packageBytes,
    schemaVersion: REPORT_SCHEMA_VERSION,
    declaredLength: null,
  }
}

export function validateTicketRequestHeaders(headers: Headers): ValidatedReportRequest {
  if (requestMediaType(headers) !== 'application/json') {
    throw new RequestProblem(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Ticket requests must be application/json.',
    )
  }
  return validateReportIdentityHeaders(headers)
}

export function validateReportHeaders(headers: Headers): ValidatedReportRequest {
  if (requestMediaType(headers) !== 'application/zip') {
    throw new RequestProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Reports must be application/zip.')
  }
  const identity = validateReportIdentityHeaders(headers)
  const rawLength = headers.get('content-length')?.trim()
  if (rawLength === undefined || rawLength === '') return identity
  if (!DECIMAL_PATTERN.test(rawLength)) {
    throw new RequestProblem(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid.')
  }
  const declaredLength = Number(rawLength)
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_PACKAGE_BYTES) {
    throw new RequestProblem(413, 'PACKAGE_TOO_LARGE', 'The report exceeds the 16 MiB limit.')
  }
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 1 ||
    declaredLength !== identity.packageBytes
  ) {
    throw new RequestProblem(
      400,
      'CONTENT_LENGTH_MISMATCH',
      'Content-Length does not match the declared package byte length.',
    )
  }
  return { ...identity, declaredLength }
}

export async function readTicketRequest(request: Request): Promise<void> {
  if (request.body === null) {
    throw new RequestProblem(400, 'INVALID_TICKET_REQUEST', 'The ticket request is invalid.')
  }
  const bytes = await readBodyWithLimit(request, MAX_TICKET_REQUEST_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new RequestProblem(400, 'INVALID_TICKET_REQUEST', 'The ticket request is invalid.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RequestProblem(400, 'INVALID_TICKET_REQUEST', 'The ticket request is invalid.')
  }
  const record = parsed as Readonly<
    Record<string, unknown> & { format?: unknown; schemaVersion?: unknown }
  >
  if (
    Object.keys(record).length !== 2 ||
    record.format !== REPORT_TICKET_REQUEST_FORMAT ||
    record.schemaVersion !== REPORT_TICKET_SCHEMA_VERSION
  ) {
    throw new RequestProblem(400, 'INVALID_TICKET_REQUEST', 'The ticket request is invalid.')
  }
}

export async function readBodyWithLimit(
  request: Request,
  maxBytes = MAX_PACKAGE_BYTES,
): Promise<Uint8Array> {
  if (request.body === null) {
    throw new RequestProblem(400, 'EMPTY_PACKAGE', 'The report package is empty.')
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('package size limit exceeded')
        throw new RequestProblem(413, 'PACKAGE_TOO_LARGE', 'The report exceeds the 16 MiB limit.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  if (total === 0) {
    throw new RequestProblem(400, 'EMPTY_PACKAGE', 'The report package is empty.')
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export function assertZipSignature(bytes: Uint8Array): void {
  const signature =
    bytes.byteLength >= 4
      ? `${bytes[0]?.toString(16).padStart(2, '0')}${bytes[1]
          ?.toString(16)
          .padStart(2, '0')}${bytes[2]?.toString(16).padStart(2, '0')}${bytes[3]
          ?.toString(16)
          .padStart(2, '0')}`
      : ''
  if (signature !== '504b0304' && signature !== '504b0506' && signature !== '504b0708') {
    throw new RequestProblem(422, 'INVALID_ZIP', 'The report body is not a ZIP package.')
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput.buffer))
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')
}

export function objectPath(packageId: string, packageSha256: string): string {
  return `${packageId}/${packageSha256}.zip`
}

export function storedIdentityMatches(
  stored: StoredReportIdentity,
  request: ValidatedReportRequest,
  packageBytes = request.packageBytes,
): boolean {
  return (
    stored.package_id === request.packageId &&
    stored.schema_version === request.schemaVersion &&
    stored.package_sha256 === request.packageSha256 &&
    stored.package_bytes === packageBytes &&
    stored.object_path === objectPath(request.packageId, request.packageSha256)
  )
}

export function isDailyReportQuotaError(error: ServiceErrorIdentity | null): boolean {
  return error?.code === 'P0001' && error.message.includes('SINGSCOPE_REPORT_DAILY_QUOTA_EXCEEDED')
}

function isStringRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveSupabaseSecretKey(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const { SUPABASE_SECRET_KEYS, SUPABASE_SECRET_KEY, SUPABASE_SERVICE_ROLE_KEY } = environment
  const namedKeys = SUPABASE_SECRET_KEYS?.trim()
  if (namedKeys) {
    let parsed: unknown
    try {
      parsed = JSON.parse(namedKeys)
    } catch {
      throw new Error('SUPABASE_SECRET_KEYS is not valid JSON.')
    }
    if (isStringRecord(parsed)) {
      const { default: defaultKey } = parsed
      if (typeof defaultKey === 'string' && defaultKey.trim() !== '') return defaultKey
    }
    throw new Error('SUPABASE_SECRET_KEYS does not contain a non-empty default key.')
  }

  const singleKey = SUPABASE_SECRET_KEY?.trim() ?? SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!singleKey) throw new Error('No Supabase server secret key is available.')
  return singleKey
}
