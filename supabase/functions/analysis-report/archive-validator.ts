import { Uint8ArrayReader, ZipReader, type FileEntry } from '@zip.js/zip.js'
import { z } from 'zod'

import {
  MAX_PACKAGE_BYTES,
  RequestProblem,
  sha256Hex,
  type ValidatedReportRequest,
} from './contract.ts'

const DEBUG_PACKAGE_SCHEMA_VERSION = 1 as const
const EXPECTED_ENTRY_COUNT = 6
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_DIAGNOSTICS_BYTES = 8 * 1024 * 1024
const MAX_CONTOUR_CSV_BYTES = 2 * 1024 * 1024
const MAX_NOTES_CSV_BYTES = 512 * 1024
const MAX_README_BYTES = 16 * 1024
const MAX_COMPRESSION_RATIO = 200
const COMPRESSION_RATIO_FLOOR_BYTES = 64 * 1024

const MANIFEST_PATH = 'manifest.json' as const
const DIAGNOSTICS_PATH = 'diagnostics.json' as const
const CONTOUR_PATH = 'contour.csv' as const
const NOTES_PATH = 'estimated-notes.csv' as const
const README_PATH = 'README.txt' as const

const SOURCE_PATHS = [
  'source-audio.aac',
  'source-audio.m4a',
  'source-audio.mp3',
  'source-audio.mp4',
  'source-audio.webm',
  'source-audio.wav',
] as const

type SourcePath = (typeof SOURCE_PATHS)[number]
type ContentPath =
  | typeof DIAGNOSTICS_PATH
  | typeof CONTOUR_PATH
  | typeof NOTES_PATH
  | typeof README_PATH
  | SourcePath
type ArchivePath = typeof MANIFEST_PATH | ContentPath

const SOURCE_PATH_SET = new Set<string>(SOURCE_PATHS)
const ALLOWED_PATH_SET = new Set<string>([
  MANIFEST_PATH,
  DIAGNOSTICS_PATH,
  CONTOUR_PATH,
  NOTES_PATH,
  README_PATH,
  ...SOURCE_PATHS,
])

const SOURCE_MEDIA_TYPES: Readonly<Record<SourcePath, ReadonlySet<string>>> = Object.freeze({
  'source-audio.aac': new Set(['audio/aac', 'audio/x-aac']),
  'source-audio.m4a': new Set(['audio/m4a', 'audio/x-m4a']),
  'source-audio.mp3': new Set(['audio/mpeg', 'audio/mp3']),
  'source-audio.mp4': new Set(['audio/mp4', 'video/mp4']),
  'source-audio.webm': new Set(['audio/webm']),
  'source-audio.wav': new Set(['audio/wav', 'audio/x-wav']),
})

const EXPECTED_TEXT_MEDIA_TYPES = Object.freeze({
  [DIAGNOSTICS_PATH]: 'application/json',
  [CONTOUR_PATH]: 'text/csv;charset=utf-8',
  [NOTES_PATH]: 'text/csv;charset=utf-8',
  [README_PATH]: 'text/plain;charset=utf-8',
})

const CONTOUR_HEADER = [
  'frame_index',
  'time_seconds',
  'candidate_hz',
  'accepted_frequency_hz',
  'midi_note',
  'confidence',
  'rms',
  'peak',
  'gap_reason',
] as const

const NOTES_HEADER = [
  'candidate_key',
  'start_seconds',
  'end_seconds',
  'midi_note',
  'mean_confidence',
  'source_point_start_index',
  'source_point_end_index',
  'preserved_gap_count',
] as const

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const utcSchema = z.iso.datetime({ offset: true })
const finite = z.number()
const nullablePositive = finite.positive().nullable()
const nullableNonnegative = finite.nonnegative().nullable()
const nullableUnit = finite.min(0).max(1).nullable()

const contentPathSchema = z.enum([
  DIAGNOSTICS_PATH,
  CONTOUR_PATH,
  NOTES_PATH,
  README_PATH,
  ...SOURCE_PATHS,
])

const manifestFileSchema = z
  .object({
    path: contentPathSchema,
    byteLength: z.number().int().nonnegative().max(MAX_EXPANDED_BYTES),
    sha256: hashSchema,
    mediaType: z.string().min(1).max(255),
  })
  .strict()

