import { createClient } from '@supabase/supabase-js'

import {
  type CleanupBackend,
  type ExpiredReport,
  type StorageListEntry,
  runAnalysisReportCleanup,
} from './cleanup.ts'
import {
  CLEANUP_TOKEN_HEADER,
  REPORT_BUCKET,
  authorizeCleanupRequest,
  cleanupTokenFallbackForRuntime,
  resolveSupabaseSecretKey,
} from './contract.ts'

class CleanupServiceError extends Error {
  readonly stage: string

  constructor(stage: string) {
    super('The cleanup service is temporarily unavailable.')
    this.name = 'CleanupServiceError'
    this.stage = stage
  }
}

interface ServiceResult {
  readonly data: unknown
  readonly error: unknown
}

interface SelectBuilder {
  eq(column: string, value: string): SelectBuilder
  lte(column: string, value: string): SelectBuilder
  order(column: string, options: { readonly ascending: boolean }): SelectBuilder
  limit(limit: number): Promise<ServiceResult>
  maybeSingle(): Promise<ServiceResult>
}

interface DeleteBuilder {
  eq(column: string, value: string): Promise<ServiceResult>
}

interface ReportTable {
  select(columns: string): SelectBuilder
  delete(): DeleteBuilder
}

interface StorageBucketClient {
  remove(paths: readonly string[]): Promise<ServiceResult>
  list(
    folder: string,
    options: {
      readonly limit: number
      readonly offset: number
      readonly sortBy: { readonly column: string; readonly order: 'asc' | 'desc' }
    },
  ): Promise<ServiceResult>
}

interface SupabaseCleanupClient {
  rpc(name: string, parameters: Readonly<Record<string, string | number>>): Promise<ServiceResult>
  from(table: 'analysis_reports'): ReportTable
  readonly storage: {
    from(bucket: typeof REPORT_BUCKET): StorageBucketClient
  }
}

interface CleanupRuntimeBackend extends CleanupBackend {
  verifyCleanupToken(presented: string): Promise<boolean>
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function parseClaimedOffset(value: unknown): number | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const row = asRecord(value[0])
  const offset = row?.orphan_scan_offset
  return Number.isSafeInteger(offset) && typeof offset === 'number' ? offset : null
}

function parseExpiredReports(value: unknown): readonly ExpiredReport[] {
  if (!Array.isArray(value)) throw new CleanupServiceError('parse-expired-reports')
  return value.map((candidate) => {
    const row = asRecord(candidate)
    if (typeof row?.report_id !== 'string' || typeof row.object_path !== 'string') {
      throw new CleanupServiceError('parse-expired-reports')
    }
    return { reportId: row.report_id, objectPath: row.object_path }
  })
}

function parseReceiptExists(value: unknown): boolean {
  if (value === null) return false
  const row = asRecord(value)
  if (typeof row?.report_id !== 'string') {
    throw new CleanupServiceError('parse-report-receipt')
  }
  return true
}

function parseStorageEntries(value: unknown): readonly StorageListEntry[] {
  if (!Array.isArray(value)) throw new CleanupServiceError('parse-storage-list')
  return value.map((candidate) => {
    const entry = asRecord(candidate)
    if (
      typeof entry?.name !== 'string' ||
      (entry.id !== null && typeof entry.id !== 'string') ||
      (entry.created_at !== null && typeof entry.created_at !== 'string')
    ) {
      throw new CleanupServiceError('parse-storage-list')
    }
    return {
      name: entry.name,
      id: entry.id,
      createdAt: entry.created_at,
    }
  })
}

class SupabaseCleanupBackend implements CleanupRuntimeBackend {
  readonly #client: SupabaseCleanupClient

  constructor(client: SupabaseCleanupClient) {
    this.#client = client
  }

