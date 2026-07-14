import { z } from 'zod'

import { isUtcDate } from './guards'
import type {
  CalibrationSettings,
  DetectedPitchPoint,
  LoopRegion,
  PitchChunk,
  PracticeProject,
  PracticeTake,
  ReferenceAudio,
  TargetNote,
  TargetPitchPoint,
  TargetSet,
} from './types'
import {
  CALIBRATION_SCHEMA_VERSION,
  LOOP_SCHEMA_VERSION,
  PITCH_CHUNK_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  REFERENCE_AUDIO_SCHEMA_VERSION,
  TAKE_SCHEMA_VERSION,
  TARGET_SET_SCHEMA_VERSION,
} from './versions'

const idSchema = z.uuid()
const utcDateSchema = z.string().refine(isUtcDate, 'Expected a UTC ISO-8601 date')
const finiteSchema = z.number()
const secondsSchema = finiteSchema.nonnegative()
const unitSchema = finiteSchema.min(0).max(1)
const pitchGapReasonSchema = z.enum([
  'silence',
  'below-confidence',
  'out-of-range',
  'invalid-frame',
  'timeline-gap',
  'queue-overflow',
])
const targetPitchGapReasonSchema = z.enum([
  'silence',
  'below-confidence',
  'out-of-range',
  'invalid-frame',
  'timeline-gap',
  'queue-overflow',
  'source-gap',
])
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i, 'Expected a SHA-256 hex digest')

export const calibrationSettingsSchema = z
  .object({
    schemaVersion: z.literal(CALIBRATION_SCHEMA_VERSION),
    inputLatencySeconds: secondsSchema,
    timingOffsetSeconds: finiteSchema,
    transposeSemitones: finiteSchema.int().min(-48).max(48),
    confidenceThreshold: unitSchema,
  })
  .strict() satisfies z.ZodType<CalibrationSettings>

export const practiceProjectSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: idSchema,
    name: z.string().trim().min(1).max(120),
    createdAt: utcDateSchema,
    updatedAt: utcDateSchema,
    backingAudioId: idSchema.nullable(),
    activeTargetSetId: idSchema.nullable(),
    calibration: calibrationSettingsSchema,
  })
  .strict()
  .superRefine((project, context) => {
    if (Date.parse(project.updatedAt) < Date.parse(project.createdAt)) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt',
      })
    }
  }) satisfies z.ZodType<PracticeProject>

export const referenceAudioSchema = z
  .object({
    schemaVersion: z.literal(REFERENCE_AUDIO_SCHEMA_VERSION),
    id: idSchema,
    projectId: idSchema,
    assetId: idSchema,
    kind: z.enum(['backing', 'isolated-vocal']),
    originalName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127),
    durationSeconds: secondsSchema,
    byteLength: finiteSchema.int().nonnegative(),
    sha256: sha256Schema,
    createdAt: utcDateSchema,
  })
  .strict() satisfies z.ZodType<ReferenceAudio>

export const targetNoteSchema = z
  .object({
    id: idSchema,
    startSeconds: secondsSchema,
    endSeconds: secondsSchema,
    midiNote: finiteSchema.int().min(0).max(127),
    lyric: z.string().max(1_000).nullable(),
    sourceTrack: finiteSchema.int().min(0).max(63).nullable(),
    scorable: z.boolean(),
  })
  .strict()
  .superRefine((note, context) => {
    if (note.endSeconds <= note.startSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['endSeconds'],
        message: 'endSeconds must be after startSeconds',
      })
    }
  }) satisfies z.ZodType<TargetNote>

export const targetPitchPointSchema = z
  .object({
    timeSeconds: secondsSchema,
    candidateHz: finiteSchema.positive().nullable().optional(),
    frequencyHz: finiteSchema.positive().nullable(),
    midiNote: finiteSchema.nullable(),
    confidence: unitSchema.nullable(),
    rms: finiteSchema.nonnegative().nullable().optional(),
    peak: finiteSchema.nonnegative().nullable().optional(),
    gapReason: targetPitchGapReasonSchema.nullable().optional(),
  })
  .strict() satisfies z.ZodType<TargetPitchPoint>