const debugManifestSchema = z
  .object({
    format: z.literal('singscope-analysis-debug-package'),
    schemaVersion: z.literal(DEBUG_PACKAGE_SCHEMA_VERSION),
    packageId: z.uuid(),
    createdAt: utcSchema,
    detectorVersion: z.string().min(1).max(100),
    sourceAudioPath: z.enum(SOURCE_PATHS),
    contourPointCount: z.number().int().nonnegative().max(5_000),
    candidateNoteCount: z.number().int().nonnegative().max(1_000),
    files: z.array(manifestFileSchema).length(5),
  })
  .strict()

const detectorConfigSchema = z
  .object({
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
  })
  .strict()

const segmentationConfigSchema = z
  .object({
    confidenceThreshold: finite.min(0).max(1),
    pitchToleranceCents: finite.positive().max(200),
    maximumBridgeGapSeconds: finite.nonnegative(),
    minimumNoteDurationSeconds: finite.positive(),
    mergeSamePitchGapSeconds: finite.nonnegative(),
    analysisHopSeconds: finite.positive(),
    analysisFrameSeconds: finite.positive(),
  })
  .strict()

const contourPointSchema = z
  .object({
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
  })
  .strict()

const candidateNoteSchema = z
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
  .strict()
  .refine((note) => note.endSeconds >= note.startSeconds)
  .refine((note) => note.sourcePointEndIndex >= note.sourcePointStartIndex)

const debugDocumentSchema = z
  .object({
    format: z.literal('singscope-analysis-debug'),
    schemaVersion: z.literal(DEBUG_PACKAGE_SCHEMA_VERSION),
    createdAt: utcSchema,
    userReport: z
      .object({
        expectedNoteCount: z.number().int().min(1).max(100).nullable(),
        description: z.string().max(500).nullable(),
      })
      .strict(),
    source: z
      .object({
        path: z.enum(SOURCE_PATHS),
        mediaType: z.string().min(1).max(100),
        byteLength: z.number().int().positive().max(MAX_SOURCE_BYTES),
      })
      .strict(),
    detector: z
      .object({
        version: z.string().min(1).max(100),
        config: detectorConfigSchema,
      })
      .strict(),
    segmentation: z
      .object({
        version: z.literal('candidate-segmentation-v1'),
        config: segmentationConfigSchema,
      })
      .strict(),
    capture: z
      .object({
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
      })
      .strict(),
    browser: z
      .object({
        userAgent: z.string().max(512).nullable(),
        viewportWidthCssPixels: nullablePositive,
        viewportHeightCssPixels: nullablePositive,
        devicePixelRatio: finite.positive().max(16).nullable(),
        displayMode: z
          .enum(['browser', 'standalone', 'fullscreen', 'minimal-ui', 'unknown'])
          .nullable(),
        appAssetFileName: z.string().max(100).nullable(),
      })
      .strict(),
    analysis: z
      .object({
        durationSeconds: finite.nonnegative().max(60),
        contour: z.array(contourPointSchema).max(5_000),
        candidateNotes: z.array(candidateNoteSchema).max(1_000),
      })
      .strict(),
  })
  .strict()

type DebugManifest = z.infer<typeof debugManifestSchema>
type DebugDocument = z.infer<typeof debugDocumentSchema>

function invalidPackage(): RequestProblem {
  return new RequestProblem(
    422,
    'INVALID_DEBUG_PACKAGE',
    'The ZIP does not match the SingScope analysis-debug package contract.',
  )
}

function expandedPackageTooLarge(): RequestProblem {
  return new RequestProblem(
    413,
    'DEBUG_PACKAGE_EXPANDED_TOO_LARGE',
    'The expanded report exceeds the 16 MiB limit.',
  )
}

