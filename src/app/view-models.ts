import {
  buildScoringObservations,
  calculateMetricsReport,
  centsBetweenMidi,
  midiNoteName,
  midiToFrequency,
  type DetectedPitchPoint,
  type MetricsReport,
  type TargetSet,
} from '../domain'
import { smoothPitchForDisplay } from '../audio/dsp'
import {
  DETECTOR_VERSION,
  METRICS_FORMULA_VERSION,
  TARGET_SET_SCHEMA_VERSION,
} from '../domain/versions'
import type { MetricDisplay, PitchChartScene, ReviewPointView } from '../features'
import type { AppPitchPoint, AppProject, AppTake } from './types'

function detected(points: readonly AppPitchPoint[]): readonly DetectedPitchPoint[] {
  return points.map((point) => ({
    ...point,
    gapReason:
      point.gapReason === 'silence' ||
      point.gapReason === 'below-confidence' ||
      point.gapReason === 'out-of-range' ||
      point.gapReason === 'invalid-frame' ||
      point.gapReason === 'timeline-gap' ||
      point.gapReason === 'queue-overflow'
        ? point.gapReason
        : point.frequencyHz === null
          ? 'invalid-frame'
          : null,
  }))
}

export function toTargetSet(project: AppProject): TargetSet {
  return {
    schemaVersion: TARGET_SET_SCHEMA_VERSION,
    id: project.id,
    projectId: project.id,
    revision: project.targetRevision,
    kind: project.targetMode === 'isolated-vocal' ? 'analyzed' : project.targetMode,
    status: 'active',
    createdAt: project.createdAt,
    sourceAssetId: null,
    parentTargetSetId: null,
    alignmentSeconds: project.alignmentSeconds,
    transposeSemitones: project.transpositionSemitones,
    notes: project.notes.map((note) => ({
      id: note.id,
      startSeconds: note.startSeconds,
      endSeconds: note.endSeconds,
      midiNote: note.midiNote,
      lyric: note.lyric || null,
      sourceTrack: null,
      scorable: note.scorable,
    })),
    pitchPoints: project.targetPitchPoints,
  }
}

function gapsFrom(points: readonly AppPitchPoint[]): PitchChartScene['gaps'] {
  const gaps: { startSeconds: number; endSeconds: number }[] = []
  let start: number | null = null
  let end = 0
  for (const point of points) {
    if (point.frequencyHz === null || point.gapReason !== null) {
      start ??= point.timeSeconds
      end = point.timeSeconds + 0.02
    } else if (start !== null) {
      gaps.push({ startSeconds: start, endSeconds: end })
      start = null
    }
  }
  if (start !== null) gaps.push({ startSeconds: start, endSeconds: end })
  return gaps
}

export function projectScene(
  project: AppProject,
  points: readonly AppPitchPoint[],
  playheadSeconds: number,
  review = false,
  mode: 'pitch' | 'cents' = 'pitch',
  zoom = 1,
): PitchChartScene {
  const duration = Math.max(1, project.referenceDurationSeconds)
  const windowSeconds = review ? duration / Math.max(1, zoom) : Math.min(10, duration)
  const startSeconds = review
    ? Math.max(0, Math.min(duration - windowSeconds, playheadSeconds - windowSeconds / 2))
    : Math.max(0, Math.min(duration - windowSeconds, playheadSeconds - windowSeconds * 0.42))
  const display = smoothPitchForDisplay(detected(points))
  return {
    viewport: { startSeconds, endSeconds: startSeconds + windowSeconds, minMidi: 48, maxMidi: 76 },
    targets: project.notes.map((note) => ({
      startSeconds: Math.max(0, note.startSeconds + project.alignmentSeconds),
      endSeconds: Math.max(0, note.endSeconds + project.alignmentSeconds),
      frequencyHz: midiToFrequency(note.midiNote + project.transpositionSemitones) ?? 440,
      label:
        note.lyric.length > 0
          ? note.lyric
          : (midiNoteName(note.midiNote + project.transpositionSemitones) ?? undefined),
    })),
    raw: points.map((point) => ({
      timeSeconds: point.timeSeconds + project.timingOffsetSeconds,
      frequencyHz: point.frequencyHz,
      confidence: point.confidence ?? 0,
    })),
    smoothed: display.map((point) => ({
      timeSeconds: point.timeSeconds + project.timingOffsetSeconds,
      frequencyHz: point.smoothedFrequencyHz,
      confidence: point.confidence ?? 0,
    })),
    gaps: gapsFrom(points),
    playheadSeconds,
    mode,
  }
}