  async verifyCleanupToken(presented: string): Promise<boolean> {
    const { data, error } = await this.#client.rpc('verify_analysis_report_cleanup_token', {
      p_token: presented,
    })
    if (error !== null || typeof data !== 'boolean') {
      throw new CleanupServiceError('verify-cleanup-token')
    }
    return data
  }

  async claimLease(leaseToken: string): Promise<number | null> {
    const { data, error } = await this.#client.rpc('claim_analysis_report_cleanup', {
      p_lease_token: leaseToken,
    })
    if (error !== null) throw new CleanupServiceError('claim-cleanup-lease')
    return parseClaimedOffset(data)
  }

  async finishLease(leaseToken: string, nextOffset: number): Promise<boolean> {
    const { data, error } = await this.#client.rpc('finish_analysis_report_cleanup', {
      p_lease_token: leaseToken,
      p_next_orphan_scan_offset: nextOffset,
    })
    if (error !== null || typeof data !== 'boolean') {
      throw new CleanupServiceError('finish-cleanup-lease')
    }
    return data
  }

  async listExpiredReports(
    expiresAtOrBefore: string,
    limit: number,
  ): Promise<readonly ExpiredReport[]> {
    const { data, error } = await this.#client
      .from('analysis_reports')
      .select('report_id,object_path')
      .lte('expires_at', expiresAtOrBefore)
      .order('expires_at', { ascending: true })
      .limit(limit)
    if (error !== null) throw new CleanupServiceError('list-expired-reports')
    return parseExpiredReports(data)
  }

  async removeStorageObject(objectPath: string): Promise<void> {
    const { error } = await this.#client.storage.from(REPORT_BUCKET).remove([objectPath])
    if (error !== null) throw new CleanupServiceError('remove-storage-object')
  }

  async deleteReportReceipt(reportId: string): Promise<void> {
    const { error } = await this.#client.from('analysis_reports').delete().eq('report_id', reportId)
    if (error !== null) throw new CleanupServiceError('delete-report-receipt')
  }

  async listStorageRoots(offset: number, limit: number): Promise<readonly StorageListEntry[]> {
    return await this.#listStorage('', offset, limit)
  }

  async listStorageFolder(folder: string, limit: number): Promise<readonly StorageListEntry[]> {
    return await this.#listStorage(folder, 0, limit)
  }

  async reportReceiptExists(objectPath: string): Promise<boolean> {
    const { data, error } = await this.#client
      .from('analysis_reports')
      .select('report_id')
      .eq('object_path', objectPath)
      .maybeSingle()
    if (error !== null) throw new CleanupServiceError('find-report-receipt')
    return parseReceiptExists(data)
  }

  async #listStorage(
    folder: string,
    offset: number,
    limit: number,
  ): Promise<readonly StorageListEntry[]> {
    const { data, error } = await this.#client.storage.from(REPORT_BUCKET).list(folder, {
      limit,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error !== null || data === null) throw new CleanupServiceError('list-storage')
    return parseStorageEntries(data)
  }
}

function environment(): Readonly<Record<string, string | undefined>> {
  return {
    REPORT_CLEANUP_TOKEN: Deno.env.get('REPORT_CLEANUP_TOKEN'),
    SUPABASE_SECRET_KEYS: Deno.env.get('SUPABASE_SECRET_KEYS'),
    SUPABASE_SECRET_KEY: Deno.env.get('SUPABASE_SECRET_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  }
}

function backendFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CleanupRuntimeBackend {
  const url = env.SUPABASE_URL?.trim()
  if (!url) throw new CleanupServiceError('missing-supabase-url')
  const client = createClient(url, resolveSupabaseSecretKey(env), {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: { headers: { 'X-Client-Info': 'singscope-analysis-report-cleanup/1' } },
  }) as SupabaseCleanupClient
  return new SupabaseCleanupBackend(client)
}

function responseHeaders(requestId: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
  })
}

function jsonResponse(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify({ ...asRecord(body), requestId }), {
    status,
    headers: responseHeaders(requestId),
  })
}

async function validateEmptyJsonBody(request: Request): Promise<boolean> {
  const rawLength = request.headers.get('content-length')?.trim()
  if (rawLength !== undefined && rawLength !== '') {
    const parsedLength = Number(rawLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > 128) return false
  }
  if (request.body === null) return true
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 128) {
        await reader.cancel('cleanup request body limit exceeded')
        return false
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) return true
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const record = asRecord(parsed)
    return record !== null && Object.keys(record).length === 0
  } catch {
    return false
  }
}

export async function handleAnalysisReportCleanup(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID()
  const env = environment()
  let backend: CleanupRuntimeBackend | undefined
  let authorized: boolean
  try {
    authorized = await authorizeCleanupRequest(
      request.headers.get(CLEANUP_TOKEN_HEADER),
      cleanupTokenFallbackForRuntime(env.SUPABASE_URL, env.REPORT_CLEANUP_TOKEN),
      async (presented) => {
        backend ??= backendFromEnvironment(env)
        return await backend.verifyCleanupToken(presented)
      },
    )
  } catch {
    console.error(JSON.stringify({ requestId, stage: 'cleanup-token-authorization' }))
    return jsonResponse(
      { error: { code: 'CLEANUP_SERVICE_UNAVAILABLE', message: 'Cleanup is unavailable.' } },
      503,
      requestId,
    )
  }

  if (!authorized) {
    return jsonResponse(
      { error: { code: 'UNAUTHORIZED', message: 'Cleanup authorization failed.' } },
      401,
      requestId,
    )
  }
  if (request.method !== 'POST') {
    const response = jsonResponse(
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed.' } },
      405,
      requestId,
    )
    response.headers.set('Allow', 'POST')
    return response
  }
  if (!(await validateEmptyJsonBody(request))) {
    return jsonResponse(
      { error: { code: 'INVALID_BODY', message: 'The cleanup body must be empty JSON.' } },
      400,
      requestId,
    )
  }

  try {
    backend ??= backendFromEnvironment(env)
    const result = await runAnalysisReportCleanup(backend, new Date())
    return jsonResponse(result, result.status === 'partial' ? 503 : 200, requestId)
  } catch (error) {
    console.error(
      JSON.stringify({
        requestId,
        stage: error instanceof CleanupServiceError ? error.stage : 'unexpected',
      }),
    )
    return jsonResponse(
      { error: { code: 'CLEANUP_SERVICE_UNAVAILABLE', message: 'Cleanup is unavailable.' } },
      503,
      requestId,
    )
  }
}

Deno.serve(handleAnalysisReportCleanup)