function assertClassicZipEnvelope(bytes: Uint8Array): void {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE_BYTES) throw invalidPackage()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x0403_4b50) throw invalidPackage()

  const endOffset = bytes.byteLength - 22
  if (view.getUint32(endOffset, true) !== 0x0605_4b50) throw invalidPackage()
  const diskNumber = view.getUint16(endOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true)
  const entriesOnDisk = view.getUint16(endOffset + 8, true)
  const totalEntries = view.getUint16(endOffset + 10, true)
  const centralDirectoryBytes = view.getUint32(endOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true)
  const commentBytes = view.getUint16(endOffset + 20, true)
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== EXPECTED_ENTRY_COUNT ||
    totalEntries !== EXPECTED_ENTRY_COUNT ||
    commentBytes !== 0 ||
    centralDirectoryBytes === 0xffff_ffff ||
    centralDirectoryOffset === 0xffff_ffff ||
    centralDirectoryOffset + centralDirectoryBytes !== endOffset
  ) {
    throw invalidPackage()
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function maximumBytesForPath(path: ArchivePath): number {
  if (SOURCE_PATH_SET.has(path)) return MAX_SOURCE_BYTES
  switch (path) {
    case MANIFEST_PATH:
      return MAX_MANIFEST_BYTES
    case DIAGNOSTICS_PATH:
      return MAX_DIAGNOSTICS_BYTES
    case CONTOUR_PATH:
      return MAX_CONTOUR_CSV_BYTES
    case NOTES_PATH:
      return MAX_NOTES_CSV_BYTES
    case README_PATH:
      return MAX_README_BYTES
    default:
      throw invalidPackage()
  }
}

function isUnixSymlink(entry: FileEntry): boolean {
  return entry.unixMode !== undefined && (entry.unixMode & 0o170000) === 0o120000
}

function validateEntryMetadata(entries: readonly FileEntry[]): {
  readonly entriesByPath: ReadonlyMap<ArchivePath, FileEntry>
  readonly sourcePath: SourcePath
} {
  if (entries.length !== EXPECTED_ENTRY_COUNT) throw invalidPackage()
  const entriesByPath = new Map<ArchivePath, FileEntry>()
  let expandedBytes = 0
  let sourcePath: SourcePath | null = null

  for (const entry of entries) {
    const path = entry.filename
    if (!ALLOWED_PATH_SET.has(path) || entriesByPath.has(path as ArchivePath)) {
      throw invalidPackage()
    }
    const expectedRawName = new TextEncoder().encode(path)
    if (!bytesEqual(entry.rawFilename, expectedRawName)) throw invalidPackage()
    if (
      entry.encrypted ||
      entry.zipCrypto ||
      entry.zip64 ||
      entry.diskNumberStart !== 0 ||
      entry.executable ||
      entry.setuid === true ||
      entry.setgid === true ||
      entry.sticky === true ||
      isUnixSymlink(entry) ||
      entry.comment !== '' ||
      entry.rawComment.byteLength !== 0 ||
      !Number.isSafeInteger(entry.compressedSize) ||
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.compressedSize <= 0 ||
      entry.uncompressedSize <= 0 ||
      entry.compressedSize > MAX_PACKAGE_BYTES
    ) {
      throw invalidPackage()
    }

    const archivePath = path as ArchivePath
    if (entry.uncompressedSize > maximumBytesForPath(archivePath)) {
      throw expandedPackageTooLarge()
    }
    expandedBytes += entry.uncompressedSize
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_BYTES) {
      throw expandedPackageTooLarge()
    }

    const isSource = SOURCE_PATH_SET.has(path)
    if (isSource) {
      if (entry.compressionMethod !== 0 || entry.compressedSize !== entry.uncompressedSize) {
        throw invalidPackage()
      }
      sourcePath = archivePath as SourcePath
    } else {
      if (entry.compressionMethod !== 8) throw invalidPackage()
      const permittedExpansion = Math.max(
        COMPRESSION_RATIO_FLOOR_BYTES,
        entry.compressedSize * MAX_COMPRESSION_RATIO,
      )
      if (entry.uncompressedSize > permittedExpansion) throw expandedPackageTooLarge()
    }
    entriesByPath.set(archivePath, entry)
  }

  if (sourcePath === null || entriesByPath.size !== EXPECTED_ENTRY_COUNT) throw invalidPackage()
  for (const path of [MANIFEST_PATH, DIAGNOSTICS_PATH, CONTOUR_PATH, NOTES_PATH, README_PATH]) {
    if (!entriesByPath.has(path)) throw invalidPackage()
  }
  return { entriesByPath, sourcePath }
}

async function extractEntry(entry: FileEntry): Promise<Uint8Array> {
  const output = new Uint8Array(entry.uncompressedSize)
  let offset = 0
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      // CompressionStream output can originate in another JavaScript realm,
      // where `instanceof Uint8Array` is false even though it is a byte view.
      const bytes = ArrayBuffer.isView(chunk)
        ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : null
      if (bytes === null || offset + bytes.byteLength > output.byteLength) {
        throw expandedPackageTooLarge()
      }
      output.set(bytes, offset)
      offset += bytes.byteLength
    },
  })
  await entry.getData(sink, {
    checkAmbiguity: true,
    checkOverlappingEntry: true,
    checkSignature: true,
    preventClose: true,
    useCompressionStream: true,
    useWebWorkers: false,
  })
  if (offset !== output.byteLength) throw invalidPackage()
  return output
}

function decodeUtf8(bytes: Uint8Array): string {
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalidPackage()
  }
  if (value.includes('\0')) throw invalidPackage()
  return value
}

