import { frequencyToMidi } from '../../domain/pitch'
import type { DetectedPitchPoint, PitchGapReason } from '../../domain/types'
import type { PitchDetector, PitchFrameAnalysis, PitchEstimateReason } from './contracts'
import { resampleLinear } from './resample'
import { YinPitchDetector } from './yin'

function reasonToGap(reason: PitchEstimateReason): PitchGapReason | null {
  switch (reason) {
    case null:
      return null
    case 'silence':
      return 'silence'
    case 'low-confidence':
      return 'below-confidence'
    case 'out-of-range':
      return 'out-of-range'
    case 'invalid-frame':
      return 'invalid-frame'
  }
}

export function analyzePcm(
  samples: Float32Array,
  sourceSampleRateHz: number,
  detector: PitchDetector = new YinPitchDetector(),
): readonly PitchFrameAnalysis[] {
  const sampleRate = detector.config.internalSampleRateHz
  const normalized = resampleLinear(samples, sourceSampleRateHz, sampleRate)
  const frameLength = Math.round(sampleRate * detector.config.frameDurationSeconds)
  const hopLength = Math.round(sampleRate * detector.config.hopDurationSeconds)
  if (frameLength <= 0 || hopLength <= 0)
    throw new RangeError('Invalid detector frame configuration')

  const analyses: PitchFrameAnalysis[] = []
  for (let offset = 0; offset + frameLength <= normalized.length; offset += hopLength) {
    const estimate = detector.detect(normalized.slice(offset, offset + frameLength), sampleRate)
    analyses.push({
      frameStartSample: offset,
      frameCenterSample: offset + frameLength / 2,
      frameStartSeconds: offset / sampleRate,
      frameCenterSeconds: (offset + frameLength / 2) / sampleRate,
      estimate,
    })
  }
  return analyses
}

export function analysisToDetectedPoint(
  analysis: PitchFrameAnalysis,
  contextStartSeconds: number,
  projectTimeAt: (contextTimeSeconds: number) => number | null,
  detectorVersion: string,
): DetectedPitchPoint {
  const contextTimeSeconds = contextStartSeconds + analysis.frameCenterSeconds
  const projectTimeSeconds = projectTimeAt(contextTimeSeconds)
  const frequencyHz = analysis.estimate.frequencyHz
  const timelineGap = projectTimeSeconds === null
  return {
    timeSeconds: projectTimeSeconds ?? analysis.frameCenterSeconds,
    contextTimeSeconds,
    candidateHz: analysis.estimate.candidateHz,
    frequencyHz: timelineGap ? null : frequencyHz,
    midiNote: timelineGap || frequencyHz === null ? null : frequencyToMidi(frequencyHz),
    confidence: analysis.estimate.confidence,
    rms: analysis.estimate.rms,
    peak: analysis.estimate.peak,
    gapReason: timelineGap ? 'timeline-gap' : reasonToGap(analysis.estimate.reason),
    detectorVersion,
  }
}
