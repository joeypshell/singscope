import { describe, expect, it } from 'vitest'

import { detectedPitchPointSchema, loopRegionSchema, targetSetSchema } from './schemas'
import { LOOP_SCHEMA_VERSION, TARGET_SET_SCHEMA_VERSION } from './versions'

const ID_A = '018f5e22-cc7a-7c7c-8c2c-4cf891e44599'
const ID_B = '018f5e22-cc7a-7c7c-9c2c-4cf891e44599'

describe('versioned domain schemas', () => {
  it('rejects stale versions, impossible loop ranges, unknown fields, and NaN', () => {
    const valid = {
      schemaVersion: LOOP_SCHEMA_VERSION,
      id: ID_A,
      projectId: ID_B,
      name: 'Chorus',
      startSeconds: 2,
      endSeconds: 4,
      repeatCount: null,
    }
    expect(loopRegionSchema.safeParse(valid).success).toBe(true)
    expect(loopRegionSchema.safeParse({ ...valid, schemaVersion: 0 }).success).toBe(false)
    expect(loopRegionSchema.safeParse({ ...valid, endSeconds: 1 }).success).toBe(false)
    expect(loopRegionSchema.safeParse({ ...valid, startSeconds: Number.NaN }).success).toBe(false)
    expect(loopRegionSchema.safeParse({ ...valid, executable: '<script>' }).success).toBe(false)
  })

  it('requires sorted pitch points in an immutable target revision', () => {
    const result = targetSetSchema.safeParse({
      schemaVersion: TARGET_SET_SCHEMA_VERSION,
      id: ID_A,
      projectId: ID_B,
      revision: 2,
      kind: 'analyzed',
      status: 'draft',
      createdAt: '2026-07-13T17:00:00.000Z',
      sourceAssetId: null,
      parentTargetSetId: null,
      alignmentSeconds: -0.1,
      transposeSemitones: 0,
      notes: [],
      pitchPoints: [
        { timeSeconds: 1, frequencyHz: 440, midiNote: 69, confidence: 0.9 },
        { timeSeconds: 0, frequencyHz: 220, midiNote: 57, confidence: 0.9 },
      ],
    })
    expect(result.success).toBe(false)
  })

  it('does not allow an accepted pitch and a gap flag at the same point', () => {
    const result = detectedPitchPointSchema.safeParse({
      timeSeconds: 1,
      contextTimeSeconds: 10,
      candidateHz: 440,
      frequencyHz: 440,
      midiNote: 69,
      confidence: 0.9,
      rms: 0.1,
      peak: 0.2,
      gapReason: 'timeline-gap',
      detectorVersion: 'yin-24k-v1',
    })
    expect(result.success).toBe(false)
  })
})