function parseJson<T>(bytes: Uint8Array, schema: z.ZodType<T>): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(bytes))
  } catch (error) {
    if (error instanceof RequestProblem) throw error
    throw invalidPackage()
  }
  const result = schema.safeParse(parsed)
  if (!result.success) throw invalidPackage()
  return result.data
}

function validateManifest(
  manifest: DebugManifest,
  request: ValidatedReportRequest,
  entriesByPath: ReadonlyMap<ArchivePath, FileEntry>,
  sourcePath: SourcePath,
): ReadonlyMap<ContentPath, DebugManifest['files'][number]> {
  if (
    manifest.packageId.toLowerCase() !== request.packageId ||
    manifest.sourceAudioPath !== sourcePath
  ) {
    throw invalidPackage()
  }

  const expectedContentPaths = new Set<ContentPath>([
    DIAGNOSTICS_PATH,
    CONTOUR_PATH,
    NOTES_PATH,
    README_PATH,
    sourcePath,
  ])
  const files = new Map<ContentPath, DebugManifest['files'][number]>()
  for (const file of manifest.files) {
    if (!expectedContentPaths.has(file.path) || files.has(file.path)) throw invalidPackage()
    const entry = entriesByPath.get(file.path)
    if (entry?.uncompressedSize !== file.byteLength) throw invalidPackage()
    if (SOURCE_PATH_SET.has(file.path)) {
      if (!SOURCE_MEDIA_TYPES[file.path as SourcePath].has(file.mediaType)) throw invalidPackage()
    } else if (
      EXPECTED_TEXT_MEDIA_TYPES[file.path as keyof typeof EXPECTED_TEXT_MEDIA_TYPES] !==
      file.mediaType
    ) {
      throw invalidPackage()
    }
    files.set(file.path, file)
  }
  if (files.size !== expectedContentPaths.size) throw invalidPackage()
  return files
}

function assertDebugDocumentMatches(
  document: DebugDocument,
  manifest: DebugManifest,
  sourcePath: SourcePath,
  sourceFile: DebugManifest['files'][number],
): void {
  if (
    document.createdAt !== manifest.createdAt ||
    document.detector.version !== manifest.detectorVersion ||
    document.source.path !== sourcePath ||
    document.source.mediaType !== sourceFile.mediaType ||
    document.source.byteLength !== sourceFile.byteLength ||
    document.analysis.contour.length !== manifest.contourPointCount ||
    document.analysis.candidateNotes.length !== manifest.candidateNoteCount
  ) {
    throw invalidPackage()
  }
}

function unsafeCsvCell(value: string): boolean {
  let firstNonWhitespace = 0
  while (firstNonWhitespace < value.length && value.charCodeAt(firstNonWhitespace) <= 0x20) {
    firstNonWhitespace += 1
  }
  const first = value[firstNonWhitespace]
  return (
    value.includes(String.fromCharCode(0)) ||
    first === '=' ||
    first === '+' ||
    first === '-' ||
    first === '@'
  )
}

function validateCsv(
  text: string,
  expectedHeader: readonly string[],
  expectedDataRows: number,
  sequentialFirstColumn: boolean,
): void {
  if (!text.endsWith('\r\n')) throw invalidPackage()
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let afterQuote = false
  let rowIndex = 0

  const finishCell = (): void => {
    if (unsafeCsvCell(cell)) throw invalidPackage()
    row.push(cell)
    cell = ''
    afterQuote = false
  }
  const finishRow = (): void => {
    finishCell()
    if (row.length !== expectedHeader.length) throw invalidPackage()
    if (rowIndex === 0) {
      for (let index = 0; index < expectedHeader.length; index += 1) {
        if (row[index] !== expectedHeader[index]) throw invalidPackage()
      }
    } else if (sequentialFirstColumn && row[0] !== String(rowIndex - 1)) {
      throw invalidPackage()
    }
    row = []
    rowIndex += 1
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === undefined) throw invalidPackage()
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          inQuotes = false
          afterQuote = true
        }
      } else {
        cell += character
      }
      continue
    }

    if (afterQuote && character !== ',' && character !== '\r') throw invalidPackage()
    if (character === '"') {
      if (cell !== '' || afterQuote) throw invalidPackage()
      inQuotes = true
    } else if (character === ',') {
      finishCell()
    } else if (character === '\r') {
      if (text[index + 1] !== '\n') throw invalidPackage()
      finishRow()
      index += 1
    } else if (character === '\n') {
      throw invalidPackage()
    } else {
      cell += character
    }
  }

  if (inQuotes || afterQuote || cell !== '' || row.length !== 0) throw invalidPackage()
  if (rowIndex !== expectedDataRows + 1) throw invalidPackage()
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

