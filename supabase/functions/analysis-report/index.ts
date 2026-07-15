import { createClient } from '@supabase/supabase-js'

import { validateAnalysisDebugArchive } from './archive-validator.ts'
import {
  ALLOWED_REQUEST_HEADERS,
  REPORT_BUCKET,
  REPORT_FORMAT,
  REPORT_SCHEMA_VERSION,
  RequestProblem,
  allowedOriginFromValue,
  assertAllowedOrigin,
  assertZipSignature,
  isDailyReportQuotaError,
  objectPath,
  readBodyWithLimit,
  readTicketRequest,
  requestMediaType,
  resolveSupabaseSecretKey,
  sha256Hex,
  storedIdentityMatches,
  validatePreflight,
  validateReportHeaders,
  validateTicketRequestHeaders,
  type StoredReportIdentity,
  type ServiceErrorIdentity,
  type ValidatedReportRequest,
} from './contract.ts'
import {
  issueReportTicket,
  validateReportTicketAndProof,
  type ReportTicketPayload,
} from './gate.ts'

interface ServiceError extends ServiceErrorIdentity {
  readonly status?: number
}

interface QueryResult<T> {
  readonly data: T
  readonly error: ServiceError | null
}

interface StoredReport extends StoredReportIdentity {
  readonly report_id: string
  readonly received_at: string
}

interface SelectReportBuilder {
  eq(column: string, value: string | number): SelectReportBuilder
  maybeSingle(): Promise<QueryResult<StoredReport | null>>
}

interface InsertReportBuilder {
  select(columns: string): {
    single(): Promise<QueryResult<StoredReport | null>>
  }
}

interface ReportTable {
  select(columns: string): SelectReportBuilder
  insert(value: {
    readonly package_id: string
    readonly schema_version: number
    readonly package_sha256: string
    readonly package_bytes: number
    readonly object_path: string
  }): InsertReportBuilder
}

interface StorageEntry {
  readonly name: string
}

interface StorageBucketClient {
  upload(
    path: string,
    body: Uint8Array,
    options: {
      readonly cacheControl: string
      readonly contentType: string
      readonly upsert: boolean
    },
  ): Promise<QueryResult<unknown>>
  list(
    path: string,
    options: { readonly limit: number; readonly search: string },
  ): Promise<QueryResult<StorageEntry[] | null>>
  remove(paths: readonly string[]): Promise<QueryResult<unknown>>
}

interface SupabaseAdminClient {
  rpc(
    name: 'claim_analysis_report_gate_ticket',
    parameters: {
      readonly p_ticket_id: string
      readonly p_package_id: string
      readonly p_schema_version: number
      readonly p_package_sha256: string
      readonly p_package_bytes: number
      readonly p_ticket_expires_at: string
    },
  ): Promise<QueryResult<unknown>>
  rpc(
    name: 'finish_analysis_report_gate_ticket',
    parameters: { readonly p_ticket_id: string },
  ): Promise<QueryResult<unknown>>
  from(table: 'analysis_reports'): ReportTable
  readonly storage: {
    from(bucket: typeof REPORT_BUCKET): StorageBucketClient
  }
}

class ServiceProblem extends Error {
  readonly stage: string
  readonly serviceCode: string | undefined

  constructor(stage: string, error?: ServiceError) {
    super('The report service is temporarily unavailable.')
    this.name = 'ServiceProblem'
    this.stage = stage
    this.serviceCode = error?.code
  }
}

const REPORT_COLUMNS =
  'report_id,package_id,schema_version,package_sha256,package_bytes,object_path,received_at'

function environment(): Readonly<Record<string, string | undefined>> {
  return {
    REPORT_ALLOWED_ORIGIN: Deno.env.get('REPORT_ALLOWED_ORIGIN'),
    SUPABASE_SECRET_KEYS: Deno.env.get('SUPABASE_SECRET_KEYS'),
    SUPABASE_SECRET_KEY: Deno.env.get('SUPABASE_SECRET_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  }
}

function adminClient(env: Readonly<Record<string, string | undefined>>): SupabaseAdminClient {
  const url = env.SUPABASE_URL?.trim()
  if (!url) throw new Error('SUPABASE_URL is unavailable.')
  const key = resolveSupabaseSecretKey(env)
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { 'X-Client-Info': 'singscope-analysis-report/1' } },
  }) as SupabaseAdminClient
}

