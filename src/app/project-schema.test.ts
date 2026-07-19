import { describe, expect, it } from 'vitest'

import { appProjectSchema } from './project-schema'

function virtualManualProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const timestamp = '2026-07-17T00:00:00.000Z'
  return {
    id: '10000000-0000-4000-8000-000000000001',
    schemaVersion: 1,
    title: 'Validated virtual reference',
    createdAt: timestamp,
    updatedAt: timestamp,
    referenceName: 'Entered melody · synthesized locally',
    referenceAssetId: null,
    referenceMimeType: 'audio/wav',
    referenceDurationSeconds: 1,
    isSyntheticDemo: false,
    targetMode: 'manual',
    targetStatus: 'Authoritative target revision',
    targetSourceAssetId: null,
    targetSourceName: null,
    targetSourceMimeType: null,
    targetRevision: 1,
    transpositionSemitones: 0,
    alignmentSeconds: 0,
    timingOffsetSeconds: 0,
    notes: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        startSeconds: 0,
        endSeconds: 1,
        midiNote: 69,
        lyric: '',
        scorable: true,
      },
    ],
    targetPitchPoints: [],
    loops: [],
    takes: [],
    lastBackupAt: null,
    ...overrides,
  }
}

describe('virtual Manual reference schema', () => {
  it('accepts a self-contained note-only reference', () => {
    expect(appProjectSchema.safeParse(virtualManualProject()).success).toBe(true)
  })

  it('rejects a project whose alignment makes every note inaudible', () => {
    const result = appProjectSchema.safeParse(
      virtualManualProject({ alignmentSeconds: -2, referenceDurationSeconds: 0 }),
    )
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContainEqual(
        expect.stringMatching(/before the project starts/),
      )
  })

  it('rejects an inflated duration that could force an oversized render', () => {
    const result = appProjectSchema.safeParse(
      virtualManualProject({ referenceDurationSeconds: 1_200 }),
    )
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContainEqual(
        expect.stringMatching(/duration must match/),
      )
  })

  it('rejects pitches outside the live detector and synthesized-guide range', () => {
    const result = appProjectSchema.safeParse(
      virtualManualProject({
        notes: [
          {
            id: '20000000-0000-4000-8000-000000000001',
            startSeconds: 0,
            endSeconds: 1,
            midiNote: 100,
            lyric: '',
            scorable: true,
          },
        ],
      }),
    )
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContainEqual(
        expect.stringMatching(/80 to 1,200 Hz/),
      )
  })

  it('accepts bounded practice capture diagnostics while preserving legacy takes', () => {
    const baseTake = {
      id: '30000000-0000-4000-8000-000000000001',
      createdAt: '2026-07-17T00:00:01.000Z',
      label: 'Take 1',
      projectStartSeconds: 0,
      durationSeconds: 1,
      audioAssetId: '40000000-0000-4000-8000-000000000001',
      audioMimeType: 'audio/mp4',
      partialReason: null,
      points: [],
    }
    expect(appProjectSchema.safeParse(virtualManualProject({ takes: [baseTake] })).success).toBe(
      true,
    )
    expect(
      appProjectSchema.safeParse(
        virtualManualProject({
          takes: [
            {
              ...baseTake,
              captureDiagnostics: {
                captureProfile: 'raw',
                settings: {
                  sampleRate: 48_000,
                  channelCount: 1,
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
                playbackContextSampleRate: 48_000,
                recorderChunkCount: 2,
                recorderSmallestChunkBytes: 2_048,
                recorderLargestChunkBytes: 4_096,
                pcmSubmittedBatches: 10,
                pcmProcessedBatches: 10,
                pcmDroppedBatches: 0,
                pcmQueueHighWater: 2,
                pcmAbandonedBatches: 0,
                pcmDrainTimedOut: false,
              },
            },
          ],
        }),
      ).success,
    ).toBe(true)
  })
})
