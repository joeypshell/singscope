import type { PitchDetectorConfig } from '../audio/dsp/contracts'
import {
  segmentMonophonicContour,
  type CandidateSegmentationOptions,
  type MonophonicAnalysisResult,
  type MonophonicContourGapReason,
  type MonophonicContourPoint,
} from '../audio/dsp/monophonic'
import type { AppPitchPoint, AppTake } from '../app/types'
import { ANALYSIS_DEBUG_LIMITS } from './analysis-debug-package'

export interface PracticeTakeAnalysisDebugOptions {
  /** The detector version attached to every retained practice point. */
  readonly detectorVersion: string
  /** The exact detector configuration used while the take was captured. */
  readonly detectorConfig: PitchDetectorConfig
  /** The exact configuration to use when deriving readable candidate notes. */
  readonly segmentationConfig: CandidateSegmentationOptions
}

export interface PracticeTakeAnalysisDebugEvidence {
  readonly analysis: MonophonicAnalysisResult
  readonly detectorConfig: PitchDetectorConfig
  readonly segmentationConfig: CandidateSegmentationOptions
}

interface IndexedContourPoint {
  readonly sourceIndex: number
  readonly point: MonophonicContourPoint
}

/**
 * The practice pipeline has a few timeline-specific gap labels that the existing
 * analysis-debug schema cannot represent directly. They remain gaps, with
 * detector reasons retained where the two contracts have an exact equivalent.
 */
export function analysisDebugGapReason(
  reason: AppPitchPoint['gapReason'],
): MonophonicContourGapReason {
  if (reason === null) return null
  if (reason === 'silence' || reason === 'out-of-range' || reason === 'invalid-frame') {
    return reason
  }
  if (reason === 'below-confidence' || reason === 'low-confidence') {
    return 'low-confidence'
  }
  // Timeline gaps, queue overflow, and future practice-only reasons all mean
  // that the stored contour has a source interval that cannot be scored.
  return 'source-gap'
}

function normalizedPoint(
  point: AppPitchPoint,
  sourceIndex: number,
  projectStartSeconds: number,
  maximumDurationSeconds: number,
): IndexedContourPoint | null {
  const relativeTimeSeconds = point.timeSeconds - projectStartSeconds
  if (relativeTimeSeconds < 0 || relativeTimeSeconds > maximumDurationSeconds) return null
  return {
    sourceIndex,
    point: {
      timeSeconds: relativeTimeSeconds,
      candidateHz: point.candidateHz,
      frequencyHz: point.frequencyHz,
      midiNote: point.midiNote,
      confidence: point.confidence,
      rms: point.rms,
      peak: point.peak,
      gapReason: analysisDebugGapReason(point.gapReason),
    },
  }
}

/**
 * Converts one validated, persisted practice take into the analysis portion of
 * the existing debug-package contract. Audio and sanitized browser/capture
 * metadata are supplied separately by the caller.
 */
export function createPracticeTakeAnalysisDebugEvidence(
  take: AppTake,
  options: PracticeTakeAnalysisDebugOptions,
): PracticeTakeAnalysisDebugEvidence {
  const detectorVersion = options.detectorVersion.trim()
  if (detectorVersion.length === 0) throw new RangeError('Detector version is required.')

  const durationSeconds = Math.min(
    ANALYSIS_DEBUG_LIMITS.sourceDurationSeconds,
    Math.max(0, take.durationSeconds),
  )
  const indexedContour = take.points
    .map((point, sourceIndex) =>
      normalizedPoint(point, sourceIndex, take.projectStartSeconds, durationSeconds),
    )
    .filter((value): value is IndexedContourPoint => value !== null)
    .sort(
      (left, right) =>
        left.point.timeSeconds - right.point.timeSeconds || left.sourceIndex - right.sourceIndex,
    )
    .slice(0, ANALYSIS_DEBUG_LIMITS.contourPoints)

  const mismatchedVersion = indexedContour.find(
    ({ sourceIndex }) => take.points[sourceIndex]?.detectorVersion !== detectorVersion,
  )
  if (mismatchedVersion !== undefined) {
    throw new Error('Practice take contains pitch points from a different detector version.')
  }

  const detectorConfig = Object.freeze({ ...options.detectorConfig })
  const segmentationConfig = Object.freeze({ ...options.segmentationConfig })
  const contour = indexedContour.map(({ point }) => point)
  const candidateNotes = segmentMonophonicContour(contour, segmentationConfig)
    .slice(0, ANALYSIS_DEBUG_LIMITS.candidateNotes)
    .map((note) => ({
      ...note,
      startSeconds: Math.max(0, Math.min(durationSeconds, note.startSeconds)),
      endSeconds: Math.max(0, Math.min(durationSeconds, note.endSeconds)),
    }))

  return {
    analysis: {
      detectorVersion,
      durationSeconds,
      contour,
      candidateNotes,
    },
    detectorConfig,
    segmentationConfig,
  }
}
