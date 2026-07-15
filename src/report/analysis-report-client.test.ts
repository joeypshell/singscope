import { describe, expect, it, vi } from 'vitest'

import { validateAnalysisReportBuildEnvironment } from './analysis-report-config'
import {
  analysisReportConfigurationFromEnv,
  sendAnalysisReport,
  solveAnalysisReportProof,
} from './analysis-report-client'

const PACKAGE_ID = '9bba8fce-7c65-4ed6-ae62-2f2046d6e2d8'
const PACKAGE_HASH = 'a'.repeat(64)
const RECEIPT = {
  format: 'singscope-analysis-report-receipt',
  schemaVersion: 1,
  reportId: 'SS-7f034c18',
  receivedAt: '2026-07-14T18:30:00.000Z',
} as const
const TICKET = {
  format: 'singscope-analysis-report-ticket',
  schemaVersion: 1,
  ticket: 'signed-payload.signature',
  difficulty: 4,
  expiresAt: '2026-07-14T18:32:00.000Z',
} as const

const proofSolver = vi.fn(() => Promise.resolve('17'))

describe('analysis report client', () => {
  it('gets a ticket, solves its proof, then posts the exact ZIP once with stable identity', async () => {
    const blob = new Blob(['debug-package'], { type: 'application/zip' })
    const fetchImplementation = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input
      return Promise.resolve(
        Response.json(typeof init?.body === 'string' ? TICKET : RECEIPT, { status: 201 }),
      )
    })

    const receipt = await sendAnalysisReport(
      {
        endpoint: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report',
        publishableKey: 'sb_publishable_public-test',
      },
      { blob, packageId: PACKAGE_ID, packageSha256: PACKAGE_HASH },
      fetchImplementation,
      proofSolver,
    )

    expect(receipt).toEqual(RECEIPT)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(proofSolver).toHaveBeenCalledWith(TICKET.ticket, 4, undefined)
    const [ticketUrl, ticketInit] = fetchImplementation.mock.calls[0] ?? []
    expect(ticketUrl).toBe('https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report')
    expect(ticketInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        format: 'singscope-analysis-report-ticket-request',
        schemaVersion: 1,
      }),
      credentials: 'omit',
    })
    const ticketHeaders = new Headers(ticketInit?.headers)
    expect(ticketHeaders.get('Content-Type')).toBe('application/json')
    expect(ticketHeaders.get('X-SingScope-Package-Bytes')).toBe(blob.size.toString())

    const [url, init] = fetchImplementation.mock.calls[1] ?? []
    expect(url).toBe('https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report')
    expect(init).toMatchObject({
      method: 'POST',
      body: blob,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/zip')
    expect(headers.get('X-SingScope-Package-Id')).toBe(PACKAGE_ID)
    expect(headers.get('X-SingScope-Package-Bytes')).toBe(blob.size.toString())
    expect(headers.get('X-SingScope-Package-Sha256')).toBe(PACKAGE_HASH)
    expect(headers.get('X-SingScope-Schema-Version')).toBe('1')
    expect(headers.get('apikey')).toBe('sb_publishable_public-test')
    expect(headers.get('X-SingScope-Report-Ticket')).toBe(TICKET.ticket)
    expect(headers.get('X-SingScope-Report-Proof')).toBe('17')
    expect(headers.has('authorization')).toBe(false)
  })

  it('omits the optional publishable key and rejects an invalid receipt', async () => {
    const fetchImplementation = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      void _url
      expect(new Headers(init?.headers).has('apikey')).toBe(false)
      return Promise.resolve(
        Response.json(typeof init?.body === 'string' ? TICKET : { reportId: '<script>' }),
      )
    })
    await expect(
      sendAnalysisReport(
        { endpoint: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report' },
        {
          blob: new Blob(['debug-package']),
          packageId: PACKAGE_ID,
          packageSha256: PACKAGE_HASH,
        },
        fetchImplementation,
        proofSolver,
      ),
    ).rejects.toThrow(/invalid receipt/i)
  })

  it('accepts HTTP only for local development and returns null when reporting is unconfigured', () => {
    expect(analysisReportConfigurationFromEnv({})).toBeNull()
    expect(
      analysisReportConfigurationFromEnv({
        VITE_SINGSCOPE_REPORT_ENDPOINT: 'http://127.0.0.1:54321/functions/v1/analysis-report',
      }),
    ).toEqual({ endpoint: 'http://127.0.0.1:54321/functions/v1/analysis-report' })
    expect(() =>
      analysisReportConfigurationFromEnv({
        VITE_SINGSCOPE_REPORT_ENDPOINT: 'http://reports.example.com/upload',
      }),
    ).toThrow(/HTTPS/)
    expect(() =>
      analysisReportConfigurationFromEnv({
        VITE_SINGSCOPE_REPORT_ENDPOINT: 'https://example.com/functions/v1/analysis-report',
      }),
    ).toThrow(/approved Supabase/i)
    expect(() =>
      analysisReportConfigurationFromEnv({
        VITE_SINGSCOPE_REPORT_ENDPOINT:
          'https://abcdefghijklmnopqrst.supabase.co/functions/v1/other-function',
      }),
    ).toThrow(/must end with/i)
  })

  it('accepts only current public Supabase keys in browser configuration', () => {
    const endpoint = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report'
    expect(
      analysisReportConfigurationFromEnv({
        VITE_SINGSCOPE_REPORT_ENDPOINT: endpoint,
        VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY: 'sb_publishable_public-test',
      }),
    ).toEqual({ endpoint, publishableKey: 'sb_publishable_public-test' })
    for (const key of [
      'sb_secret_do-not-bundle',
      'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature',
      'legacy-anon-key',
    ]) {
      expect(() =>
        analysisReportConfigurationFromEnv({
          VITE_SINGSCOPE_REPORT_ENDPOINT: endpoint,
          VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY: key,
        }),
      ).toThrow(/only a current sb_publishable_/i)
    }
  })

  it('fails build-time validation before a secret-shaped Vite value can be emitted', () => {
    expect(() =>
      validateAnalysisReportBuildEnvironment({
        VITE_SINGSCOPE_REPORT_ENDPOINT:
          'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report',
        VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY: 'sb_secret_do-not-emit',
      }),
    ).toThrow(/only a current sb_publishable_/i)
    expect(
      validateAnalysisReportBuildEnvironment({
        VITE_SINGSCOPE_REPORT_ENDPOINT:
          'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report',
      }),
    ).toBe('https://abcdefghijklmnopqrst.supabase.co')
  })

  it('does not retry a rejected upload inside the adapter', async () => {
    const fetchImplementation = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        typeof init?.body === 'string'
          ? Response.json(TICKET)
          : new Response(null, { status: 429 }),
      ),
    )
    await expect(
      sendAnalysisReport(
        { endpoint: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report' },
        {
          blob: new Blob(['debug-package']),
          packageId: PACKAGE_ID,
          packageSha256: PACKAGE_HASH,
        },
        fetchImplementation,
        proofSolver,
      ),
    ).rejects.toThrow(/HTTP 429.*not confirmed/i)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it('returns a completed idempotent receipt from the ticket step without proof or ZIP upload', async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(Response.json(RECEIPT)))
    const solver = vi.fn(() => Promise.resolve('unused'))
    await expect(
      sendAnalysisReport(
        { endpoint: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/analysis-report' },
        {
          blob: new Blob(['debug-package']),
          packageId: PACKAGE_ID,
          packageSha256: PACKAGE_HASH,
        },
        fetchImplementation,
        solver,
      ),
    ).resolves.toEqual(RECEIPT)
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(solver).not.toHaveBeenCalled()
  })

  it('solves a bounded cancellable WebCrypto proof', async () => {
    const ticket = 'test-ticket.payload'
    const nonce = await solveAnalysisReportProof(ticket, 4)
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ticket}.${nonce}`)),
    )
    expect((digest[0] ?? 0xff) & 0xf0).toBe(0)

    const controller = new AbortController()
    controller.abort()
    await expect(solveAnalysisReportProof(ticket, 20, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