function percent(value: number | null): string {
  return value === null ? 'Not enough data' : `${Math.round(value * 100)}%`
}

function cents(value: number | null): string {
  return value === null ? 'Not enough data' : `${value > 0 ? '+' : ''}${Math.round(value)}¢`
}

function seconds(value: number | null): string {
  return value === null ? 'Not enough data' : `${value.toFixed(2)}s`
}

export function metricDisplays(report: MetricsReport['overall']): readonly MetricDisplay[] {
  return [
    {
      id: 'within25',
      label: 'Within ±25 cents',
      value: percent(report.within25Cents),
      detail: 'Confident voiced frames',
    },
    {
      id: 'within50',
      label: 'Within ±50 cents',
      value: percent(report.within50Cents),
      detail: 'Selected accuracy band',
    },
    { id: 'within100', label: 'Within ±100 cents', value: percent(report.within100Cents) },
    { id: 'coverage', label: 'Voiced coverage', value: percent(report.coverage) },
    {
      id: 'signed',
      label: 'Mean tendency',
      value: cents(report.signedMeanErrorCents),
      detail: 'Negative is flat; positive is sharp',
    },
    { id: 'absolute', label: 'Mean absolute error', value: cents(report.meanAbsoluteErrorCents) },
    { id: 'p90', label: '90th percentile error', value: cents(report.p90AbsoluteErrorCents) },
    {
      id: 'span',
      label: 'Longest accurate span',
      value: seconds(report.longestAccurateSpanSeconds),
    },
    { id: 'notes', label: 'Accurate target notes', value: percent(report.noteAccuracy) },
    { id: 'onsets', label: 'On-time entrances', value: percent(report.onsetAccuracy) },
    {
      id: 'stability',
      label: 'Sustained-note stability',
      value: cents(report.sustainedNoteStabilityCents),
    },
  ]
}

export function takeMetrics(project: AppProject, take: AppTake): MetricsReport {
  const target = toTargetSet(project)
  const observations = buildScoringObservations(detected(take.points), target)
  const onsets = project.notes.map((note) => {
    const start = note.startSeconds + project.alignmentSeconds
    const observed = take.points.find(
      (point) =>
        point.timeSeconds >= start - 0.2 &&
        point.timeSeconds <= start + 0.5 &&
        (point.confidence ?? 0) >= 0.75,
    )
    return {
      targetNoteId: note.id,
      targetTimeSeconds: start,
      observedTimeSeconds: observed?.timeSeconds ?? null,
    }
  })
  return calculateMetricsReport(
    observations,
    onsets,
    project.loops.map((loop) => ({
      id: loop.id,
      name: loop.name,
      startSeconds: loop.startSeconds,
      endSeconds: loop.endSeconds,
    })),
  )
}

export function inspectedPoint(
  project: AppProject,
  take: AppTake,
  timeSeconds: number,
): ReviewPointView | null {
  const point = [...take.points].sort(
    (a, b) => Math.abs(a.timeSeconds - timeSeconds) - Math.abs(b.timeSeconds - timeSeconds),
  )[0]
  if (!point || Math.abs(point.timeSeconds - timeSeconds) > 0.15) return null
  const target = project.notes.find(
    (note) =>
      timeSeconds >= note.startSeconds + project.alignmentSeconds &&
      timeSeconds < note.endSeconds + project.alignmentSeconds,
  )
  const targetMidi = target ? target.midiNote + project.transpositionSemitones : null
  const targetFrequencyHz = targetMidi === null ? null : midiToFrequency(targetMidi)
  return {
    timeSeconds: point.timeSeconds,
    frequencyHz: point.frequencyHz,
    confidence: point.confidence ?? 0,
    targetFrequencyHz,
    centsError:
      point.midiNote === null || targetMidi === null
        ? null
        : centsBetweenMidi(point.midiNote, targetMidi),
    noteLabel: point.midiNote === null ? null : midiNoteName(point.midiNote),
  }
}

export { DETECTOR_VERSION, METRICS_FORMULA_VERSION }
