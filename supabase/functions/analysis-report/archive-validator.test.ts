import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { describe, expect, it } from 'vitest'

import { validateAnalysisDebugArchive } from './archive-validator.ts'
import { sha256Hex, type ValidatedReportRequest } from './contract.ts'

const PACKAGE_ID = '9bba8fce-7c65-4ed6-ae62-2f2046d6e2d8'
const CREATED_AT = '2026-07-14T15:30:00.000Z'
const SOURCE_PATH = 'source-audio.mp4'
const textEncoder = new TextEncoder()

const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00, 0x00,
])

interface TestManifestFile {
  path: string
  byteLength: number
  sha256: string
  mediaType: string
}

interface TestManifest {
  format: string
  schemaVersion: number
  packageId: string
  createdAt: string
  detectorVersion: string
  sourceAudioPath: string
  contourPointCount: number
  candidateNoteCount: number
  files: TestManifestFile[]
}

interface BuildOptions {
  readonly packageId?: string
  readonly sourceBytes?: Uint8Array
  readonly sourceCompression?: 'deflate' | 'store'
  readonly replacePath?: Readonly<{ from: string; to: string }>
  readonly contentOverrides?: Readonly<Record<string, string | Uint8Array>>
  readonly extraEntry?: Readonly<{ path: string; value: string }>
  readonly transformManifest?: (manifest: TestManifest) => TestManifest
}

function debugDocument(sourceBytes: number): string {
  return `${JSON.stringify(
    {
      format: 'singscope-analysis-debug',
      schemaVersion: 1,
      createdAt: CREATED_AT,
      userReport: {
        expectedNoteCount: 7,
        description: 'Seven notes were played, but fewer appeared.',
      },
      source: {
        path: SOURCE_PATH,
        mediaType: 'audio/mp4',
        byteLength: sourceBytes,
      },
      detector: {
        version: 'yin-24k-v1',
        config: {
          internalSampleRateHz: 24_000,
          frameDurationSeconds: 0.064,
          hopDurationSeconds: 0.02,
          minimumFrequencyHz: 80,
          maximumFrequencyHz: 1_200,
          yinThreshold: 0.15,
          confidenceThreshold: 0.75,
          minimumRms: 0.003,
          noiseGateMultiplier: 2.5,
          noiseFloorAdaptation: 0.02,
        },
      },
      segmentation: {
        version: 'candidate-segmentation-v1',
        config: {
          confidenceThreshold: 0.75,
          pitchToleranceCents: 60,
          maximumBridgeGapSeconds: 0.08,
          minimumNoteDurationSeconds: 0.08,
          mergeSamePitchGapSeconds: 0.08,
          analysisHopSeconds: 0.02,
          analysisFrameSeconds: 0.064,
        },
      },
      capture: {
        recorderDurationSeconds: 1,
        decodedDurationSeconds: 1,
        decodedSampleRateHz: 48_000,
        decodedChannelCount: 1,
        appliedSampleRateHz: 48_000,
        appliedChannelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        partialReason: null,
        routeCategory: 'built-in',
      },
      browser: {
        userAgent: 'Mobile Safari test',
        viewportWidthCssPixels: 390,
        viewportHeightCssPixels: 844,
        devicePixelRatio: 3,
        displayMode: 'standalone',
        appAssetFileName: 'index-test.js',
      },
      analysis: {
        durationSeconds: 1,
        contour: [
          {
            timeSeconds: 0.032,
            candidateHz: 440,
            frequencyHz: 440,
            midiNote: 69,
            confidence: 0.95,
            rms: 0.02,
            peak: 0.04,
            gapReason: null,
          },
        ],
        candidateNotes: [
          {
            candidateKey: 'candidate-000001',
            startSeconds: 0.02,
            endSeconds: 0.12,
            midiNote: 69,
            meanConfidence: 0.95,
            sourcePointStartIndex: 0,
            sourcePointEndIndex: 0,
            preservedGapCount: 0,
          },
        ],
      },
    },
    null,
    2,
  )}\n`
}