function responseHeaders(requestId: string, allowedOrigin?: string): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
  })
  if (allowedOrigin !== undefined) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin)
    headers.set('Access-Control-Expose-Headers', 'X-Request-Id')
    headers.set('Vary', 'Origin')
  }
  return headers
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  allowedOrigin?: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(requestId, allowedOrigin),
  })
}

function problemResponse(
  problem: RequestProblem,
  requestId: string,
  allowedOrigin?: string,
): Response {
  const response = jsonResponse(
    { error: { code: problem.code, message: problem.message }, requestId },
    problem.status,
    requestId,
    allowedOrigin,
  )
  if (problem.status === 405) response.headers.set('Allow', 'POST, OPTIONS')
  if (problem.code === 'REPORT_UPLOAD_IN_PROGRESS' || problem.code === 'REPORT_GATE_AT_CAPACITY') {
    response.headers.set('Retry-After', '120')
  }
  return response
}

function preflightResponse(requestId: string, allowedOrigin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Headers': Array.from(ALLOWED_REQUEST_HEADERS).join(', '),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: 'Origin, Access-Control-Request-Headers',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
    },
  })
}

function receipt(report: StoredReport): {
  readonly format: typeof REPORT_FORMAT
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION
  readonly reportId: string
  readonly receivedAt: string
} {
  const receivedAt = new Date(report.received_at)
  if (Number.isNaN(receivedAt.valueOf())) throw new ServiceProblem('invalid-receipt')
  return {
    format: REPORT_FORMAT,
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportId: report.report_id,
    receivedAt: receivedAt.toISOString(),
  }
}

async function findReport(
  client: SupabaseAdminClient,
  packageId: string,
): Promise<StoredReport | null> {
  const result = await client
    .from('analysis_reports')
    .select(REPORT_COLUMNS)
    .eq('package_id', packageId)
    .maybeSingle()
  if (result.error !== null) throw new ServiceProblem('find-report', result.error)
  return result.data
}

function assertExistingIdentity(
  existing: StoredReport,
  request: ValidatedReportRequest,
  packageBytes = request.packageBytes,
): void {
  if (!storedIdentityMatches(existing, request, packageBytes)) {
    throw new RequestProblem(
      409,
      'PACKAGE_ID_CONFLICT',
      'This package ID was already used for different report bytes.',
    )
  }
}

async function claimReportReservation(
  client: SupabaseAdminClient,
  ticket: ReportTicketPayload,
): Promise<void> {
  const result = await client.rpc('claim_analysis_report_gate_ticket', {
    p_ticket_id: ticket.ticketId,
    p_package_id: ticket.packageId,
    p_schema_version: ticket.schemaVersion,
    p_package_sha256: ticket.packageSha256,
    p_package_bytes: ticket.packageBytes,
    p_ticket_expires_at: new Date(ticket.expiresAt * 1_000).toISOString(),
  })
  if (result.error !== null) throw new ServiceProblem('claim-report-ticket', result.error)
  switch (result.data) {
    case 'claimed':
      return
    case 'replay':
      throw new RequestProblem(
        409,
        'REPORT_TICKET_ALREADY_USED',
        'This report ticket was already used. Request a new ticket and retry.',
      )
    case 'busy':
      throw new RequestProblem(
        425,
        'REPORT_UPLOAD_IN_PROGRESS',
        'An upload for this report is already in progress. Retry shortly.',
      )
    case 'capacity':
      throw new RequestProblem(
        429,
        'REPORT_GATE_AT_CAPACITY',
        'The private report service is temporarily at capacity. Retry shortly.',
      )
    case 'daily-capacity':
      throw new RequestProblem(
        429,
        'REPORT_GATE_DAILY_LIMIT',
        'The daily private-report attempt limit has been reached. Please retry tomorrow (UTC).',
      )
    case 'invalid':
      throw new RequestProblem(
        403,
        'REPORT_TICKET_INVALID',
        'The report ticket is invalid or expired.',
      )
    default:
      throw new ServiceProblem('parse-report-ticket-claim')
  }
}

