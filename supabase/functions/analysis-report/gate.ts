import {
  REPORT_SCHEMA_VERSION,
  REPORT_TICKET_FORMAT,
  REPORT_TICKET_SCHEMA_VERSION,
  RequestProblem,
  type ValidatedReportRequest,
} from './contract.ts'

export const REPORT_PROOF_DIFFICULTY = 14
export const REPORT_TICKET_TTL_SECONDS = 120
export const MAX_REPORT_PROOF_NONCE = 8_388_607

const MIN_PROOF_DIFFICULTY = 4
const MAX_PROOF_DIFFICULTY = 20
const MAX_TICKET_CHARACTERS = 1_600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/
const encoder = new TextEncoder()
const HKDF_SALT = encoder.encode('SingScope analysis report gate v1')
const HKDF_INFO = encoder.encode('short-lived ticket HMAC signing')

export interface ReportTicketPayload {
  readonly version: typeof REPORT_TICKET_SCHEMA_VERSION
  readonly ticketId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly packageId: string
  readonly packageSha256: string
  readonly packageBytes: number
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION
  readonly difficulty: number
}

export interface ReportTicketResponse {
  readonly format: typeof REPORT_TICKET_FORMAT
  readonly schemaVersion: typeof REPORT_TICKET_SCHEMA_VERSION
  readonly ticket: string
  readonly difficulty: number
  readonly expiresAt: string
}

interface TicketIssuerOptions {
  readonly now?: Date | undefined
  readonly ticketId?: string | undefined
  readonly difficulty?: number | undefined
}

