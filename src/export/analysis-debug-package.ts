import { z } from 'zod'

import type { PitchDetectorConfig } from '../audio/dsp/contracts'
import type {
  CandidateSegmentationOptions,
  MonophonicAnalysisResult,
} from '../audio/dsp/monophonic'
import type { CaptureSettings, RecordingInterruption } from '../audio/runtime/types'
import {
  buildZipArchive,
  describeArchiveSources,
  type ArchiveSource,
  type BuiltArchive,
} from './archive'
import {
  ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION,
  analysisDebugManifestSchema,
  isAllowedAnalysisDebugPath,
  type AnalysisDebugManifest,
} from './schemas'
import { createCsv } from './safety'

export type DebugAudioExtension = 'aac' | 'm4a' | 'mp3' | 'mp4' | 'webm' | 'wav'
export type AnalysisDebugRouteCategory = 'built-in' | 'wired' | 'bluetooth' | 'speaker' | 'unknown'

export type AnalysisDebugDisplayMode =
  'browser' | 'standalone' | 'fullscreen' | 'minimal-ui' | 'unknown'

export interface AnalysisDebugAudioInput {
  /** The exact encoded bytes passed to AudioContext.decodeAudioData. */
  readonly blob: Blob
  readonly extension: DebugAudioExtension
}

export interface AnalysisDebugUserReportInput {
  readonly expectedNoteCount?: number | null
  readonly description?: string | null
}

export interface AnalysisDebugCaptureMetadataInput {
  readonly recorderDurationSeconds?: number | null
  readonly decodedDurationSeconds?: number | null
  readonly decodedSampleRateHz?: number | null
  readonly decodedChannelCount?: number | null
  readonly settings?: CaptureSettings | null
  readonly partialReason?: RecordingInterruption | null
  readonly routeCategory?: AnalysisDebugRouteCategory | null
}

export interface AnalysisDebugBrowserMetadataInput {
  readonly userAgent?: string | null
  readonly viewportWidthCssPixels?: number | null
  readonly viewportHeightCssPixels?: number | null
  readonly devicePixelRatio?: number | null
  readonly displayMode?: AnalysisDebugDisplayMode | null
  /** A URL is accepted, but only its fixed safe basename is retained. */
  readonly appAssetFileName?: string | null
}

export interface AnalysisDebugPackageInput {
  readonly audio: AnalysisDebugAudioInput
  readonly analysis: MonophonicAnalysisResult
  readonly detectorConfig: PitchDetectorConfig
  /** The fully resolved settings used to derive `analysis.candidateNotes`. */
  readonly segmentationConfig: CandidateSegmentationOptions
  readonly captureMetadata?: AnalysisDebugCaptureMetadataInput
  readonly browserMetadata?: AnalysisDebugBrowserMetadataInput
  readonly userReport?: AnalysisDebugUserReportInput
  readonly createdAt?: string
}

export interface AnalysisDebugPackageResult extends BuiltArchive {
  readonly filename: 'singscope-analysis-debug.zip'
  readonly manifest: AnalysisDebugManifest
}

const finite = z.number()
const nullablePositive = finite.positive().nullable()
const nullableNonnegative = finite.nonnegative().nullable()
const nullableUnit = finite.min(0).max(1).nullable()

export const ANALYSIS_DEBUG_LIMITS = Object.freeze({
  sourceBytes: 8 * 1024 * 1024,
  sourceDurationSeconds: 60,
  contourPoints: 5_000,
  candidateNotes: 1_000,
  textFileBytes: 16 * 1024 * 1024,
  packageBytes: 16 * 1024 * 1024,
})

export const ANALYSIS_DEBUG_SEGMENTATION_VERSION = 'candidate-segmentation-v1'

