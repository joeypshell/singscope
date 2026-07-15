import { describe, expect, it } from 'vitest'

import { DEFAULT_YIN_CONFIG } from '../../src/audio/dsp/yin'
import { DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS } from '../../src/audio/dsp/monophonic'
import { createAnalysisDebugPackage } from '../../src/export/analysis-debug-package'
import { sha256Blob } from '../../src/persistence/hash'
import { sendAnalysisReport } from '../../src/report'

const endpoint = process.env['SINGSCOPE_LIVE_REPORT_ENDPOINT']?.trim()
const confirmed = process.env['SINGSCOPE_LIVE_REPORT_CONFIRM'] === 'true'
const liveDescribe =
  confirmed && endpoint !== undefined && endpoint !== '' ? describe : describe.skip
const productionOrigin = 'https://joeypshell.github.io'

async function fetchFromProductionOrigin(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Origin', productionOrigin)
  const normalizedInit: RequestInit = { ...init, headers }
  if (init?.body instanceof Blob) normalizedInit.body = await init.body.arrayBuffer()
  const response = await fetch(input, normalizedInit)
  if (!response.ok) {
    const candidate: unknown = await response
      .clone()
      .json()
      .catch(() => null)
    const code =
      typeof candidate === 'object' && candidate !== null && 'error' in candidate
        ? (candidate as { readonly error?: { readonly code?: unknown } }).error?.code
        : undefined
    console.info(
      `SINGSCOPE_LIVE_REPORT_REJECTION=${JSON.stringify({ status: response.status, code })}`,
    )
  }
  return response
}

liveDescribe('live Supabase analysis-report flow', () => {
  it('stores one valid synthetic package, returns an idempotent receipt, and rejects identity reuse', async () => {
    if (endpoint === undefined) throw new Error('The live report endpoint is required.')

    const sourceBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00,
      0x00,
    ])
    const prepared = await createAnalysisDebugPackage({
      audio: {
        blob: new Blob([sourceBytes], { type: 'audio/mp4;codecs=mp4a.40.2' }),
        extension: 'mp4',
      },
      analysis: {
        detectorVersion: 'yin-24k-live-synthetic',
        durationSeconds: 0.1,
        contour: [
          {
            timeSeconds: 0.052,
            candidateHz: 440,
            frequencyHz: 440,
            midiNote: 69,
            confidence: 0.99,
            rms: 0.04,
            peak: 0.08,
            gapReason: null,
          },
        ],
        candidateNotes: [
          {
            candidateKey: 'live-synthetic-a4',
            startSeconds: 0.04,
            endSeconds: 0.1,
            midiNote: 69,
            meanConfidence: 0.99,
            sourcePointStartIndex: 0,
            sourcePointEndIndex: 0,
            preservedGapCount: 0,
          },
        ],
      },
      detectorConfig: DEFAULT_YIN_CONFIG,
      segmentationConfig: DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS,
      createdAt: new Date().toISOString(),
      userReport: {
        expectedNoteCount: 1,
        description: 'Automated synthetic live verification; no user recording.',
      },
      browserMetadata: {
        userAgent: 'SingScope live verification',
        displayMode: 'browser',
      },
    })

    const input = {
      blob: prepared.blob,
      packageId: prepared.manifest.packageId,
      packageSha256: prepared.sha256,
    }
    const receipt = await sendAnalysisReport({ endpoint }, input, fetchFromProductionOrigin)
    const retryReceipt = await sendAnalysisReport({ endpoint }, input, fetchFromProductionOrigin)
    expect(retryReceipt).toEqual(receipt)

    const changedBlob = new Blob([prepared.blob, new Uint8Array([0])], {
      type: 'application/zip',
    })
    await expect(
      sendAnalysisReport(
        { endpoint },
        {
          blob: changedBlob,
          packageId: prepared.manifest.packageId,
          packageSha256: await sha256Blob(changedBlob),
        },
        fetchFromProductionOrigin,
      ),
    ).rejects.toThrow(/HTTP 409/u)

    console.info(
      `SINGSCOPE_LIVE_REPORT=${JSON.stringify({
        reportId: receipt.reportId,
        packageId: prepared.manifest.packageId,
        packageSha256: prepared.sha256,
        packageBytes: prepared.blob.size,
        receivedAt: receipt.receivedAt,
      })}`,
    )
  }, 180_000)
})
