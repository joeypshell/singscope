import type { PerformanceMetrics } from './types'
import type { ScoringObservation } from './observations'
import { METRICS_FORMULA_VERSION } from './versions'

export interface NoteOnsetObservation {
  readonly targetNoteId: string
  readonly targetTimeSeconds: number
  readonly observedTimeSeconds: number | null
}

export interface MetricSection {
  readonly id: string
  readonly name: string
  readonly startSeconds: number
  readonly endSeconds: number
}

export interface MetricsOptions {
  readonly confidenceThreshold?: number
  readonly accuratePointThresholdCents?: number
  readonly maximumAccurateGapSeconds?: number
  readonly minimumNoteCoverage?: number
  readonly onsetToleranceSeconds?: number
}

export interface SectionPerformanceMetrics {
  readonly sectionId: string
  readonly sectionName: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly metrics: PerformanceMetrics
}

export interface MetricsReport {
  readonly overall: PerformanceMetrics
  readonly sections: readonly SectionPerformanceMetrics[]
}

interface ResolvedMetricsOptions {
  confidenceThreshold: number
  accuratePointThresholdCents: number
  maximumAccurateGapSeconds: number
  minimumNoteCoverage: number
  onsetToleranceSeconds: number
}

interface ScoredPoint {
  observation: ScoringObservation
  errorCents: number
}

const DEFAULT_OPTIONS: ResolvedMetricsOptions = {
  confidenceThreshold: 0.75,
  accuratePointThresholdCents: 50,
  maximumAccurateGapSeconds: 0.08,
  minimumNoteCoverage: 0.5,
  onsetToleranceSeconds: 0.1,
}

function resolveOptions(options: MetricsOptions): ResolvedMetricsOptions {
  const result = { ...DEFAULT_OPTIONS, ...options }
  if (!(result.confidenceThreshold >= 0 && result.confidenceThreshold <= 1)) {
    throw new RangeError('confidenceThreshold must be between zero and one')
  }
  if (!(result.accuratePointThresholdCents > 0)) {
    throw new RangeError('accuratePointThresholdCents must be positive')
  }
  if (!(result.maximumAccurateGapSeconds > 0)) {
    throw new RangeError('maximumAccurateGapSeconds must be positive')
  }
  if (!(result.minimumNoteCoverage >= 0 && result.minimumNoteCoverage <= 1)) {
    throw new RangeError('minimumNoteCoverage must be between zero and one')
  }
  if (!(result.onsetToleranceSeconds >= 0)) {
    throw new RangeError('onsetToleranceSeconds must not be negative')
  }
  return result
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Uses the nearest-rank definition so a displayed value is always an observed error. */
export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0 || !Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[index] ?? null
}

function longestAccurateSpan(
  points: readonly ScoredPoint[],
  options: ResolvedMetricsOptions,
): number | null {
  let best: number | null = null
  let runStart: number | null = null
  let previous: number | null = null

  for (const point of [...points].sort(
    (left, right) => left.observation.timeSeconds - right.observation.timeSeconds,
  )) {
    const accurate = Math.abs(point.errorCents) <= options.accuratePointThresholdCents
    const time = point.observation.timeSeconds
    if (!accurate || (previous !== null && time - previous > options.maximumAccurateGapSeconds)) {
      runStart = accurate ? time : null
    } else {
      runStart ??= time
    }
    previous = accurate ? time : null
    if (accurate && runStart !== null) best = Math.max(best ?? 0, time - runStart)
  }
  return best
}

function noteAndStabilityMetrics(
  scorable: readonly ScoringObservation[],
  confident: readonly ScoredPoint[],
  options: ResolvedMetricsOptions,
): Pick<
  PerformanceMetrics,
  'accurateNoteCount' | 'scorableNoteCount' | 'noteAccuracy' | 'sustainedNoteStabilityCents'