function hasExpectedAudioSignature(path: SourcePath, bytes: Uint8Array): boolean {
  switch (path) {
    case 'source-audio.aac':
      return ascii(bytes, 0, 'ADIF') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0)
    case 'source-audio.m4a':
    case 'source-audio.mp4':
      return bytes.byteLength >= 12 && ascii(bytes, 4, 'ftyp')
    case 'source-audio.mp3':
      return ascii(bytes, 0, 'ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    case 'source-audio.webm':
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
    case 'source-audio.wav':
      return (ascii(bytes, 0, 'RIFF') || ascii(bytes, 0, 'RF64')) && ascii(bytes, 8, 'WAVE')
  }
}

async function verifyContentFiles(
  entriesByPath: ReadonlyMap<ArchivePath, FileEntry>,
  files: ReadonlyMap<ContentPath, DebugManifest['files'][number]>,
  sourcePath: SourcePath,
): Promise<ReadonlyMap<ContentPath, Uint8Array>> {
  const extracted = new Map<ContentPath, Uint8Array>()
  for (const path of [
    DIAGNOSTICS_PATH,
    CONTOUR_PATH,
    NOTES_PATH,
    README_PATH,
    sourcePath,
  ] as const) {
    const entry = entriesByPath.get(path)
    const declared = files.get(path)
    if (entry === undefined || declared === undefined) throw invalidPackage()
    const bytes = await extractEntry(entry)
    if (bytes.byteLength !== declared.byteLength || (await sha256Hex(bytes)) !== declared.sha256) {
      throw invalidPackage()
    }
    extracted.set(path, bytes)
  }
  return extracted
}

/**
 * Validates the complete server-side report archive before any Storage write.
 * The outer request digest is checked by the caller; this function binds the
 * request identity to the inner manifest and verifies every expanded byte.
 */
export async function validateAnalysisDebugArchive(
  body: Uint8Array,
  request: ValidatedReportRequest,
): Promise<void> {
  assertClassicZipEnvelope(body)
  const reader = new ZipReader(new Uint8ArrayReader(body), {
    checkAmbiguity: true,
    useCompressionStream: true,
    useWebWorkers: false,
  })
  try {
    const rawEntries = await reader.getEntries({ checkAmbiguity: true })
    if (rawEntries.some((entry) => entry.directory)) throw invalidPackage()
    const entries = rawEntries as FileEntry[]
    const { entriesByPath, sourcePath } = validateEntryMetadata(entries)

    const manifestEntry = entriesByPath.get(MANIFEST_PATH)
    if (manifestEntry === undefined) throw invalidPackage()
    const manifest = parseJson(await extractEntry(manifestEntry), debugManifestSchema)
    const files = validateManifest(manifest, request, entriesByPath, sourcePath)
    const extracted = await verifyContentFiles(entriesByPath, files, sourcePath)

    const diagnosticsBytes = extracted.get(DIAGNOSTICS_PATH)
    const contourBytes = extracted.get(CONTOUR_PATH)
    const notesBytes = extracted.get(NOTES_PATH)
    const readmeBytes = extracted.get(README_PATH)
    const audioBytes = extracted.get(sourcePath)
    const sourceFile = files.get(sourcePath)
    if (
      diagnosticsBytes === undefined ||
      contourBytes === undefined ||
      notesBytes === undefined ||
      readmeBytes === undefined ||
      audioBytes === undefined ||
      sourceFile === undefined
    ) {
      throw invalidPackage()
    }

    const document = parseJson(diagnosticsBytes, debugDocumentSchema)
    assertDebugDocumentMatches(document, manifest, sourcePath, sourceFile)
    validateCsv(decodeUtf8(contourBytes), CONTOUR_HEADER, manifest.contourPointCount, true)
    validateCsv(decodeUtf8(notesBytes), NOTES_HEADER, manifest.candidateNoteCount, false)
    if (!decodeUtf8(readmeBytes).startsWith('SingScope local analysis debug package\r\n')) {
      throw invalidPackage()
    }
    if (!hasExpectedAudioSignature(sourcePath, audioBytes)) throw invalidPackage()
  } catch (error) {
    if (error instanceof RequestProblem) throw error
    throw invalidPackage()
  } finally {
    await reader.close().catch(() => undefined)
  }
}