function mediaType(path: string): string {
  switch (path) {
    case SOURCE_PATH:
      return 'audio/mp4'
    case 'diagnostics.json':
      return 'application/json'
    case 'contour.csv':
    case 'estimated-notes.csv':
      return 'text/csv;charset=utf-8'
    case 'README.txt':
      return 'text/plain;charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? textEncoder.encode(value) : value
}

async function buildPackage(options: BuildOptions = {}): Promise<{
  readonly archive: Uint8Array
  readonly request: ValidatedReportRequest
}> {
  const sourceBytes = options.sourceBytes ?? MP4_BYTES
  const baseContent: [string, Uint8Array][] = [
    [SOURCE_PATH, sourceBytes],
    ['diagnostics.json', bytes(debugDocument(sourceBytes.byteLength))],
    [
      'contour.csv',
      bytes(
        'frame_index,time_seconds,candidate_hz,accepted_frequency_hz,midi_note,confidence,rms,peak,gap_reason\r\n' +
          '0,0.032,440,440,69,0.95,0.02,0.04,\r\n',
      ),
    ],
    [
      'estimated-notes.csv',
      bytes(
        'candidate_key,start_seconds,end_seconds,midi_note,mean_confidence,source_point_start_index,source_point_end_index,preserved_gap_count\r\n' +
          'candidate-000001,0.02,0.12,69,0.95,0,0,0\r\n',
      ),
    ],
    [
      'README.txt',
      bytes(
        'SingScope local analysis debug package\r\n\r\nPrivacy: this package contains audio.\r\n',
      ),
    ],
  ]
  const content = baseContent.map(([path, value]): [string, Uint8Array] => {
    const replacement = options.contentOverrides?.[path]
    const nextPath = options.replacePath?.from === path ? options.replacePath.to : path
    return [nextPath, replacement === undefined ? value : bytes(replacement)]
  })

  const files: TestManifestFile[] = []
  for (const [path, value] of content) {
    files.push({
      path,
      byteLength: value.byteLength,
      sha256: await sha256Hex(value),
      mediaType: mediaType(path),
    })
  }
  let manifest: TestManifest = {
    format: 'singscope-analysis-debug-package',
    schemaVersion: 1,
    packageId: options.packageId ?? PACKAGE_ID,
    createdAt: CREATED_AT,
    detectorVersion: 'yin-24k-v1',
    sourceAudioPath: SOURCE_PATH,
    contourPointCount: 1,
    candidateNoteCount: 1,
    files,
  }
  manifest = options.transformManifest?.(manifest) ?? manifest

  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
  try {
    for (const [path, value] of content) {
      const store = path === SOURCE_PATH && options.sourceCompression !== 'deflate'
      await writer.add(path, new Uint8ArrayReader(value), {
        level: store ? 0 : 6,
        useWebWorkers: false,
      })
    }
    if (options.extraEntry !== undefined) {
      await writer.add(options.extraEntry.path, new TextReader(options.extraEntry.value), {
        level: 6,
        useWebWorkers: false,
      })
    }
    await writer.add('manifest.json', new TextReader(`${JSON.stringify(manifest, null, 2)}\n`), {
      level: 6,
      useWebWorkers: false,
    })
    const blob = await writer.close()
    const archive = new Uint8Array(await blob.arrayBuffer())
    return {
      archive,
      request: {
        packageId: PACKAGE_ID,
        packageSha256: await sha256Hex(archive),
        packageBytes: archive.byteLength,
        schemaVersion: 1,
        declaredLength: archive.byteLength,
      },
    }
  } catch (error) {
    await writer.close().catch(() => undefined)
    throw error
  }
}

function changeFirstLocalFilename(archive: Uint8Array): Uint8Array {
  const copy = archive.slice()
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  expect(view.getUint32(0, true)).toBe(0x0403_4b50)
  const fileNameBytes = view.getUint16(26, true)
  expect(fileNameBytes).toBeGreaterThan(0)
  copy[30 + fileNameBytes - 1] = copy[30 + fileNameBytes - 1] === 0x34 ? 0x33 : 0x34
  return copy
}

function setCentralUncompressedSize(archive: Uint8Array, path: string, value: number): Uint8Array {
  const copy = archive.slice()
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
  for (let offset = 0; offset + 46 <= copy.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x0201_4b50) continue
    const fileNameBytes = view.getUint16(offset + 28, true)
    const filename = new TextDecoder().decode(
      copy.subarray(offset + 46, offset + 46 + fileNameBytes),
    )
    if (filename === path) {
      view.setUint32(offset + 24, value, true)
      return copy
    }
  }
  throw new Error(`Central-directory entry not found: ${path}`)
}

