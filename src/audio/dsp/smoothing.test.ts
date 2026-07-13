import { describe, expect, it } from 'vitest'

import type { DetectedPitchPoint } from '../../domain/types'
import { midiToFrequency } from '../../domain/pitch'
import { DETECTOR_VERSION } from '../../domain/versions'
import { PitchDisplaySmoother, smoothPitchForDisplay } from './smoothing'

function point(
  timeSeconds: number,
  midiNote: number | null,
  gapReason: DetectedPitchPoint['gapReason'] = null,
): DetectedPitchPoint {
  const frequencyHz = midiNote === null ? null : midiToFrequency(midiNote)
  return {
    timeSeconds,
    contextTimeSeconds: 10 + timeSeconds,
    candidateHz: frequencyHz,
    frequencyHz,
    midiNote,
    confidence: midiNote === null ? null : 0.95,
    rms: midiNote === null ? 0 : 0.1,
    peak: midiNote === null ? 0 : 0.2,
    gapReason,
    detectorVersion: DETECTOR_VERSION,
  }
}

describe('display-only pitch smoothing', () => {
  it('removes a one-frame octave outlier without changing raw measurements', () => {
    const raw = [point(0, 60), point(0.02, 60), point(0.04, 72)]
    const display = smoothPitchForDisplay(raw)
    expect(display[2]?.rawMidiNote).toBe(72)
    expect(display[2]?.smoothedMidiNote).toBeCloseTo(60)
    expect(raw[2]?.midiNote).toBe(72)
  })

  it('resets the median and EMA across explicit gaps', () => {
    const smoother = new PitchDisplaySmoother()
    smoother.push(point(0, 60))
    const gap = smoother.push(point(0.02, null, 'silence'))
    const resumed = smoother.push(point(0.04, 67))
    expect(gap.smoothedMidiNote).toBeNull()
    expect(resumed.smoothedMidiNote).toBe(67)
  })
})