> {
  const expectedByNote = new Map<string, number>()
  const scoredByNote = new Map<string, number[]>()
  for (const observation of scorable) {
    if (observation.targetNoteId === null) continue
    expectedByNote.set(
      observation.targetNoteId,
      (expectedByNote.get(observation.targetNoteId) ?? 0) + 1,
    )
  }
  for (const point of confident) {
    const noteId = point.observation.targetNoteId
    if (noteId === null) continue
    const values = scoredByNote.get(noteId) ?? []
    values.push(point.errorCents)
    scoredByNote.set(noteId, values)
  }

  let accurateNoteCount = 0
  let squaredResidualTotal = 0
  let stabilityPointCount = 0
  for (const [noteId, expectedCount] of expectedByNote) {
    const errors = scoredByNote.get(noteId) ?? []
    const absoluteMedian = nearestRankPercentile(
      errors.map((error) => Math.abs(error)),
      0.5,
    )
    if (
      absoluteMedian !== null &&
      absoluteMedian <= options.accuratePointThresholdCents &&
      errors.length / expectedCount >= options.minimumNoteCoverage
    ) {
      accurateNoteCount += 1
    }
    if (errors.length >= 3) {
      const noteMean = mean(errors)
      if (noteMean !== null) {
        squaredResidualTotal += errors.reduce((sum, error) => sum + (error - noteMean) ** 2, 0)
        stabilityPointCount += errors.length
      }
    }
  }

  const scorableNoteCount = expectedByNote.size
  return {
    accurateNoteCount,
    scorableNoteCount,
    noteAccuracy: ratio(accurateNoteCount, scorableNoteCount),
    sustainedNoteStabilityCents:
      stabilityPointCount === 0 ? null : Math.sqrt(squaredResidualTotal / stabilityPointCount),
  }
}

function calculateOne(
  observations: readonly ScoringObservation[],
  onsets: readonly NoteOnsetObservation[],
  options: ResolvedMetricsOptions,
): PerformanceMetrics {
  const scorable = observations.filter(
    (observation) => observation.scorable && observation.targetMidiNote !== null,
  )
  const confident: ScoredPoint[] = []
  for (const observation of scorable) {
    if (
      observation.observedMidiNote === null ||
      observation.targetMidiNote === null ||
      observation.confidence === null ||
      observation.confidence < options.confidenceThreshold
    ) {
      continue
    }
    confident.push({
      observation,
      errorCents: (observation.observedMidiNote - observation.targetMidiNote) * 100,
    })
  }

  const errors = confident.map((point) => point.errorCents)
  const absoluteErrors = errors.map(Math.abs)
  const onsetErrors = onsets.flatMap((onset) =>
    onset.observedTimeSeconds === null
      ? []
      : [Math.abs(onset.observedTimeSeconds - onset.targetTimeSeconds)],
  )
  const accurateOnsetCount = onsetErrors.filter(
    (error) => error <= options.onsetToleranceSeconds,
  ).length
  const noteMetrics = noteAndStabilityMetrics(scorable, confident, options)

  return {
    formulaVersion: METRICS_FORMULA_VERSION,
    confidenceThreshold: options.confidenceThreshold,
    scorablePointCount: scorable.length,
    confidentPointCount: confident.length,
    coverage: ratio(confident.length, scorable.length),
    within25Cents: ratio(absoluteErrors.filter((error) => error <= 25).length, confident.length),
    within50Cents: ratio(absoluteErrors.filter((error) => error <= 50).length, confident.length),
    within100Cents: ratio(absoluteErrors.filter((error) => error <= 100).length, confident.length),
    signedMeanErrorCents: mean(errors),
    meanAbsoluteErrorCents: mean(absoluteErrors),
    p90AbsoluteErrorCents: nearestRankPercentile(absoluteErrors, 0.9),
    longestAccurateSpanSeconds: longestAccurateSpan(confident, options),
    ...noteMetrics,
    accurateOnsetCount,
    scorableOnsetCount: onsets.length,
    onsetAccuracy: ratio(accurateOnsetCount, onsets.length),
    meanAbsoluteOnsetErrorSeconds: mean(onsetErrors),
  }
}

export function calculatePerformanceMetrics(
  observations: readonly ScoringObservation[],
  onsets: readonly NoteOnsetObservation[] = [],
  options: MetricsOptions = {},
): PerformanceMetrics {
  return calculateOne(observations, onsets, resolveOptions(options))
}

export function calculateMetricsReport(
  observations: readonly ScoringObservation[],
  onsets: readonly NoteOnsetObservation[],
  sections: readonly MetricSection[],
  options: MetricsOptions = {},
): MetricsReport {
  const resolved = resolveOptions(options)
  return {
    overall: calculateOne(observations, onsets, resolved),
    sections: sections.map((section) => ({
      sectionId: section.id,
      sectionName: section.name,
      startSeconds: section.startSeconds,
      endSeconds: section.endSeconds,
      metrics: calculateOne(
        observations.filter(
          (observation) =>
            observation.timeSeconds >= section.startSeconds &&
            observation.timeSeconds < section.endSeconds,
        ),
        onsets.filter(
          (onset) =>
            onset.targetTimeSeconds >= section.startSeconds &&
            onset.targetTimeSeconds < section.endSeconds,
        ),
        resolved,
      ),
    })),
  }
}
