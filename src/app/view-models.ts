import {
  buildScoringObservations,
  calculateMetricsReport,
  centsBetweenMidi,
  frequencyToMidi,
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
    sourceAssetId: project.targetSourceAssetId,
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

function gapsFrom(
  points: readonly AppPitchPoint[],
  transformTime: (seconds: number) => number,
): PitchChartScene['gaps'] {
  const gaps: { startSeconds: number; endSeconds: number }[] = []
  let start: number | null = null
  let end = 0
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!point) continue
    if (point.frequencyHz === null || point.gapReason !== null) {
      start ??= transformTime(point.timeSeconds)
      end = transformTime(points[index + 1]?.timeSeconds ?? point.timeSeconds + 0.02)
    } else if (start !== null) {
      gaps.push({ startSeconds: start, endSeconds: end })
      start = null
    }
  }
  if (start !== null) gaps.push({ startSeconds: start, endSeconds: end })
  return gaps
}

function targetGapsFrom(
  points: AppProject['targetPitchPoints'],
  transformTime: (seconds: number) => number,
): PitchChartScene['gaps'] {
  const gaps: { startSeconds: number; endSeconds: number }[] = []
  let start: number | null = null
  let end = 0
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!point) continue
    if (point.frequencyHz === null) {
      start ??= transformTime(point.timeSeconds)
      end = transformTime(points[index + 1]?.timeSeconds ?? point.timeSeconds + 0.02)
    } else if (start !== null) {
      gaps.push({ startSeconds: start, endSeconds: end })
      start = null
    }
  }
  if (start !== null) gaps.push({ startSeconds: start, endSeconds: end })
  return gaps
}

function pitchBounds(frequencies: readonly (number | null)[]): {
  minMidi: number
  maxMidi: number
} {
  let lowestMidi = Number.POSITIVE_INFINITY
  let highestMidi = Number.NEGATIVE_INFINITY
  for (const frequencyHz of frequencies) {
    if (frequencyHz === null || !Number.isFinite(frequencyHz) || frequencyHz <= 0) continue
    const midi = frequencyToMidi(frequencyHz)
    if (midi === null) continue
    lowestMidi = Math.min(lowestMidi, midi)
    highestMidi = Math.max(highestMidi, midi)
  }
  if (!Number.isFinite(lowestMidi) || !Number.isFinite(highestMidi)) {
    return { minMidi: 48, maxMidi: 76 }
  }
  let minMidi = Math.floor(lowestMidi) - 2
  let maxMidi = Math.ceil(highestMidi) + 2
  if (maxMidi - minMidi < 12) {
    const center = (minMidi + maxMidi) / 2
    minMidi = Math.floor(center - 6)
    maxMidi = Math.ceil(center + 6)
  }
  if (minMidi < 0) {
    maxMidi -= minMidi
    minMidi = 0
  }
  if (maxMidi > 127) {
    minMidi -= maxMidi - 127
    maxMidi = 127
  }
  return { minMidi: Math.max(0, minMidi), maxMidi: Math.min(127, maxMidi) }
}

interface SceneTimeline {
  readonly durationSeconds: number
  readonly originSeconds: number
}