function reportTicketProblem(code = 'REPORT_TICKET_INVALID'): RequestProblem {
  return new RequestProblem(
    403,
    code,
    code === 'REPORT_TICKET_EXPIRED'
      ? 'The report ticket expired. Request a new ticket and retry.'
      : 'The report ticket or proof is invalid.',
  )
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) throw reportTicketProblem()
  const remainder = value.length % 4
  if (remainder === 1) throw reportTicketProblem()
  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat(
    remainder === 0 ? 0 : 4 - remainder,
  )}`
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw reportTicketProblem()
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function signingKey(serverSecret: string): Promise<CryptoKey> {
  const secretBytes = encoder.encode(serverSecret)
  if (secretBytes.byteLength < 32) {
    throw new Error('The Supabase server key is too short for ticket-key derivation.')
  }
  const material = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey'])
  return await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

function parsePayload(bytes: Uint8Array): ReportTicketPayload {
  let candidate: unknown
  try {
    candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw reportTicketProblem()
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw reportTicketProblem()
  }
  const record = candidate as Readonly<Record<string, unknown>>
  const expectedKeys = [
    'difficulty',
    'expiresAt',
    'issuedAt',
    'packageBytes',
    'packageId',
    'packageSha256',
    'schemaVersion',
    'ticketId',
    'version',
  ]
  if (Object.keys(record).sort().join(',') !== expectedKeys.join(',')) {
    throw reportTicketProblem()
  }
  const {
    version,
    ticketId,
    issuedAt,
    expiresAt,
    packageId,
    packageSha256,
    packageBytes,
    schemaVersion,
    difficulty,
  } = record
  if (
    version !== REPORT_TICKET_SCHEMA_VERSION ||
    typeof ticketId !== 'string' ||
    !UUID_PATTERN.test(ticketId) ||
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt - issuedAt !== REPORT_TICKET_TTL_SECONDS ||
    typeof packageId !== 'string' ||
    !UUID_PATTERN.test(packageId) ||
    typeof packageSha256 !== 'string' ||
    !SHA256_PATTERN.test(packageSha256) ||
    typeof packageBytes !== 'number' ||
    !Number.isSafeInteger(packageBytes) ||
    packageBytes < 4 ||
    typeof schemaVersion !== 'number' ||
    schemaVersion !== REPORT_SCHEMA_VERSION ||
    typeof difficulty !== 'number' ||
    !Number.isInteger(difficulty) ||
    difficulty < MIN_PROOF_DIFFICULTY ||
    difficulty > MAX_PROOF_DIFFICULTY
  ) {
    throw reportTicketProblem()
  }
  return {
    version,
    ticketId,
    issuedAt,
    expiresAt,
    packageId,
    packageSha256,
    packageBytes,
    schemaVersion,
    difficulty,
  }
}

function identityMatches(payload: ReportTicketPayload, request: ValidatedReportRequest): boolean {
  return (
    payload.packageId === request.packageId &&
    payload.packageSha256 === request.packageSha256 &&
    payload.packageBytes === request.packageBytes
  )
}

function digestHasLeadingZeroBits(digest: Uint8Array, difficulty: number): boolean {
  const fullBytes = Math.floor(difficulty / 8)
  for (let index = 0; index < fullBytes; index += 1) {
    if (digest[index] !== 0) return false
  }
  const remainingBits = difficulty % 8
  if (remainingBits === 0) return true
  const next = digest[fullBytes]
  return next !== undefined && (next & (0xff << (8 - remainingBits))) === 0
}

export async function issueReportTicket(
  request: ValidatedReportRequest,
  serverSecret: string,
  options: TicketIssuerOptions = {},
): Promise<ReportTicketResponse> {
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.valueOf())) throw new TypeError('A valid ticket time is required.')
  const issuedAt = Math.floor(now.valueOf() / 1_000)
  const difficulty = options.difficulty ?? REPORT_PROOF_DIFFICULTY
  if (
    !Number.isInteger(difficulty) ||
    difficulty < MIN_PROOF_DIFFICULTY ||
    difficulty > MAX_PROOF_DIFFICULTY
  ) {
    throw new RangeError('The report proof difficulty is outside the supported range.')
  }
  const payload: ReportTicketPayload = {
    version: REPORT_TICKET_SCHEMA_VERSION,
    ticketId: (options.ticketId ?? crypto.randomUUID()).toLowerCase(),
    issuedAt,
    expiresAt: issuedAt + REPORT_TICKET_TTL_SECONDS,
    packageId: request.packageId,
    packageSha256: request.packageSha256,
    packageBytes: request.packageBytes,
    schemaVersion: request.schemaVersion,
    difficulty,
  }
  // Parse our own payload shape before signing so injected test values can
  // never create a token the verifier would interpret differently.
  const payloadBytes = encoder.encode(JSON.stringify(payload))
  parsePayload(payloadBytes)
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await signingKey(serverSecret), payloadBytes),
  )
  const ticket = `${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(signature)}`
  return {
    format: REPORT_TICKET_FORMAT,
    schemaVersion: REPORT_TICKET_SCHEMA_VERSION,
    ticket,
    difficulty,
    expiresAt: new Date(payload.expiresAt * 1_000).toISOString(),
  }
}

export async function validateReportTicketAndProof(
  headers: Headers,
  request: ValidatedReportRequest,
  serverSecret: string,
  now = new Date(),
): Promise<ReportTicketPayload> {
  if (!Number.isFinite(now.valueOf())) throw new TypeError('A valid ticket time is required.')
  const ticket = headers.get('X-SingScope-Report-Ticket')?.trim() ?? ''
  const proof = headers.get('X-SingScope-Report-Proof')?.trim() ?? ''
  if (ticket.length < 3 || ticket.length > MAX_TICKET_CHARACTERS || !DECIMAL_PATTERN.test(proof)) {
    throw reportTicketProblem()
  }
  const proofNonce = Number(proof)
  if (!Number.isSafeInteger(proofNonce) || proofNonce > MAX_REPORT_PROOF_NONCE) {
    throw reportTicketProblem()
  }
  const segments = ticket.split('.')
  if (segments.length !== 2) throw reportTicketProblem()
  const payloadSegment = segments[0]
  const signatureSegment = segments[1]
  if (payloadSegment === undefined || signatureSegment === undefined) {
    throw reportTicketProblem()
  }
  const payloadBytes = base64UrlToBytes(payloadSegment)
  const signature = base64UrlToBytes(signatureSegment)
  if (signature.byteLength !== 32) throw reportTicketProblem()
  const signatureBuffer = new Uint8Array(signature).buffer
  const payloadBuffer = new Uint8Array(payloadBytes).buffer
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await signingKey(serverSecret),
      signatureBuffer,
      payloadBuffer,
    ))
  ) {
    throw reportTicketProblem()
  }
  const payload = parsePayload(payloadBytes)
  if (!identityMatches(payload, request)) throw reportTicketProblem()
  const nowSeconds = Math.floor(now.valueOf() / 1_000)
  if (payload.issuedAt > nowSeconds + 5) throw reportTicketProblem()
  if (payload.expiresAt <= nowSeconds) throw reportTicketProblem('REPORT_TICKET_EXPIRED')

  const proofBytes = encoder.encode(`${ticket}.${proof}`)
  const proofDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', proofBytes))
  if (!digestHasLeadingZeroBits(proofDigest, payload.difficulty)) {
    throw reportTicketProblem()
  }
  return payload
}