describe('analysis debug archive validation', () => {
  it('accepts the exact six-entry package and binds every file to the manifest', async () => {
    const built = await buildPackage()
    await expect(
      validateAnalysisDebugArchive(built.archive, built.request),
    ).resolves.toBeUndefined()
  })

  it('rejects a manifest package ID that differs from the request identity', async () => {
    const built = await buildPackage({ packageId: '6e318ce7-e3c5-4cf8-9cf4-da18801b5a62' })
    await expect(validateAnalysisDebugArchive(built.archive, built.request)).rejects.toMatchObject({
      code: 'INVALID_DEBUG_PACKAGE',
      status: 422,
    })
  })

  it('rejects extra entries and paths outside the exact allowlist', async () => {
    const extra = await buildPackage({ extraEntry: { path: 'extra.txt', value: 'extra' } })
    await expect(validateAnalysisDebugArchive(extra.archive, extra.request)).rejects.toMatchObject({
      code: 'INVALID_DEBUG_PACKAGE',
    })

    const traversal = await buildPackage({
      replacePath: { from: 'README.txt', to: '../README.txt' },
    })
    await expect(
      validateAnalysisDebugArchive(traversal.archive, traversal.request),
    ).rejects.toMatchObject({ code: 'INVALID_DEBUG_PACKAGE' })
  })

  it('rejects central/local filename ambiguity before trusting entry contents', async () => {
    const built = await buildPackage()
    const ambiguous = changeFirstLocalFilename(built.archive)
    await expect(validateAnalysisDebugArchive(ambiguous, built.request)).rejects.toMatchObject({
      code: 'INVALID_DEBUG_PACKAGE',
    })
  })

  it('rejects forged expanded sizes before decompression', async () => {
    const built = await buildPackage()
    const forged = setCentralUncompressedSize(built.archive, 'README.txt', 16 * 1024 + 1)
    await expect(validateAnalysisDebugArchive(forged, built.request)).rejects.toMatchObject({
      code: 'DEBUG_PACKAGE_EXPANDED_TOO_LARGE',
      status: 413,
    })
  })

  it('rejects per-file hash and manifest count mismatches', async () => {
    const badHash = await buildPackage({
      transformManifest: (manifest) => ({
        ...manifest,
        files: manifest.files.map((file) =>
          file.path === 'README.txt' ? { ...file, sha256: '0'.repeat(64) } : file,
        ),
      }),
    })
    await expect(
      validateAnalysisDebugArchive(badHash.archive, badHash.request),
    ).rejects.toMatchObject({ code: 'INVALID_DEBUG_PACKAGE' })

    const badCount = await buildPackage({
      transformManifest: (manifest) => ({ ...manifest, contourPointCount: 2 }),
    })
    await expect(
      validateAnalysisDebugArchive(badCount.archive, badCount.request),
    ).rejects.toMatchObject({ code: 'INVALID_DEBUG_PACKAGE' })
  })

  it('rejects unsafe CSV formulas, invalid audio signatures, and compressed source audio', async () => {
    const formula = await buildPackage({
      contentOverrides: {
        'contour.csv':
          'frame_index,time_seconds,candidate_hz,accepted_frequency_hz,midi_note,confidence,rms,peak,gap_reason\r\n' +
          '0,0.032,=2+2,440,69,0.95,0.02,0.04,\r\n',
      },
    })
    await expect(
      validateAnalysisDebugArchive(formula.archive, formula.request),
    ).rejects.toMatchObject({
      code: 'INVALID_DEBUG_PACKAGE',
    })

    const invalidAudio = await buildPackage({ sourceBytes: new Uint8Array([1, 2, 3, 4]) })
    await expect(
      validateAnalysisDebugArchive(invalidAudio.archive, invalidAudio.request),
    ).rejects.toMatchObject({ code: 'INVALID_DEBUG_PACKAGE' })

    const compressedAudio = await buildPackage({ sourceCompression: 'deflate' })
    await expect(
      validateAnalysisDebugArchive(compressedAudio.archive, compressedAudio.request),
    ).rejects.toMatchObject({ code: 'INVALID_DEBUG_PACKAGE' })
  })
})
