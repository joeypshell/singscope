import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ALLOWED_ORIGIN,
  RequestProblem,
  allowedOriginFromValue,
  assertAllowedOrigin,
  assertZipSignature,
  isDailyReportQuotaError,
  objectPath,
  readBodyWithLimit,
  readTicketRequest,
  resolveSupabaseSecretKey,
  sha256Hex,
  storedIdentityMatches,
  validatePreflight,
  validateReportHeaders,
  validateTicketRequestHeaders,
} from './contract.ts'

const PACKAGE_ID = '9bba8fce-7c65-4ed6-ae62-2f2046d6e2d8'
const PACKAGE_SHA256 = 'a'.repeat(64)

function reportHeaders(overrides: Readonly<Record<string, string>> = {}): Headers {
  return new Headers({
    'Content-Type': 'application/zip',
    'X-SingScope-Package-Id': PACKAGE_ID,
    'X-SingScope-Package-Bytes': '123',
    'X-SingScope-Package-Sha256': PACKAGE_SHA256,
    'X-SingScope-Schema-Version': '1',
    ...overrides,
  })
}

function expectProblem(callback: () => unknown, code: string, status: number): void {
  try {
    callback()
    throw new Error('Expected a RequestProblem.')
  } catch (error) {
    expect(error).toBeInstanceOf(RequestProblem)
    expect(error).toMatchObject({ code, status })
  }
}

describe('analysis report Edge Function contract', () => {
  it('uses one exact production origin and rejects URLs with paths', () => {
    expect(allowedOriginFromValue(undefined)).toBe(DEFAULT_ALLOWED_ORIGIN)
    expect(allowedOriginFromValue('https://reports.example.com')).toBe(
      'https://reports.example.com',
    )
    expect(() => allowedOriginFromValue('https://reports.example.com/app')).toThrow(/origin/i)
  })

  it('requires the exact Origin and restricts preflight headers', () => {
    const valid = new Request('https://project.supabase.co/functions/v1/analysis-report', {
      headers: { Origin: DEFAULT_ALLOWED_ORIGIN },
    })
    expect(() => assertAllowedOrigin(valid, DEFAULT_ALLOWED_ORIGIN)).not.toThrow()

    const invalid = new Request('https://project.supabase.co/functions/v1/analysis-report', {
      headers: { Origin: 'https://evil.example' },
    })
    expectProblem(
      () => assertAllowedOrigin(invalid, DEFAULT_ALLOWED_ORIGIN),
      'ORIGIN_NOT_ALLOWED',
      403,
    )

    const preflight = new Request('https://project.supabase.co/functions/v1/analysis-report', {
      headers: {
        'Access-Control-Request-Headers': 'content-type, x-unexpected',
        'Access-Control-Request-Method': 'POST',
      },
    })
    expectProblem(() => validatePreflight(preflight), 'HEADER_NOT_ALLOWED', 400)
  })

  it('validates the UUID, digest, schema, media type, and declared size', () => {
    expect(validateReportHeaders(reportHeaders())).toMatchObject({
      packageId: PACKAGE_ID,
      packageSha256: PACKAGE_SHA256,
      packageBytes: 123,
      schemaVersion: 1,
      declaredLength: null,
    })
    expectProblem(
      () => validateReportHeaders(reportHeaders({ 'Content-Type': 'text/plain' })),
      'UNSUPPORTED_MEDIA_TYPE',
      415,
    )
    expectProblem(
      () =>
        validateReportHeaders(reportHeaders({ 'Content-Length': String(16 * 1024 * 1024 + 1) })),
      'PACKAGE_TOO_LARGE',
      413,
    )
    expectProblem(
      () => validateReportHeaders(reportHeaders({ 'X-SingScope-Schema-Version': '2' })),
      'UNSUPPORTED_SCHEMA_VERSION',
      422,
    )
  })

  it('validates only the small fixed ticket request before any ZIP upload', async () => {
    const headers = reportHeaders({ 'Content-Type': 'application/json' })
    expect(validateTicketRequestHeaders(headers)).toMatchObject({
      packageId: PACKAGE_ID,
      packageBytes: 123,
      declaredLength: null,
    })
    await expect(
      readTicketRequest(
        new Request('https://project.supabase.co/functions/v1/analysis-report', {
          method: 'POST',
          body: JSON.stringify({
            format: 'singscope-analysis-report-ticket-request',
            schemaVersion: 1,
          }),
        }),
      ),
    ).resolves.toBeUndefined()
    await expect(
      readTicketRequest(
        new Request('https://project.supabase.co/functions/v1/analysis-report', {
          method: 'POST',
          body: JSON.stringify({
            format: 'singscope-analysis-report-ticket-request',
            schemaVersion: 1,
            unexpected: true,
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TICKET_REQUEST', status: 400 })
  })

  it('stops a streaming body at the configured byte limit', async () => {
    const request = new Request('https://reports.example.test', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 4, 5]),
    })
    await expect(readBodyWithLimit(request, 4)).rejects.toMatchObject({
      code: 'PACKAGE_TOO_LARGE',
      status: 413,
    })
  })

  it('recognizes ZIP signatures and computes a lowercase SHA-256', async () => {
    expect(() => assertZipSignature(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).not.toThrow()
    expectProblem(
      () => assertZipSignature(new Uint8Array([0x52, 0x61, 0x72, 0x21])),
      'INVALID_ZIP',
      422,
    )
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('derives deterministic private paths and exact idempotency identity', () => {
    const path = objectPath(PACKAGE_ID, PACKAGE_SHA256)
    expect(path).toBe(`${PACKAGE_ID}/${PACKAGE_SHA256}.zip`)
    expect(
      storedIdentityMatches(
        {
          package_id: PACKAGE_ID,
          package_sha256: PACKAGE_SHA256,
          schema_version: 1,
          package_bytes: 123,
          object_path: path,
        },
        {
          packageId: PACKAGE_ID,
          packageSha256: PACKAGE_SHA256,
          packageBytes: 123,
          schemaVersion: 1,
          declaredLength: null,
        },
        123,
      ),
    ).toBe(true)
  })

  it('recognizes only the private database quota sentinel', () => {
    expect(
      isDailyReportQuotaError({
        code: 'P0001',
        message: 'SINGSCOPE_REPORT_DAILY_QUOTA_EXCEEDED',
      }),
    ).toBe(true)
    expect(isDailyReportQuotaError({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isDailyReportQuotaError(null)).toBe(false)
  })

  it('resolves current named secrets without exposing them and supports local legacy fallback', () => {
    expect(resolveSupabaseSecretKey({ SUPABASE_SECRET_KEYS: '{"default":"secret-current"}' })).toBe(
      'secret-current',
    )
    expect(resolveSupabaseSecretKey({ SUPABASE_SERVICE_ROLE_KEY: 'secret-local' })).toBe(
      'secret-local',
    )
    expect(() => resolveSupabaseSecretKey({ SUPABASE_SECRET_KEYS: '{}' })).toThrow(/default key/)
  })
})
