import {
  buildZipArchive,
  describeArchiveSources,
  type ArchiveSource,
  type BuiltArchive,
} from './archive'
import { checkWavEligibility, IPHONE_LIMITS } from './limits'
import { createStaticReport, type StaticReportInput } from './report'
import {
  FEEDBACK_PACKAGE_SCHEMA_VERSION,
  feedbackManifestSchema,
  isAllowedFeedbackPath,
  type FeedbackManifest,
} from './schemas'
import { createCsv } from './safety'

const AUDIO_EXTENSIONS = new Set(['m4a', 'mp4', 'webm'])
const REFERENCE_AUDIO_EXTENSIONS = new Set(['m4a', 'mp4', 'webm', 'wav'])

export interface EncodedAudioExport {
  blob: Blob
  extension: 'm4a' | 'mp4' | 'webm'
}

export interface ReferenceAudioExport {
  blob: Blob
  extension: 'm4a' | 'mp4' | 'webm' | 'wav'
}

export interface CsvExport {
  headers: readonly string[]
  rows: readonly (readonly (boolean | number | string | null)[])[]
}

export interface FeedbackPackageInput {
  projectId: string
  takeId: string
  detectorVersion: string
  metricsVersion: string
  createdAt?: string
  recording: EncodedAudioExport
  wav?: { blob: Blob; estimatedPeakMemoryBytes: number }
  reference?: ReferenceAudioExport
  includeReferenceAudio?: boolean
  referenceRightsConfirmed?: boolean
  pitch: CsvExport
  notes: CsvExport
  sections: CsvExport
  summary: unknown
  settings: unknown
  chartPng: Blob
  report: StaticReportInput
  readmeNotes?: readonly string[]
}

export interface FeedbackPackageResult extends BuiltArchive {
  filename: 'singscope-feedback.zip'
  manifest: FeedbackManifest
  omissions: string[]
}

export function createFeedbackReadme(notes: readonly string[] = []): string {
  return [
    'SingScope coach feedback package',
    '',
    'All times are seconds. Unvoiced pitch is blank/null, not zero.',
    'Accuracy bands are reported separately; there is no opaque overall score.',
    'Open report.html for a script-free summary.',
    ...(notes.length > 0 ? ['', 'Notes:', ...notes.map((note) => `- ${note}`)] : []),
    '',
  ].join('\r\n')
}

function jsonSource(path: string, value: unknown): ArchiveSource {
  return {
    path,
    data: `${JSON.stringify(value, null, 2)}\n`,
    mediaType: 'application/json',
    compression: 'deflate',
  }
}

export async function createFeedbackPackage(
  input: FeedbackPackageInput,
): Promise<FeedbackPackageResult> {
  if (!AUDIO_EXTENSIONS.has(input.recording.extension)) {
    throw new Error('The encoded recording extension is not supported.')
  }
  if (input.recording.blob.size > IPHONE_LIMITS.takeBytes) {
    throw new Error('The encoded recording exceeds the 48 MiB take limit.')
  }

  const omissions: string[] = []
  const sources: ArchiveSource[] = [
    {
      path: `recording.${input.recording.extension}`,
      data: input.recording.blob,
      mediaType: input.recording.blob.type || 'application/octet-stream',
      compression: 'store',
    },
    {
      path: 'pitch-data.csv',
      data: createCsv(input.pitch.headers, input.pitch.rows),
      mediaType: 'text/csv;charset=utf-8',
      compression: 'deflate',
    },
    {
      path: 'target-notes.csv',
      data: createCsv(input.notes.headers, input.notes.rows),
      mediaType: 'text/csv;charset=utf-8',
      compression: 'deflate',
    },
    jsonSource('session.json', {
      summary: input.summary,
      settings: input.settings,
      sectionMetrics: {
        headers: input.sections.headers,
        rows: input.sections.rows,
      },
    }),
    {
      path: 'pitch-chart.png',
      data: input.chartPng,
      mediaType: 'image/png',
      compression: 'store',
    },
    {
      path: 'report.html',
      data: createStaticReport(input.report),
      mediaType: 'text/html;charset=utf-8',
      compression: 'deflate',
    },
  ]

  if (input.wav !== undefined) {
    const eligibility = checkWavEligibility(input.wav.blob.size, input.wav.estimatedPeakMemoryBytes)
    if (eligibility.eligible) {
      sources.push({
        path: 'recording.wav',
        data: input.wav.blob,
        mediaType: 'audio/wav',
        compression: 'store',
      })
    } else if (eligibility.reason !== null) omissions.push(eligibility.reason)
  }

  let includesReferenceAudio = false
  if (input.includeReferenceAudio === true && input.reference !== undefined) {
    if (!REFERENCE_AUDIO_EXTENSIONS.has(input.reference.extension)) {
      omissions.push('Reference audio was omitted because its format is not supported for sharing.')
    } else if (input.referenceRightsConfirmed !== true) {
      omissions.push('Reference audio was omitted because the rights warning was not confirmed.')
    } else {
      sources.push({
        path: `reference.${input.reference.extension}`,
        data: input.reference.blob,
        mediaType: input.reference.blob.type || 'application/octet-stream',
        compression: 'store',
      })
      includesReferenceAudio = true
    }
  }

  const notes = [...(input.readmeNotes ?? []), ...omissions]
  sources.push({
    path: 'README.txt',
    data: createFeedbackReadme(notes),
    mediaType: 'text/plain;charset=utf-8',
    compression: 'deflate',
  })

  for (const source of sources) {
    if (!isAllowedFeedbackPath(source.path))
      throw new Error(`Unexpected feedback path: ${source.path}`)
  }

  const contentDescription = await describeArchiveSources(sources)
  const manifest: FeedbackManifest = feedbackManifestSchema.parse({
    format: 'singscope-feedback-package',
    schemaVersion: FEEDBACK_PACKAGE_SCHEMA_VERSION,
    packageId: crypto.randomUUID(),
    projectId: input.projectId,
    takeId: input.takeId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    detectorVersion: input.detectorVersion,
    metricsVersion: input.metricsVersion,
    includesReferenceAudio,
    files: contentDescription.files,
    omissions,
  })

  const archive = await buildZipArchive([...sources, jsonSource('manifest.json', manifest)])
  return { ...archive, filename: 'singscope-feedback.zip', manifest, omissions }
}
