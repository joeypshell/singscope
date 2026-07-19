import { describe, expect, it } from 'vitest'

import { DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS, DEFAULT_YIN_CONFIG } from '../audio/dsp'
import type { AppPitchPoint, AppTake } from '../app/types'
import { ANALYSIS_DEBUG_LIMITS } from './analysis-debug-package'
import {
  analysisDebugGapReason,
  createPracticeTakeAnalysisDebugEvidence,
} from './practice-take-analysis-debug'

const detectorVersion = 'yin-24k-practice-debug-test'

function point(timeSeconds: number, overrides: Partial<AppPitchPoint> = {}): AppPitchPoint {
  return {
    timeSeconds,
    contextTimeSeconds: 100 + timeSeconds,
    candidateHz: 440,
    frequencyHz: 440,
    midiNote: 69,
    confidence: 0.95,
    rms: 0.03,
    peak: 0.08,
    gapReason: null,
    detectorVersion,
    ...overrides,
  }
}

function take(points: readonly AppPitchPoint[], durationSeconds = 1): AppTake {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-07-19T12:00:00.000Z',
    label: 'Take 1',
    projectStartSeconds: 12,
    durationSeconds,
    audioAssetId: '00000000-0000-4000-8000-000000000002',
    audioMimeType: 'audio/mp4',
    partialReason: null,
    points,
  }
}

const segmentationConfig = Object.freeze({
  ...DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS,
  confidenceThreshold: 0.8,
})

describe('practice take analysis-debug evidence', () => {
  it('normalizes project time, preserves detector evidence, maps gaps, and derives notes', () => {
    const evidence = createPracticeTakeAnalysisDebugEvidence(
      take([
        point(12),
        point(12.02, { candidateHz: 441, frequencyHz: 441, midiNote: 69.039, peak: 0.09 }),
        point(12.04, { candidateHz: 442, frequencyHz: 442, midiNote: 69.078 }),
        point(12.06, { candidateHz: 443, frequencyHz: 443, midiNote: 69.117 }),
        point(12.08, {
          candidateHz: 438,
          frequencyHz: null,
          midiNote: null,
          confidence: 0.62,
          rms: 0.021,
          peak: 0.05,
          gapReason: 'below-confidence',
        }),
        point(12.1, {
          candidateHz: null,
          frequencyHz: null,
          midiNote: null,
          confidence: null,
          rms: 0,
          peak: 0,
          gapReason: 'timeline-gap',
        }),
      ]),
      { detectorVersion, detectorConfig: DEFAULT_YIN_CONFIG, segmentationConfig },
    )

    expect(evidence.analysis.durationSeconds).toBe(1)
    expect(evidence.analysis.contour).toHaveLength(6)
    expect(evidence.analysis.contour[0]).toEqual({
      timeSeconds: 0,
      candidateHz: 440,
      frequencyHz: 440,
      midiNote: 69,
      confidence: 0.95,
      rms: 0.03,
      peak: 0.08,
      gapReason: null,
    })
    expect(evidence.analysis.contour[1]).toMatchObject({
      candidateHz: 441,
      frequencyHz: 441,
      midiNote: 69.039,
      confidence: 0.95,
      rms: 0.03,
      peak: 0.09,
      gapReason: null,
    })
    expect(evidence.analysis.contour[1]?.timeSeconds).toBeCloseTo(0.02)
    expect(evidence.analysis.contour[4]).toMatchObject({
      candidateHz: 438,
      frequencyHz: null,
      confidence: 0.62,
      rms: 0.021,
      peak: 0.05,
      gapReason: 'low-confidence',
    })
    expect(evidence.analysis.contour[5]?.timeSeconds).toBeCloseTo(0.1)
    expect(evidence.analysis.contour[5]?.gapReason).toBe('source-gap')
    expect(evidence.analysis.candidateNotes).toEqual([
      expect.objectContaining({
        candidateKey: 'candidate-000001',
        startSeconds: 0,
        midiNote: 69,
        sourcePointStartIndex: 0,
        sourcePointEndIndex: 3,
      }),
    ])
    expect(evidence.detectorConfig).toEqual(DEFAULT_YIN_CONFIG)
    expect(evidence.segmentationConfig).toEqual(segmentationConfig)
  })

  it('maps every practice-only or future gap to an allowed analysis-debug reason', () => {
    expect(analysisDebugGapReason(null)).toBeNull()
    expect(analysisDebugGapReason('silence')).toBe('silence')
    expect(analysisDebugGapReason('below-confidence')).toBe('low-confidence')
    expect(analysisDebugGapReason('low-confidence')).toBe('low-confidence')
    expect(analysisDebugGapReason('out-of-range')).toBe('out-of-range')
    expect(analysisDebugGapReason('invalid-frame')).toBe('invalid-frame')
    expect(analysisDebugGapReason('timeline-gap')).toBe('source-gap')
    expect(analysisDebugGapReason('queue-overflow')).toBe('source-gap')
    expect(analysisDebugGapReason('future-practice-gap')).toBe('source-gap')
  })

  it('caps duration and retained points to the existing package limits', () => {
    const points = Array.from({ length: ANALYSIS_DEBUG_LIMITS.contourPoints + 250 }, (_, index) =>
      point(12 + index / 100, {
        candidateHz: null,
        frequencyHz: null,
        midiNote: null,
        confidence: null,
        gapReason: 'queue-overflow',
      }),
    )
    points.push(point(72.001))

    const evidence = createPracticeTakeAnalysisDebugEvidence(take(points, 90), {
      detectorVersion,
      detectorConfig: DEFAULT_YIN_CONFIG,
      segmentationConfig,
    })

    expect(evidence.analysis.durationSeconds).toBe(ANALYSIS_DEBUG_LIMITS.sourceDurationSeconds)
    expect(evidence.analysis.contour).toHaveLength(ANALYSIS_DEBUG_LIMITS.contourPoints)
    expect(evidence.analysis.contour[0]?.timeSeconds).toBe(0)
    expect(evidence.analysis.contour.at(-1)?.timeSeconds).toBeLessThanOrEqual(
      ANALYSIS_DEBUG_LIMITS.sourceDurationSeconds,
    )
    expect(evidence.analysis.candidateNotes).toEqual([])
  })

  it('orders retained points chronologically and rejects a mislabeled detector version', () => {
    const ordered = createPracticeTakeAnalysisDebugEvidence(
      take([point(12.04), point(12), point(12.02)]),
      { detectorVersion, detectorConfig: DEFAULT_YIN_CONFIG, segmentationConfig },
    )
    expect(ordered.analysis.contour.map(({ timeSeconds }) => timeSeconds)).toEqual([
      0, 0.019999999999999574, 0.03999999999999915,
    ])

    expect(() =>
      createPracticeTakeAnalysisDebugEvidence(
        take([point(12, { detectorVersion: 'older-detector' })]),
        { detectorVersion, detectorConfig: DEFAULT_YIN_CONFIG, segmentationConfig },
      ),
    ).toThrow(/different detector version/)
  })
})