function buildProjectScene(
  project: AppProject,
  points: readonly AppPitchPoint[],
  playheadSeconds: number,
  review: boolean,
  mode: 'pitch' | 'cents',
  zoom: number,
  timeline: SceneTimeline,
): PitchChartScene {
  const duration = Math.max(0.02, timeline.durationSeconds)
  const windowSeconds = review ? duration / Math.max(1, zoom) : Math.min(10, duration)
  const startSeconds = review
    ? Math.max(0, Math.min(duration - windowSeconds, playheadSeconds - windowSeconds / 2))
    : Math.max(0, Math.min(duration - windowSeconds, playheadSeconds - windowSeconds * 0.42))
  const observedTime = (seconds: number) =>
    seconds + project.timingOffsetSeconds - timeline.originSeconds
  const targetTime = (seconds: number) =>
    seconds + project.alignmentSeconds - timeline.originSeconds
  const display = smoothPitchForDisplay(detected(points))
  const targets = project.notes.map((note) => ({
    startSeconds: targetTime(note.startSeconds),
    endSeconds: targetTime(note.endSeconds),
    frequencyHz: midiToFrequency(note.midiNote + project.transpositionSemitones) ?? 440,
    label:
      note.lyric.length > 0
        ? note.lyric
        : (midiNoteName(note.midiNote + project.transpositionSemitones) ?? undefined),
  }))
  const source = project.targetPitchPoints.map((point) => ({
    timeSeconds: targetTime(point.timeSeconds),
    frequencyHz: point.frequencyHz,
    confidence: point.confidence ?? 0,
  }))
  const raw = points.map((point) => ({
    timeSeconds: observedTime(point.timeSeconds),
    frequencyHz: point.candidateHz,
    confidence: point.confidence ?? 0,
  }))
  const smoothed = display.map((point) => ({
    timeSeconds: observedTime(point.timeSeconds),
    frequencyHz: point.smoothedFrequencyHz,
    confidence: point.confidence ?? 0,
  }))
  const bounds = pitchBounds([
    ...targets
      .filter(
        (target) =>
          target.endSeconds >= startSeconds && target.startSeconds <= startSeconds + windowSeconds,
      )
      .map((target) => target.frequencyHz),
    ...source
      .filter(
        (point) =>
          point.timeSeconds >= startSeconds && point.timeSeconds <= startSeconds + windowSeconds,
      )
      .map((point) => point.frequencyHz),
    ...raw
      .filter(
        (point) =>
          point.timeSeconds >= startSeconds && point.timeSeconds <= startSeconds + windowSeconds,
      )
      .map((point) => point.frequencyHz),
    ...smoothed
      .filter(
        (point) =>
          point.timeSeconds >= startSeconds && point.timeSeconds <= startSeconds + windowSeconds,
      )
      .map((point) => point.frequencyHz),
  ])
  return {
    viewport: { startSeconds, endSeconds: startSeconds + windowSeconds, ...bounds },
    targets,
    source,
    raw,
    smoothed,
    gaps: gapsFrom(points, observedTime),
    playheadSeconds,
    mode,
  }
}

export function projectScene(
  project: AppProject,
  points: readonly AppPitchPoint[],
  playheadSeconds: number,
  review = false,
  mode: 'pitch' | 'cents' = 'pitch',
  zoom = 1,
): PitchChartScene {
  return buildProjectScene(project, points, playheadSeconds, review, mode, zoom, {
    durationSeconds: project.referenceDurationSeconds,
    originSeconds: 0,
  })
}

export function reviewScene(
  project: AppProject,
  take: AppTake,
  playheadSeconds: number,
  mode: 'pitch' | 'cents' = 'pitch',
  zoom = 1,
): PitchChartScene {
  return buildProjectScene(project, take.points, playheadSeconds, true, mode, zoom, {
    durationSeconds: take.durationSeconds,
    originSeconds: take.projectStartSeconds,
  })
}