async function finishReportReservation(
  client: SupabaseAdminClient,
  ticketId: string,
): Promise<void> {
  const result = await client.rpc('finish_analysis_report_gate_ticket', {
    p_ticket_id: ticketId,
  })
  if (result.error !== null || result.data !== true) {
    throw new ServiceProblem('finish-report-ticket', result.error ?? undefined)
  }
}

async function objectAlreadyExists(
  bucket: StorageBucketClient,
  request: ValidatedReportRequest,
): Promise<boolean> {
  const fileName = `${request.packageSha256}.zip`
  const result = await bucket.list(request.packageId, { limit: 2, search: fileName })
  if (result.error !== null) throw new ServiceProblem('verify-storage-object', result.error)
  return result.data?.some((entry) => entry.name === fileName) ?? false
}

async function removeCreatedObject(bucket: StorageBucketClient, path: string): Promise<void> {
  let result: QueryResult<unknown>
  try {
    result = await bucket.remove([path])
  } catch {
    throw new ServiceProblem('cleanup-storage-object')
  }
  if (result.error !== null) throw new ServiceProblem('cleanup-storage-object', result.error)
}

async function persistReport(
  client: SupabaseAdminClient,
  request: ValidatedReportRequest,
  body: Uint8Array,
): Promise<{ readonly report: StoredReport; readonly created: boolean }> {
  const existing = await findReport(client, request.packageId)
  if (existing !== null) {
    assertExistingIdentity(existing, request, body.byteLength)
    return { report: existing, created: false }
  }

  const path = objectPath(request.packageId, request.packageSha256)
  const bucket = client.storage.from(REPORT_BUCKET)
  const upload = await bucket.upload(path, body, {
    cacheControl: '0',
    contentType: 'application/zip',
    upsert: false,
  })
  let createdObject = upload.error === null
  if (upload.error !== null) {
    // A crashed or concurrent identical request can leave the deterministic
    // object in place before its receipt row is committed. Reuse only that exact
    // hash-derived path; every public Storage policy is denied by the migration.
    if (!(await objectAlreadyExists(bucket, request))) {
      throw new ServiceProblem('upload-report', upload.error)
    }
    createdObject = false
  }

  const inserted = client.from('analysis_reports').insert({
    package_id: request.packageId,
    schema_version: request.schemaVersion,
    package_sha256: request.packageSha256,
    package_bytes: body.byteLength,
    object_path: path,
  })
  const insertResult = await inserted.select(REPORT_COLUMNS).single()
  if (insertResult.error === null && insertResult.data !== null) {
    return { report: insertResult.data, created: true }
  }

  // Resolve a concurrent insert by returning its stable receipt. A different
  // digest with the same package ID is a conflict, and its losing object is
  // removed when this invocation created it.
  const concurrent = await findReport(client, request.packageId)
  if (concurrent !== null) {
    if (storedIdentityMatches(concurrent, request, body.byteLength)) {
      return { report: concurrent, created: false }
    }
    if (createdObject) await removeCreatedObject(bucket, path)
    throw new RequestProblem(
      409,
      'PACKAGE_ID_CONFLICT',
      'This package ID was already used for different report bytes.',
    )
  }

  if (isDailyReportQuotaError(insertResult.error)) {
    if (createdObject) await removeCreatedObject(bucket, path)
    throw new RequestProblem(
      429,
      'REPORT_DAILY_QUOTA_EXCEEDED',
      'The daily private-report limit has been reached. Please retry tomorrow (UTC).',
    )
  }

  if (createdObject) await removeCreatedObject(bucket, path)
  throw new ServiceProblem('insert-receipt', insertResult.error ?? undefined)
}

