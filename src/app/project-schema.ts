import { z } from 'zod'

import {
  isMelodyReferencePitchSupported,
  melodyReferenceDurationSeconds,
  MELODY_REFERENCE_MAX_DURATION_SECONDS,
} from '../audio/dsp'

const id = z.uuid()
const finite = z.number()
const time = finite.nonnegative().max(7_200)
const utc = z.iso.datetime({ offset: true })

const note = z
  .object({
    id,
    startSeconds: time,
    endSeconds: time,
    midiNote: finite.int().min(0).max(127),
    lyric: z.string().max(120),
    scorable: z.boolean(),
  })
  .refine((value) => value.endSeconds > value.startSeconds, 'Note end must follow its start.')

const loop = z
  .object({
    id,
    name: z.string().min(1).max(120),
    startSeconds: time,
    endSeconds: time,
    repetitions: z.number().int().min(1).max(50),
    enabled: z.boolean(),
  })
  .refine((value) => value.endSeconds > value.startSeconds, 'Loop end must follow its start.')

const pitchPoint = z.object({
  timeSeconds: time,
  contextTimeSeconds: time,
  candidateHz: finite.positive().max(20_000).nullable(),
  frequencyHz: finite.positive().max(20_000).nullable(),
  midiNote: finite.min(-20).max(160).nullable(),
  confidence: finite.min(0).max(1).nullable(),
  rms: finite.min(0).max(1),
  peak: finite.min(0).max(1),
  gapReason: z.string().max(80).nullable(),
  detectorVersion: z.string().min(1).max(80),
})

const targetPitchPoint = z.object({
  timeSeconds: time,
  candidateHz: finite.positive().max(20_000).nullable().optional(),
  frequencyHz: finite.positive().max(20_000).nullable(),
  midiNote: finite.min(-20).max(160).nullable(),
  confidence: finite.min(0).max(1).nullable(),
  rms: finite.min(0).nullable().optional(),
  peak: finite.min(0).nullable().optional(),
  gapReason: z
    .enum([
      'silence',
      'below-confidence',
      'out-of-range',
      'invalid-frame',
      'timeline-gap',
      'queue-overflow',
      'source-gap',
    ])
    .nullable()
    .optional(),
})

const takeCaptureSettings = z.object({
  sampleRate: finite.positive().max(384_000).nullable(),
  channelCount: z.number().int().min(1).max(64).nullable(),
  echoCancellation: z.boolean().nullable(),
  noiseSuppression: z.boolean().nullable(),
  autoGainControl: z.boolean().nullable(),
})

const takeCaptureDiagnostics = z.object({
  captureProfile: z.enum(['raw', 'echo-reduced']),
  settings: takeCaptureSettings.nullable(),
  playbackContextSampleRate: finite.positive().max(384_000).nullable(),
  recorderChunkCount: z.number().int().nonnegative().max(10_000),
  recorderSmallestChunkBytes: z
    .number()
    .int()
    .nonnegative()
    .max(48 * 1024 * 1024)
    .nullable(),
  recorderLargestChunkBytes: z
    .number()
    .int()
    .nonnegative()
    .max(48 * 1024 * 1024)
    .nullable(),
  pcmSubmittedBatches: z.number().int().nonnegative().max(10_000_000),
  pcmProcessedBatches: z.number().int().nonnegative().max(10_000_000),
  pcmDroppedBatches: z.number().int().nonnegative().max(10_000_000),
  pcmQueueHighWater: z.number().int().nonnegative().max(1_000),
  pcmAbandonedBatches: z.number().int().nonnegative().max(10_000_000),
  pcmDrainTimedOut: z.boolean(),
})