export function targetAnalysisScene(
  project: Pick<
    AppProject,
    | 'notes'
    | 'targetPitchPoints'
    | 'transpositionSemitones'
    | 'alignmentSeconds'
    | 'timingOffsetSeconds'
  >,
  durationSeconds: number,
): PitchChartScene {
  const targets = project.notes.map((note) => ({
    // Setup verifies source-local analysis. Project alignment is applied later against backing audio.
    startSeconds: note.startSeconds,
    endSeconds: note.endSeconds,
    frequencyHz: midiToFrequency(note.midiNote) ?? 440,
    label: midiNoteName(note.midiNote) ?? undefined,
  }))
  const source = project.targetPitchPoints.map((point) => ({
    timeSeconds: point.timeSeconds,
    frequencyHz: point.frequencyHz,
    confidence: point.confidence ?? 0,
  }))
  const bounds = pitchBounds([
    ...targets.map((target) => target.frequencyHz),
    ...source.map((point) => point.frequencyHz),
  ])
  return {
    viewport: { startSeconds: 0, endSeconds: Math.max(0.02, durationSeconds), ...bounds },
    targets,
    source,
    raw: [],
    smoothed: [],
    gaps: targetGapsFrom(project.targetPitchPoints, (seconds) => seconds),
    playheadSeconds: null,
    mode: 'pitch',
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
  const takeEndSeconds = take.projectStartSeconds + take.durationSeconds
  const adjustedPoints = detected(take.points)
    .map((point) => ({
      ...point,
      timeSeconds: point.timeSeconds + project.timingOffsetSeconds,
    }))
    .filter(
      (point) =>
        point.timeSeconds >= take.projectStartSeconds && point.timeSeconds <= takeEndSeconds,
    )
  const observations = buildScoringObservations(adjustedPoints, target)
  const onsets = project.notes.flatMap((note) => {
    const start = note.startSeconds + project.alignmentSeconds
    if (start < take.projectStartSeconds || start > takeEndSeconds) return []
    const observed = adjustedPoints.find(
      (point) =>
        point.timeSeconds >= start - 0.2 &&
        point.timeSeconds <= start + 0.5 &&
        (point.confidence ?? 0) >= 0.75,
    )
    return [
      {
        targetNoteId: note.id,
        targetTimeSeconds: start,
        observedTimeSeconds: observed?.timeSeconds ?? null,
      },
    ]
  })
  return calculateMetricsReport(
    observations,
    onsets,
    project.loops.flatMap((loop) =>
      loop.endSeconds < take.projectStartSeconds || loop.startSeconds > takeEndSeconds
        ? []
        : [
            {
              id: loop.id,
              name: loop.name,
              startSeconds: Math.max(loop.startSeconds, take.projectStartSeconds),
              endSeconds: Math.min(loop.endSeconds, takeEndSeconds),
            },
          ],
    ),
  )
}

export function inspectedPoint(
  project: AppProject,
  take: AppTake,
  timeSeconds: number,
): ReviewPointView | null {
  const projectTimeSeconds = take.projectStartSeconds + timeSeconds
  const point = [...take.points].sort(
    (a, b) =>
      Math.abs(a.timeSeconds + project.timingOffsetSeconds - projectTimeSeconds) -
      Math.abs(b.timeSeconds + project.timingOffsetSeconds - projectTimeSeconds),
  )[0]
  const adjustedPointTime = (point?.timeSeconds ?? 0) + project.timingOffsetSeconds
  if (!point || Math.abs(adjustedPointTime - projectTimeSeconds) > 0.15) return null
  const target = project.notes.find(
    (note) =>
      projectTimeSeconds >= note.startSeconds + project.alignmentSeconds &&
      projectTimeSeconds < note.endSeconds + project.alignmentSeconds,
  )
  const targetMidi = target ? target.midiNote + project.transpositionSemitones : null
  const targetFrequencyHz = targetMidi === null ? null : midiToFrequency(targetMidi)
  const observedFrequencyHz = point.candidateHz
  const observedMidi = observedFrequencyHz === null ? null : frequencyToMidi(observedFrequencyHz)
  return {
    timeSeconds: adjustedPointTime - take.projectStartSeconds,
    frequencyHz: observedFrequencyHz,
    confidence: point.confidence ?? 0,
    targetFrequencyHz,
    centsError:
      observedMidi === null || targetMidi === null
        ? null
        : centsBetweenMidi(observedMidi, targetMidi),
    noteLabel: observedMidi === null ? null : midiNoteName(observedMidi),
  }
}

export { DETECTOR_VERSION, METRICS_FORMULA_VERSION }
