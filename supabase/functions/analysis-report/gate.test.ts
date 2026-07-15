import { describe, expect, it } from 'vitest'

import { RequestProblem, type ValidatedReportRequest } from './contract.ts'
import { issueReportTicket, validateReportTicketAndProof } from './gate.ts'

const SECRET = 'server-only-test-key-material-at-least-32-bytes'
const NOW = new Date('2026-07-15T01:00:00.000Z')
const REQUEST: ValidatedReportRequest = {
  packageId: '9bba8fce-7c65-4ed6-ae62-2f2046d6e2d8',
  packageSha256: 'a'.repeat(64),
  packageBytes: 4_096,
  schemaVersion: 1,
  declaredLength: null,
}

async function solveProof(ticket: string, difficulty: number): Promise<string> {
  const encoder = new TextEncoder()
  for (let nonce = 0; nonce < 100_000; nonce += 1) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(`${ticket}.${nonce.toString()}`)),
    )
    const fullBytes = Math.floor(difficulty / 8)
    let valid = true
    for (let index = 0; index < fullBytes; index += 1) {
      if (digest[index] !== 0) valid = false
    }
    const remaining = difficulty % 8
    if (
      valid &&
      (remaining === 0 || ((digest[fullBytes] ?? 0xff) & (0xff << (8 - remaining))) === 0)
    ) {
      return nonce.toString()
    }
  }
  throw new Error('The low-difficulty test proof was not found.')
}

function uploadHeaders(ticket: string, proof: string): Headers {
  return new Headers({
    'X-SingScope-Report-Ticket': ticket,
    'X-SingScope-Report-Proof': proof,
  })
}

describe('analysis report pre-body gate', () => {
  it('issues a short-lived identity-bound HMAC ticket and verifies its proof', async () => {
    const issued = await issueReportTicket(REQUEST, SECRET, {
      now: NOW,
      ticketId: '68215cf5-5c4c-4a5b-8a95-2176377db501',
      difficulty: 4,
    })
    expect(issued).toMatchObject({
      format: 'singscope-analysis-report-ticket',
      schemaVersion: 1,
      difficulty: 4,
      expiresAt: '2026-07-15T01:02:00.000Z',
    })
    const proof = await solveProof(issued.ticket, issued.difficulty)
    await expect(
      validateReportTicketAndProof(
        uploadHeaders(issued.ticket, proof),
        REQUEST,
        SECRET,
        new Date('2026-07-15T01:00:30.000Z'),
      ),
    ).resolves.toMatchObject({
      ticketId: '68215cf5-5c4c-4a5b-8a95-2176377db501',
      packageId: REQUEST.packageId,
      packageBytes: REQUEST.packageBytes,
      difficulty: 4,
    })
  })

  it('rejects tampering, identity substitution, weak proof, and expiry', async () => {
    const issued = await issueReportTicket(REQUEST, SECRET, {
      now: NOW,
      ticketId: '68215cf5-5c4c-4a5b-8a95-2176377db501',
      difficulty: 4,
    })
    const proof = await solveProof(issued.ticket, issued.difficulty)
    const last = issued.ticket.at(-1)
    const tampered = `${issued.ticket.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`

    for (const attempt of [
      () => validateReportTicketAndProof(uploadHeaders(tampered, proof), REQUEST, SECRET, NOW),
      () =>
        validateReportTicketAndProof(
          uploadHeaders(issued.ticket, proof),
          { ...REQUEST, packageBytes: REQUEST.packageBytes + 1 },
          SECRET,
          NOW,
        ),
      () =>
        validateReportTicketAndProof(
          new Headers({ 'X-SingScope-Report-Ticket': issued.ticket }),
          REQUEST,
          SECRET,
          NOW,
        ),
      () =>
        validateReportTicketAndProof(
          uploadHeaders(issued.ticket, proof),
          REQUEST,
          SECRET,
          new Date('2026-07-15T01:02:00.000Z'),
        ),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(RequestProblem)
    }
  })

  it('does not accept a short or different server secret', async () => {
    await expect(issueReportTicket(REQUEST, 'short', { now: NOW })).rejects.toThrow(/too short/i)
    const issued = await issueReportTicket(REQUEST, SECRET, {
      now: NOW,
      difficulty: 4,
    })
    const proof = await solveProof(issued.ticket, issued.difficulty)
    await expect(
      validateReportTicketAndProof(
        uploadHeaders(issued.ticket, proof),
        REQUEST,
        'a-different-server-key-material-long-enough',
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'REPORT_TICKET_INVALID', status: 403 })
  })
})