const take = z
  .object({
    id,
    createdAt: utc,
    label: z.string().min(1).max(120),
    projectStartSeconds: time.optional(),
    durationSeconds: time.max(900),
    audioAssetId: id.nullable(),
    audioMimeType: z.string().max(255).nullable(),
    partialReason: z.string().max(120).nullable(),
    points: z.array(pitchPoint).max(500_000),
    captureDiagnostics: takeCaptureDiagnostics.nullable().optional(),
  })
  .transform((value) => {
    if (value.projectStartSeconds !== undefined)
      return value as typeof value & {
        projectStartSeconds: number
      }
    let first = Number.POSITIVE_INFINITY
    let last = Number.NEGATIVE_INFINITY
    for (const point of value.points) {
      first = Math.min(first, point.timeSeconds)
      last = Math.max(last, point.timeSeconds)
    }
    let projectStartSeconds = 0
    if (Number.isFinite(first) && Number.isFinite(last) && last > value.durationSeconds + 0.25) {
      const coverage = last - first
      projectStartSeconds =
        coverage >= value.durationSeconds * 0.5 ? (first + last - value.durationSeconds) / 2 : first
    }
    return {
      ...value,
      projectStartSeconds: Math.max(0, Math.min(7_200, Number(projectStartSeconds.toFixed(3)))),
    }
  })

export const appProjectSchema = z
  .object({
    id,
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(120),
    createdAt: utc,
    updatedAt: utc,
    referenceName: z.string().max(255).nullable(),
    referenceAssetId: id.nullable(),
    referenceMimeType: z.string().max(255).nullable(),
    referenceDurationSeconds: time.max(1_200),
    isSyntheticDemo: z.boolean(),
    targetMode: z.enum(['midi', 'manual', 'isolated-vocal']),
    targetStatus: z.string().max(300),
    targetSourceAssetId: id.nullable(),
    targetSourceName: z.string().max(255).nullable(),
    targetSourceMimeType: z.string().max(255).nullable(),
    targetRevision: z.number().int().positive(),
    transpositionSemitones: z.number().int().min(-48).max(48),
    alignmentSeconds: finite.min(-3_600).max(3_600),
    timingOffsetSeconds: finite.min(-2).max(2),
    notes: z.array(note).max(100_000),
    targetPitchPoints: z.array(targetPitchPoint).max(500_000),
    loops: z.array(loop).max(500),
    takes: z.array(take).max(1_000),
    lastBackupAt: utc.nullable(),
  })
  .superRefine((project, context) => {
    const pitchPointCount = project.takes.reduce(
      (total, currentTake) => total + currentTake.points.length,
      project.targetPitchPoints.length,
    )
    if (pitchPointCount > 500_000) {
      context.addIssue({
        code: 'too_big',
        origin: 'array',
        maximum: 500_000,
        inclusive: true,
        path: ['takes'],
        message: 'A project can contain at most 500,000 pitch points.',
      })
    }
    if (
      project.targetMode === 'manual' &&
      project.referenceAssetId === null &&
      !project.isSyntheticDemo
    ) {
      const addReferenceIssue = (path: PropertyKey[], message: string) =>
        context.addIssue({ code: 'custom', path, message })
      if (project.notes.length === 0) {
        addReferenceIssue(['notes'], 'A synthesized Manual reference requires at least one note.')
        return
      }
      const durationSeconds = melodyReferenceDurationSeconds(
        project.notes,
        project.alignmentSeconds,
      )
      if (durationSeconds <= 0) {
        addReferenceIssue(
          ['alignmentSeconds'],
          'Alignment places the entire synthesized reference before the project starts.',
        )
      } else if (durationSeconds > MELODY_REFERENCE_MAX_DURATION_SECONDS) {
        addReferenceIssue(
          ['referenceDurationSeconds'],
          'A synthesized Manual reference cannot exceed 20 minutes.',
        )
      } else if (Math.abs(project.referenceDurationSeconds - durationSeconds) > 0.001) {
        addReferenceIssue(
          ['referenceDurationSeconds'],
          'The synthesized reference duration must match its aligned notes.',
        )
      }
      if (project.referenceMimeType !== 'audio/wav') {
        addReferenceIssue(
          ['referenceMimeType'],
          'A synthesized Manual reference must use the audio/wav media type.',
        )
      }
      if (
        project.notes.some(
          (note) => !isMelodyReferencePitchSupported(note.midiNote, project.transpositionSemitones),
        )
      ) {
        addReferenceIssue(
          ['notes'],
          'A synthesized Manual reference supports pitches from 80 to 1,200 Hz.',
        )
      }
    }
  })