export const analysisDebugDocumentSchema = z
  .object({
    format: z.literal('singscope-analysis-debug'),
    schemaVersion: z.literal(ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION),
    createdAt: z.iso.datetime({ offset: true }),
    userReport: z.object({
      expectedNoteCount: z.number().int().min(1).max(100).nullable(),
      description: z.string().max(500).nullable(),
    }),
    source: z.object({
      path: z.enum([
        'source-audio.aac',
        'source-audio.m4a',
        'source-audio.mp3',
        'source-audio.mp4',
        'source-audio.webm',
        'source-audio.wav',
      ]),
      mediaType: z.string().min(1).max(100),
      byteLength: z.number().int().nonnegative().max(ANALYSIS_DEBUG_LIMITS.sourceBytes),
    }),
    detector: z.object({
      version: z.string().min(1).max(100),
      config: z.object({
        internalSampleRateHz: finite.positive(),
        frameDurationSeconds: finite.positive(),
        hopDurationSeconds: finite.positive(),
        minimumFrequencyHz: finite.positive(),
        maximumFrequencyHz: finite.positive(),
        yinThreshold: finite.min(0).max(1),
        confidenceThreshold: finite.min(0).max(1),
        minimumRms: finite.nonnegative(),
        noiseGateMultiplier: finite.nonnegative(),
        noiseFloorAdaptation: finite.min(0).max(1),
      }),
    }),
    segmentation: z.object({
      version: z.literal(ANALYSIS_DEBUG_SEGMENTATION_VERSION),
      config: z.object({
        confidenceThreshold: finite.min(0).max(1),
        pitchToleranceCents: finite.positive().max(200),
        maximumBridgeGapSeconds: finite.nonnegative(),
        minimumNoteDurationSeconds: finite.positive(),
        mergeSamePitchGapSeconds: finite.nonnegative(),
        analysisHopSeconds: finite.positive(),
        analysisFrameSeconds: finite.positive(),
      }),
    }),
    capture: z.object({
      recorderDurationSeconds: nullableNonnegative,
      decodedDurationSeconds: nullableNonnegative,
      decodedSampleRateHz: nullablePositive,
      decodedChannelCount: z.number().int().min(1).max(64).nullable(),
      appliedSampleRateHz: nullablePositive,
      appliedChannelCount: z.number().int().min(1).max(64).nullable(),
      echoCancellation: z.boolean().nullable(),
      noiseSuppression: z.boolean().nullable(),
      autoGainControl: z.boolean().nullable(),
      partialReason: z
        .enum([
          'app-backgrounded',
          'page-hidden',
          'page-unloaded',
          'audio-context-interrupted',
          'microphone-ended',
          'route-lost',
          'reference-stalled',
          'reference-ended',
          'size-limit',
          'duration-limit',
        ])
        .nullable(),
      routeCategory: z.enum(['built-in', 'wired', 'bluetooth', 'speaker', 'unknown']).nullable(),
    }),
    browser: z.object({
      userAgent: z.string().max(512).nullable(),
      viewportWidthCssPixels: nullablePositive,
      viewportHeightCssPixels: nullablePositive,
      devicePixelRatio: finite.positive().max(16).nullable(),
      displayMode: z
        .enum(['browser', 'standalone', 'fullscreen', 'minimal-ui', 'unknown'])
        .nullable(),
      appAssetFileName: z.string().max(100).nullable(),
    }),
    analysis: z.object({
      durationSeconds: finite.nonnegative().max(ANALYSIS_DEBUG_LIMITS.sourceDurationSeconds),
      contour: z
        .array(
          z.object({
            timeSeconds: finite.nonnegative(),
            candidateHz: nullablePositive,
            frequencyHz: nullablePositive,
            midiNote: finite.nullable(),
            confidence: nullableUnit,
            rms: nullableNonnegative,
            peak: nullableNonnegative,
            gapReason: z
              .enum(['silence', 'low-confidence', 'out-of-range', 'invalid-frame', 'source-gap'])
              .nullable(),
          }),
        )
        .max(ANALYSIS_DEBUG_LIMITS.contourPoints),
      candidateNotes: z
        .array(
          z
            .object({
              candidateKey: z.string().min(1).max(100),
              startSeconds: finite.nonnegative(),
              endSeconds: finite.nonnegative(),
              midiNote: z.number().int().min(0).max(127),
              meanConfidence: finite.min(0).max(1),
              sourcePointStartIndex: z.number().int().nonnegative(),
              sourcePointEndIndex: z.number().int().nonnegative(),
              preservedGapCount: z.number().int().nonnegative(),
            })
            .refine((note) => note.endSeconds >= note.startSeconds, {
              message: 'Candidate note end precedes its start.',
            })
            .refine((note) => note.sourcePointEndIndex >= note.sourcePointStartIndex, {
              message: 'Candidate note point range is reversed.',
            }),
        )
        .max(ANALYSIS_DEBUG_LIMITS.candidateNotes),
    }),
  })
  .strict()