export const targetSetSchema = z
  .object({
    schemaVersion: z.literal(TARGET_SET_SCHEMA_VERSION),
    id: idSchema,
    projectId: idSchema,
    revision: finiteSchema.int().positive(),
    kind: z.enum(['midi', 'manual', 'analyzed']),
    status: z.enum(['draft', 'active', 'archived']),
    createdAt: utcDateSchema,
    sourceAssetId: idSchema.nullable(),
    parentTargetSetId: idSchema.nullable(),
    alignmentSeconds: finiteSchema,
    transposeSemitones: finiteSchema.int().min(-48).max(48),
    notes: z.array(targetNoteSchema).max(100_000).readonly(),
    pitchPoints: z.array(targetPitchPointSchema).max(500_000).readonly(),
  })
  .strict()
  .superRefine((targetSet, context) => {
    for (let index = 1; index < targetSet.pitchPoints.length; index += 1) {
      const previous = targetSet.pitchPoints[index - 1]
      const current = targetSet.pitchPoints[index]
      if (
        previous !== undefined &&
        current !== undefined &&
        current.timeSeconds < previous.timeSeconds
      ) {
        context.addIssue({
          code: 'custom',
          path: ['pitchPoints', index, 'timeSeconds'],
          message: 'Pitch points must be sorted by time',
        })
      }
    }
  }) satisfies z.ZodType<TargetSet>

export const loopRegionSchema = z
  .object({
    schemaVersion: z.literal(LOOP_SCHEMA_VERSION),
    id: idSchema,
    projectId: idSchema,
    name: z.string().trim().min(1).max(120),
    startSeconds: secondsSchema,
    endSeconds: secondsSchema,
    repeatCount: finiteSchema.int().positive().nullable(),
  })
  .strict()
  .superRefine((loop, context) => {
    if (loop.endSeconds <= loop.startSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['endSeconds'],
        message: 'endSeconds must be after startSeconds',
      })
    }
  }) satisfies z.ZodType<LoopRegion>

export const detectedPitchPointSchema = z
  .object({
    timeSeconds: secondsSchema,
    contextTimeSeconds: secondsSchema,
    candidateHz: finiteSchema.positive().nullable(),
    frequencyHz: finiteSchema.positive().nullable(),
    midiNote: finiteSchema.nullable(),
    confidence: unitSchema.nullable(),
    rms: finiteSchema.nonnegative(),
    peak: finiteSchema.nonnegative(),
    gapReason: pitchGapReasonSchema.nullable(),
    detectorVersion: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((point, context) => {
    if (point.frequencyHz !== null && point.gapReason !== null) {
      context.addIssue({
        code: 'custom',
        path: ['frequencyHz'],
        message: 'A gap cannot contain an accepted frequency',
      })
    }
    if (point.frequencyHz === null && point.gapReason === null) {
      context.addIssue({
        code: 'custom',
        path: ['gapReason'],
        message: 'An unvoiced point requires a gap reason',
      })
    }
  }) satisfies z.ZodType<DetectedPitchPoint>

export const pitchChunkSchema = z
  .object({
    schemaVersion: z.literal(PITCH_CHUNK_SCHEMA_VERSION),
    id: idSchema,
    takeId: idSchema,
    sequence: finiteSchema.int().nonnegative(),
    startSeconds: secondsSchema,
    endSeconds: secondsSchema,
    points: z.array(detectedPitchPointSchema).max(10_000).readonly(),
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.endSeconds < chunk.startSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['endSeconds'],
        message: 'endSeconds cannot precede startSeconds',
      })
    }
  }) satisfies z.ZodType<PitchChunk>

const recordingDescriptorSchema = z
  .object({
    assetId: idSchema,
    mimeType: z.string().min(1).max(127),
    byteLength: finiteSchema.int().nonnegative(),
    sha256: sha256Schema,
    durationSeconds: secondsSchema,
  })
  .strict()

export const practiceTakeSchema = z
  .object({
    schemaVersion: z.literal(TAKE_SCHEMA_VERSION),
    id: idSchema,
    projectId: idSchema,
    targetSetId: idSchema,
    loopId: idSchema.nullable(),
    createdAt: utcDateSchema,
    projectStartSeconds: secondsSchema,
    projectEndSeconds: secondsSchema,
    partial: z.boolean(),
    interruptionReason: z
      .enum([
        'app-hidden',
        'audio-context-interrupted',
        'media-track-ended',
        'route-lost',
        'device-locked',
        'unknown',
      ])
      .nullable(),
    recording: recordingDescriptorSchema,
  })
  .strict()
  .superRefine((take, context) => {
    if (take.projectEndSeconds < take.projectStartSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['projectEndSeconds'],
        message: 'projectEndSeconds cannot precede projectStartSeconds',
      })
    }
    if (!take.partial && take.interruptionReason !== null) {
      context.addIssue({
        code: 'custom',
        path: ['interruptionReason'],
        message: 'Only partial takes may have an interruption reason',
      })
    }
  }) satisfies z.ZodType<PracticeTake>
