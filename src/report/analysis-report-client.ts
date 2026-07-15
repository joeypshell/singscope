import { z } from 'zod'

import { ANALYSIS_DEBUG_LIMITS } from '../export/analysis-debug-package'
import { ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION } from '../export/schemas'
import {
  validateAnalysisReportEndpoint,
  validateSupabasePublishableKey,
} from './analysis-report-config'

export const ANALYSIS_REPORT_RECEIPT_SCHEMA_VERSION = 1
export const ANALYSIS_REPORT_TICKET_SCHEMA_VERSION = 1

const TICKET_REQUEST = JSON.stringify({
  format: 'singscope-analysis-report-ticket-request',
  schemaVersion: ANALYSIS_REPORT_TICKET_SCHEMA_VERSION,
})
const MAX_REPORT_PROOF_NONCE = 8_388_607
const PROOF_BATCH_SIZE = 64

const packageIdSchema = z.uuid()
const packageHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const analysisReportReceiptSchema = z
  .object({
    format: z.literal('singscope-analysis-report-receipt'),
    schemaVersion: z.literal(ANALYSIS_REPORT_RECEIPT_SCHEMA_VERSION),
    reportId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    receivedAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export type AnalysisReportReceipt = z.infer<typeof analysisReportReceiptSchema>

const analysisReportTicketSchema = z
  .object({
    format: z.literal('singscope-analysis-report-ticket'),
    schemaVersion: z.literal(ANALYSIS_REPORT_TICKET_SCHEMA_VERSION),
    ticket: z
      .string()
      .min(3)
      .max(1_600)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    difficulty: z.number().int().min(4).max(20),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export type AnalysisReportTicket = z.infer<typeof analysisReportTicketSchema>

export interface AnalysisReportConfiguration {
  readonly endpoint: string
  readonly publishableKey?: string | undefined
}

export interface AnalysisReportEnvironment {
  readonly VITE_SINGSCOPE_REPORT_ENDPOINT?: string | undefined
  readonly VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY?: string | undefined
}

export interface SendAnalysisReportInput {
  readonly blob: Blob
  readonly packageId: string
  readonly packageSha256: string
  readonly signal?: AbortSignal | undefined
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type AnalysisReportProofSolver = (
  ticket: string,
  difficulty: number,
  signal?: AbortSignal,
) => Promise<string>

export function analysisReportConfigurationFromEnv(
  environment: AnalysisReportEnvironment,
): AnalysisReportConfiguration | null {
  const endpoint = environment.VITE_SINGSCOPE_REPORT_ENDPOINT?.trim()
  if (!endpoint) return null
  const publishableKey = validateSupabasePublishableKey(
    environment.VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY,
  )
  return {
    endpoint: validateAnalysisReportEndpoint(endpoint),
    ...(publishableKey === undefined ? {} : { publishableKey }),
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error('The bug-report service returned an unreadable response.')
  }
}

function abortError(): DOMException {
  return new DOMException('The bug report was cancelled.', 'AbortError')
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

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

export async function solveAnalysisReportProof(
  ticket: string,
  difficulty: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isInteger(difficulty) || difficulty < 4 || difficulty > 20) {
    throw new RangeError('The report proof difficulty is unsupported.')
  }
  const encoder = new TextEncoder()
  const expectedAttempts = 2 ** difficulty
  const maximumAttempts = Math.min(MAX_REPORT_PROOF_NONCE + 1, expectedAttempts * 16)
  for (let batchStart = 0; batchStart < maximumAttempts; batchStart += PROOF_BATCH_SIZE) {
    if (signal?.aborted === true) throw abortError()
    const batchEnd = Math.min(batchStart + PROOF_BATCH_SIZE, maximumAttempts)
    const candidates: Promise<{ readonly nonce: number; readonly digest: Uint8Array }>[] = []
    for (let nonce = batchStart; nonce < batchEnd; nonce += 1) {
      const input = encoder.encode(`${ticket}.${nonce.toString()}`)
      candidates.push(
        crypto.subtle.digest('SHA-256', input).then((digest) => ({
          nonce,
          digest: new Uint8Array(digest),
        })),
      )
    }
    for (const candidate of await Promise.all(candidates)) {
      if (digestHasLeadingZeroBits(candidate.digest, difficulty)) {
        return candidate.nonce.toString()
      }
    }
    await yieldToBrowser()
  }
  throw new Error('A report proof could not be prepared within the safe work limit.')
}

export async function sendAnalysisReport(
  configuration: AnalysisReportConfiguration,
  input: SendAnalysisReportInput,
  fetchImplementation: FetchImplementation = globalThis.fetch,
  proofSolver: AnalysisReportProofSolver = solveAnalysisReportProof,
): Promise<AnalysisReportReceipt> {
  const endpoint = validateAnalysisReportEndpoint(configuration.endpoint)
  const publishableKey = validateSupabasePublishableKey(configuration.publishableKey)
  const packageId = packageIdSchema.parse(input.packageId)
  const packageSha256 = packageHashSchema.parse(input.packageSha256)
  if (input.blob.size > ANALYSIS_DEBUG_LIMITS.packageBytes) {
    throw new Error('The debug package exceeds the 16 MiB report limit.')
  }

  const identityHeaders = new Headers({
    'X-SingScope-Package-Id': packageId,
    'X-SingScope-Package-Bytes': input.blob.size.toString(),
    'X-SingScope-Package-Sha256': packageSha256,
    'X-SingScope-Schema-Version': String(ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION),
  })
  if (publishableKey !== undefined) identityHeaders.set('apikey', publishableKey)

  const ticketHeaders = new Headers(identityHeaders)
  ticketHeaders.set('Content-Type', 'application/json')
  let ticketResponse: Response
  try {
    ticketResponse = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: ticketHeaders,
      body: TICKET_REQUEST,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('The bug-report service could not issue a delivery ticket. Please retry.')
  }
  if (!ticketResponse.ok) {
    throw new Error(
      `The report service could not issue a delivery ticket (HTTP ${ticketResponse.status.toString()}). Please retry.`,
    )
  }
  const ticketBody = await responseBody(ticketResponse)
  const completedReceipt = analysisReportReceiptSchema.safeParse(ticketBody)
  if (completedReceipt.success) return completedReceipt.data
  const parsedTicket = analysisReportTicketSchema.safeParse(ticketBody)
  if (!parsedTicket.success) {
    throw new Error('The bug-report service returned an invalid delivery ticket.')
  }

  const proof = await proofSolver(
    parsedTicket.data.ticket,
    parsedTicket.data.difficulty,
    input.signal,
  )
  const headers = new Headers(identityHeaders)
  headers.set('Content-Type', 'application/zip')
  headers.set('X-SingScope-Report-Ticket', parsedTicket.data.ticket)
  headers.set('X-SingScope-Report-Proof', proof)

  let response: Response
  try {
    response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers,
      body: input.blob,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(
      'Delivery could not be confirmed. The service may have received the report; retrying safely reuses the same report identity.',
    )
  }

  if (!response.ok) {
    throw new Error(
      `The report service did not return a receipt (HTTP ${response.status.toString()}). Delivery is not confirmed; retrying is safe.`,
    )
  }
  const parsed = analysisReportReceiptSchema.safeParse(await responseBody(response))
  if (!parsed.success) {
    throw new Error('The bug-report service returned an invalid receipt.')
  }
  return parsed.data
}
