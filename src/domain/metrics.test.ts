import { describe, expect, it } from 'vitest'

import { calculateMetricsReport, calculatePerformanceMetrics } from './metrics'
import type { ScoringObservation } from './observations'
import { METRICS_FORMULA_VERSION } from './versions'

function observation(
  timeSeconds: number,
  observedMidiNote: number | null,
  confidence: number | null = 0.9,
): ScoringObservation {
  return {
    timeSeconds,
    targetNoteId: 'note-a',
    targetMidiNote: 60,
    observedMidiNote,
    confidence,
    scorable: true,
    gapReason: observedMidiNote === null ? 'silence' : null,
  }
}

describe('transparent performance metrics', () => {
  const observations = [
    observation(0, 60),
    observation(0.02, 60.2),
    observation(0.04, 60.49),
    observation(0.06, 61),
    observation(0.08, null),
  ]
  const onsets = [
    { targetNoteId: 'note-a', targetTimeSeconds: 0, observedTimeSeconds: 0.05 },
    { targetNoteId: 'note-b', targetTimeSeconds: 1, observedTimeSeconds: null },
  ]

  it('reports accuracy bands, coverage, distribution, note, onset, and stability separately', () => {
    const metrics = calculatePerformanceMetrics(observations, onsets)
    expect(metrics.formulaVersion).toBe(METRICS_FORMULA_VERSION)
    expect(metrics.coverage).toBe(0.8)
    expect(metrics.within25Cents).toBe(0.5)
    expect(metrics.within50Cents).toBe(0.75)
    expect(metrics.within100Cents).toBe(1)
    expect(metrics.signedMeanErrorCents).toBeCloseTo(42.25)
    expect(metrics.meanAbsoluteErrorCents).toBeCloseTo(42.25)
    expect(metrics.p90AbsoluteErrorCents).toBeCloseTo(100)
    expect(metrics.longestAccurateSpanSeconds).toBeCloseTo(0.04)
    expect(metrics.noteAccuracy).toBe(1)
    expect(metrics.sustainedNoteStabilityCents).not.toBeNull()
    expect(metrics.onsetAccuracy).toBe(0.5)
    expect(metrics.meanAbsoluteOnsetErrorSeconds).toBeCloseTo(0.05)
  })

  it('produces independently inspectable section metrics', () => {
    const report = calculateMetricsReport(observations, onsets, [
      { id: 'opening', name: 'Opening', startSeconds: 0, endSeconds: 0.06 },
    ])
    expect(report.overall.scorablePointCount).toBe(5)
    expect(report.sections).toHaveLength(1)
    expect(report.sections[0]?.metrics.scorablePointCount).toBe(3)
    expect(report.sections[0]?.metrics.coverage).toBe(1)
  })

  it('uses null rather than fabricated zeroes when nothing is scorable', () => {
    const metrics = calculatePerformanceMetrics([])
    expect(metrics.coverage).toBeNull()
    expect(metrics.signedMeanErrorCents).toBeNull()
    expect(metrics.p90AbsoluteErrorCents).toBeNull()
    expect(metrics.longestAccurateSpanSeconds).toBeNull()
    expect(metrics.noteAccuracy).toBeNull()
  })
})
