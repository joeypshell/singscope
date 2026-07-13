import { describe, expect, it, vi } from 'vitest'

import type { PitchDetector, PitchEstimate } from './contracts'
import { analysisToDetectedPoint, analyzePcm } from './analyze'

const baseEstimate: PitchEstimate = {
  candidateHz: 440,
  frequencyHz: 440,
  confidence: 0.9,
  periodSamples: 54.5,
  rms: 0.2,
  peak: 0.4,
  reason: null,
}

function detector(overrides: Partial<PitchDetector> = {}): PitchDetector {
  return {
    version: 'test-detector',
    config: {
      internalSampleRateHz: 1_000,
      frameDurationSeconds: 0.1,
      hopDurationSeconds: 0.05,
      minimumFrequencyHz: 80,
      maximumFrequencyHz: 1_200,
      yinThreshold: 0.1,
      confidenceThreshold: 0.75,
      minimumRms: 0.001,
      noiseGateMultiplier: 2,
      noiseFloorAdaptation: 0.1,
    },
    detect: vi.fn(() => baseEstimate),
    reset: vi.fn(),
    ...overrides,
  }
}

describe('analysis pipeline mapping', () => {
  it('normalizes PCM, emits deterministic frame stamps, and retains estimates', () => {
    const testDetector = detector()
    const frames = analyzePcm(new Float32Array(200), 1_000, testDetector)

    expect(frames).toHaveLength(3)
    expect(frames[0]).toMatchObject({
      frameStartSample: 0,
      frameCenterSample: 50,
      frameStartSeconds: 0,
      frameCenterSeconds: 0.05,
      estimate: baseEstimate,
    })
    expect(frames[2]?.frameStartSample).toBe(100)
    expect(testDetector.detect).toHaveBeenCalledTimes(3)
  })

  it.each([
    [null, null],
    ['silence', 'silence'],
    ['low-confidence', 'below-confidence'],
    ['out-of-range', 'out-of-range'],
    ['invalid-frame', 'invalid-frame'],
  ] as const)('maps detector reason %s to an inspectable gap', (reason, gapReason) => {
    const estimate: PitchEstimate = {
      ...baseEstimate,
      frequencyHz: reason === null ? 440 : null,
      reason,
    }
    const point = analysisToDetectedPoint(
      {
        frameStartSample: 0,
        frameCenterSample: 50,
        frameStartSeconds: 0,
        frameCenterSeconds: 0.05,
        estimate,
      },
      10,
      (contextTime) => contextTime - 9,
      'detector-v1',
    )

    expect(point.timeSeconds).toBeCloseTo(1.05)
    expect(point.contextTimeSeconds).toBeCloseTo(10.05)
    expect(point.gapReason).toBe(gapReason)
    expect(point.midiNote === null).toBe(reason !== null)
  })

  it('preserves the raw candidate but marks an unmapped timeline interval as a gap', () => {
    const point = analysisToDetectedPoint(
      {
        frameStartSample: 0,
        frameCenterSample: 50,
        frameStartSeconds: 0,
        frameCenterSeconds: 0.05,
        estimate: baseEstimate,
      },
      4,
      () => null,
      'detector-v1',
    )

    expect(point).toMatchObject({
      timeSeconds: 0.05,
      contextTimeSeconds: 4.05,
      candidateHz: 440,
      frequencyHz: null,
      midiNote: null,
      gapReason: 'timeline-gap',
    })
  })

  it.each([
    ['frame', { frameDurationSeconds: 0 }],
    ['hop', { hopDurationSeconds: 0 }],
  ])('rejects an invalid %s configuration', (_label, configOverride) => {
    const base = detector()
    const invalid = detector({ config: { ...base.config, ...configOverride } })
    expect(() => analyzePcm(new Float32Array(200), 1_000, invalid)).toThrow(
      'Invalid detector frame configuration',
    )
  })
})