export async function handleAnalysisReport(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID()
  let allowedOrigin: string
  try {
    allowedOrigin = allowedOriginFromValue(Deno.env.get('REPORT_ALLOWED_ORIGIN'))
  } catch {
    return jsonResponse(
      {
        error: {
          code: 'SERVICE_MISCONFIGURED',
          message: 'The report service is temporarily unavailable.',
        },
        requestId,
      },
      503,
      requestId,
    )
  }

  try {
    assertAllowedOrigin(request, allowedOrigin)
    if (request.method === 'OPTIONS') {
      validatePreflight(request)
      return preflightResponse(requestId, allowedOrigin)
    }
    if (request.method !== 'POST') {
      throw new RequestProblem(405, 'METHOD_NOT_ALLOWED', 'Only POST reports are allowed.')
    }

    const env = environment()
    const mediaType = requestMediaType(request.headers)
    if (mediaType === 'application/json') {
      const validated = validateTicketRequestHeaders(request.headers)
      await readTicketRequest(request)
      const client = adminClient(env)
      const existing = await findReport(client, validated.packageId)
      if (existing !== null) {
        assertExistingIdentity(existing, validated)
        return jsonResponse(receipt(existing), 200, requestId, allowedOrigin)
      }
      const ticket = await issueReportTicket(validated, resolveSupabaseSecretKey(env))
      return jsonResponse(ticket, 201, requestId, allowedOrigin)
    }

    const validated = validateReportHeaders(request.headers)
    const ticket = await validateReportTicketAndProof(
      request.headers,
      validated,
      resolveSupabaseSecretKey(env),
    )
    const client = adminClient(env)
    const existing = await findReport(client, validated.packageId)
    if (existing !== null) {
      assertExistingIdentity(existing, validated)
      return jsonResponse(receipt(existing), 200, requestId, allowedOrigin)
    }
    await claimReportReservation(client, ticket)

    // The short-lived signed ticket, proof of work, committed-receipt lookup,
    // and atomic single-use reservation all complete before request.body is
    // touched. Invalid or abandoned uploads retain only the expiring private
    // reservation; they can never create a completed receipt.
    try {
      const body = await readBodyWithLimit(request, validated.packageBytes)
      if (body.byteLength !== validated.packageBytes) {
        throw new RequestProblem(
          400,
          'CONTENT_LENGTH_MISMATCH',
          'The declared package byte length does not match the report body.',
        )
      }
      assertZipSignature(body)
      if ((await sha256Hex(body)) !== validated.packageSha256) {
        throw new RequestProblem(
          422,
          'PACKAGE_SHA256_MISMATCH',
          'The report digest does not match its body.',
        )
      }
      await validateAnalysisDebugArchive(body, validated)

      const result = await persistReport(client, validated, body)
      return jsonResponse(
        receipt(result.report),
        result.created ? 201 : 200,
        requestId,
        allowedOrigin,
      )
    } finally {
      try {
        await finishReportReservation(client, ticket.ticketId)
      } catch (error) {
        console.error(
          JSON.stringify({
            requestId,
            stage: error instanceof ServiceProblem ? error.stage : 'finish-report-ticket',
          }),
        )
      }
    }
  } catch (error) {
    if (error instanceof RequestProblem) {
      return problemResponse(error, requestId, allowedOrigin)
    }
    if (error instanceof ServiceProblem) {
      console.error(
        JSON.stringify({
          requestId,
          stage: error.stage,
          ...(error.serviceCode === undefined ? {} : { serviceCode: error.serviceCode }),
        }),
      )
    } else {
      console.error(JSON.stringify({ requestId, stage: 'unexpected' }))
    }
    return jsonResponse(
      {
        error: {
          code: 'REPORT_SERVICE_UNAVAILABLE',
          message: 'The report service is temporarily unavailable.',
        },
        requestId,
      },
      503,
      requestId,
      allowedOrigin,
    )
  }
}

Deno.serve(handleAnalysisReport)