export type AnalysisDebugDocument = z.infer<typeof analysisDebugDocumentSchema>

const MIME_EXTENSION = new Map<string, DebugAudioExtension>([
  ['audio/aac', 'aac'],
  ['audio/x-aac', 'aac'],
  ['audio/mp4', 'mp4'],
  ['video/mp4', 'mp4'],
  ['audio/m4a', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/webm', 'webm'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
])

const DEFAULT_MEDIA_TYPE: Readonly<Record<DebugAudioExtension, string>> = Object.freeze({
  aac: 'audio/aac',
  m4a: 'audio/m4a',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  wav: 'audio/wav',
})

function baseMediaType(mediaType: string): string {
  return (mediaType.split(';', 1)[0] ?? '').trim().toLowerCase()
}

export function debugAudioExtensionForMimeType(mediaType: string): DebugAudioExtension | null {
  return MIME_EXTENSION.get(baseMediaType(mediaType)) ?? null
}

function validatedAudioMediaType(audio: AnalysisDebugAudioInput): string {
  if (audio.blob.size > ANALYSIS_DEBUG_LIMITS.sourceBytes) {
    throw new Error('Analysis debug audio exceeds the 8 MiB recording limit.')
  }
  const normalized = baseMediaType(audio.blob.type)
  if (normalized === '') return DEFAULT_MEDIA_TYPE[audio.extension]
  const detectedExtension = debugAudioExtensionForMimeType(normalized)
  if (detectedExtension !== audio.extension) {
    throw new Error('Analysis debug audio type does not match its safe extension.')
  }
  return normalized
}

function sanitizedString(value: string | null | undefined, maximumLength: number): string | null {
  if (typeof value !== 'string') return null
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('')
  const cleaned = withoutControls.replace(/\s+/g, ' ').trim()
  return cleaned.length === 0 ? null : cleaned.slice(0, maximumLength)
}

function sanitizedNonnegative(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sanitizedPositive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function sanitizedChannelCount(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) &&
    value !== null &&
    value !== undefined &&
    value >= 1 &&
    value <= 64
    ? value
    : null
}

function sanitizedExpectedNoteCount(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) &&
    value !== null &&
    value !== undefined &&
    value >= 1 &&
    value <= 100
    ? value
    : null
}

function sanitizedAssetFileName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? ''
  const basename = withoutQuery.split(/[\\/]/).at(-1) ?? ''
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(basename) && !basename.includes('..')
    ? basename
    : null
}

export function sanitizeAnalysisDebugMetadata(input: {
  readonly capture?: AnalysisDebugCaptureMetadataInput
  readonly browser?: AnalysisDebugBrowserMetadataInput
  readonly userReport?: AnalysisDebugUserReportInput
}): Pick<AnalysisDebugDocument, 'browser' | 'capture' | 'userReport'> {
  const settings = input.capture?.settings
  return {
    userReport: {
      expectedNoteCount: sanitizedExpectedNoteCount(input.userReport?.expectedNoteCount),
      description: sanitizedString(input.userReport?.description, 500),
    },
    capture: {
      recorderDurationSeconds: sanitizedNonnegative(input.capture?.recorderDurationSeconds),
      decodedDurationSeconds: sanitizedNonnegative(input.capture?.decodedDurationSeconds),
      decodedSampleRateHz: sanitizedPositive(input.capture?.decodedSampleRateHz),
      decodedChannelCount: sanitizedChannelCount(input.capture?.decodedChannelCount),
      appliedSampleRateHz: sanitizedPositive(settings?.sampleRate),
      appliedChannelCount: sanitizedChannelCount(settings?.channelCount),
      echoCancellation: settings?.echoCancellation ?? null,
      noiseSuppression: settings?.noiseSuppression ?? null,
      autoGainControl: settings?.autoGainControl ?? null,
      partialReason: input.capture?.partialReason ?? null,
      routeCategory: input.capture?.routeCategory ?? null,
    },
    browser: {
      userAgent: sanitizedString(input.browser?.userAgent, 512),
      viewportWidthCssPixels: sanitizedPositive(input.browser?.viewportWidthCssPixels),
      viewportHeightCssPixels: sanitizedPositive(input.browser?.viewportHeightCssPixels),
      devicePixelRatio:
        typeof input.browser?.devicePixelRatio === 'number' &&
        Number.isFinite(input.browser.devicePixelRatio) &&
        input.browser.devicePixelRatio > 0 &&
        input.browser.devicePixelRatio <= 16
          ? input.browser.devicePixelRatio
          : null,
      displayMode: input.browser?.displayMode ?? null,
      appAssetFileName: sanitizedAssetFileName(input.browser?.appAssetFileName),
    },
  }
}

export function createAnalysisDebugReadme(): string {
  return [
    'SingScope local analysis debug package',
    '',
    'source-audio.* contains the exact encoded audio bytes provided or recorded for analysis.',
    'diagnostics.json contains the versioned detector configuration and any analysis evidence',
    'available after decoding: raw contour frames, accepted and rejected pitch candidates,',
    'confidence, RMS, peak, gap reasons, and estimated notes.',
    'contour.csv and estimated-notes.csv are readable copies and may contain headers only when',
    'the source audio could not be decoded.',
    'manifest.json contains SHA-256 hashes for every content file.',
    '',
    'Privacy: this package contains your audio and limited browser/capture diagnostics.',
    'It is never uploaded automatically. The explicit Send bug report action uploads it to the',
    'configured SingScope report service.',
    'If saved locally, attaching it to ChatGPT, email, or another service uploads it to that recipient.',
    'Device IDs, microphone labels, project titles, original filenames, storage IDs, and IP addresses',
    'are deliberately excluded.',
    '',
  ].join('\r\n')
}

function assertDebugTextSize(path: string, value: string): string {
  if (new TextEncoder().encode(value).byteLength > ANALYSIS_DEBUG_LIMITS.textFileBytes) {
    throw new Error(`${path} exceeds the 16 MiB debug text limit.`)
  }
  return value
}

function jsonSource(path: string, value: unknown): ArchiveSource {
  return {
    path,
    data: assertDebugTextSize(path, `${JSON.stringify(value, null, 2)}\n`),
    mediaType: 'application/json',
    compression: 'deflate',
  }
}

function contourCsv(analysis: MonophonicAnalysisResult): string {
  return createCsv(
    [
      'frame_index',
      'time_seconds',
      'candidate_hz',
      'accepted_frequency_hz',
      'midi_note',
      'confidence',
      'rms',
      'peak',
      'gap_reason',
    ],
    analysis.contour.map((point, index) => [
      index,
      point.timeSeconds,
      point.candidateHz,
      point.frequencyHz,
      point.midiNote,
      point.confidence,
      point.rms,
      point.peak,
      point.gapReason,
    ]),
  )
}

function candidateNotesCsv(analysis: MonophonicAnalysisResult): string {
  return createCsv(
    [
      'candidate_key',
      'start_seconds',
      'end_seconds',
      'midi_note',
      'mean_confidence',
      'source_point_start_index',
      'source_point_end_index',
      'preserved_gap_count',
    ],
    analysis.candidateNotes.map((note) => [
      note.candidateKey,
      note.startSeconds,
      note.endSeconds,
      note.midiNote,
      note.meanConfidence,
      note.sourcePointStartIndex,
      note.sourcePointEndIndex,
      note.preservedGapCount,
    ]),
  )
}

export async function createAnalysisDebugPackage(
  input: AnalysisDebugPackageInput,
): Promise<AnalysisDebugPackageResult> {
  const mediaType = validatedAudioMediaType(input.audio)
  const createdAt = input.createdAt ?? new Date().toISOString()
  const sourcePath = `source-audio.${input.audio.extension}` as const
  const sanitizedMetadata = sanitizeAnalysisDebugMetadata({
    ...(input.captureMetadata === undefined ? {} : { capture: input.captureMetadata }),
    ...(input.browserMetadata === undefined ? {} : { browser: input.browserMetadata }),
    ...(input.userReport === undefined ? {} : { userReport: input.userReport }),
  })
  const document = analysisDebugDocumentSchema.parse({
    format: 'singscope-analysis-debug',
    schemaVersion: ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION,
    createdAt,
    ...sanitizedMetadata,
    source: {
      path: sourcePath,
      mediaType,
      byteLength: input.audio.blob.size,
    },
    detector: {
      version: input.analysis.detectorVersion,
      config: input.detectorConfig,
    },
    segmentation: {
      version: ANALYSIS_DEBUG_SEGMENTATION_VERSION,
      config: input.segmentationConfig,
    },
    analysis: {
      durationSeconds: input.analysis.durationSeconds,
      contour: input.analysis.contour,
      candidateNotes: input.analysis.candidateNotes,
    },
  })

  const sources: ArchiveSource[] = [
    {
      path: sourcePath,
      data: input.audio.blob,
      mediaType,
      compression: 'store',
    },
    jsonSource('diagnostics.json', document),
    {
      path: 'contour.csv',
      data: assertDebugTextSize('contour.csv', contourCsv(input.analysis)),
      mediaType: 'text/csv;charset=utf-8',
      compression: 'deflate',
    },
    {
      path: 'estimated-notes.csv',
      data: assertDebugTextSize('estimated-notes.csv', candidateNotesCsv(input.analysis)),
      mediaType: 'text/csv;charset=utf-8',
      compression: 'deflate',
    },
    {
      path: 'README.txt',
      data: assertDebugTextSize('README.txt', createAnalysisDebugReadme()),
      mediaType: 'text/plain;charset=utf-8',
      compression: 'deflate',
    },
  ]

  for (const source of sources) {
    if (!isAllowedAnalysisDebugPath(source.path)) {
      throw new Error(`Unexpected analysis debug path: ${source.path}`)
    }
  }

  const contentDescription = await describeArchiveSources(sources)
  const manifest = analysisDebugManifestSchema.parse({
    format: 'singscope-analysis-debug-package',
    schemaVersion: ANALYSIS_DEBUG_PACKAGE_SCHEMA_VERSION,
    packageId: crypto.randomUUID(),
    createdAt,
    detectorVersion: input.analysis.detectorVersion,
    sourceAudioPath: sourcePath,
    contourPointCount: input.analysis.contour.length,
    candidateNoteCount: input.analysis.candidateNotes.length,
    files: contentDescription.files,
  })

  const archive = await buildZipArchive([...sources, jsonSource('manifest.json', manifest)])
  if (
    archive.blob.size > ANALYSIS_DEBUG_LIMITS.packageBytes ||
    archive.expandedBytes > ANALYSIS_DEBUG_LIMITS.packageBytes
  ) {
    throw new Error('Analysis debug package exceeds the 16 MiB package limit.')
  }
  return {
    ...archive,
    filename: 'singscope-analysis-debug.zip',
    manifest,
  }
}
