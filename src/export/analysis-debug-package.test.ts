import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import { describe, expect, it } from 'vitest'

import { DEFAULT_YIN_CONFIG } from '../audio/dsp/yin'
import {
  DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS,
  type MonophonicAnalysisResult,
} from '../audio/dsp/monophonic'
import { sha256Bytes } from '../persistence/hash'
import {
  ANALYSIS_DEBUG_LIMITS,
  createAnalysisDebugPackage,
  debugAudioExtensionForMimeType,
} from './analysis-debug-package'
import { analysisDebugManifestSchema } from './schemas'
import { validateAnalysisDebugArchive } from '../../supabase/functions/analysis-report/archive-validator'

const analysis: MonophonicAnalysisResult = {
  detectorVersion: 'yin-24k-debug-test',
  durationSeconds: 1,
  contour: [
    {
      timeSeconds: 0.032,
      candidateHz: null,
      frequencyHz: null,
      midiNote: null,
      confidence: null,
      rms: 0.001,
      peak: 0.002,
      gapReason: 'silence',
    },
    {
      timeSeconds: 0.052,
      candidateHz: 439.2,
      frequencyHz: null,
      midiNote: null,
      confidence: 0.62,
      rms: 0.02,
      peak: 0.04,
      gapReason: 'low-confidence',
    },
    {
      timeSeconds: 0.072,
      candidateHz: 440.1,
      frequencyHz: 440.1,
      midiNote: 69.003_934,
      confidence: 0.94,
      rms: 0.03,
      peak: 0.08,
      gapReason: null,
    },
  ],
  candidateNotes: [
    {
      candidateKey: '=unsafe-candidate-key',
      startSeconds: 0.02,
      endSeconds: 0.1,
      midiNote: 69,
      meanConfidence: 0.94,
      sourcePointStartIndex: 1,
      sourcePointEndIndex: 2,
      preservedGapCount: 1,
    },
  ],
}

const segmentationConfig = Object.freeze({
  ...DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS,
  confidenceThreshold: 0.68,
  maximumBridgeGapSeconds: 0.09,
})

async function extractArchive(blob: Blob): Promise<{
  readonly entries: ReadonlyMap<string, Uint8Array>
  readonly compression: ReadonlyMap<string, number>
}> {
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false })
  try {
    const entries = (await reader.getEntries()).filter((entry) => !entry.directory)
    const extracted = new Map<string, Uint8Array>()
    const compression = new Map<string, number>()
    for (const entry of entries) {
      extracted.set(
        entry.filename,
        await entry.getData(new Uint8ArrayWriter(), { useWebWorkers: false }),
      )
      compression.set(entry.filename, entry.compressionMethod)
    }
    return { entries: extracted, compression }
  } finally {
    await reader.close()
  }
}

describe('local analysis debug package', () => {
  it('contains exact STORE audio, full detector evidence, fixed paths, and verifiable hashes', async () => {
    const audioBytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x00,
      0x00,
    ])
    const result = await createAnalysisDebugPackage({
      audio: {
        blob: new Blob([audioBytes], { type: 'audio/mp4;codecs=mp4a.40.2' }),
        extension: 'mp4',
      },
      analysis,
      detectorConfig: DEFAULT_YIN_CONFIG,
      segmentationConfig,
      createdAt: '2026-07-14T15:30:00.000Z',
      userReport: {
        expectedNoteCount: 7,
        description: 'I played seven notes, but only four appeared.',
      },
      captureMetadata: {
        recorderDurationSeconds: 1.1,
        decodedDurationSeconds: 1,
        decodedSampleRateHz: 48_000,
        decodedChannelCount: 1,
        settings: {
          deviceId: 'must-never-be-exported',
          label: 'Private microphone name',
          sampleRate: 48_000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false,
        },
        partialReason: null,
        routeCategory: 'built-in',
      },
      browserMetadata: {
        userAgent: 'Mobile Safari test',
        viewportWidthCssPixels: 390,
        viewportHeightCssPixels: 844,
        devicePixelRatio: 3,
        displayMode: 'standalone',
        appAssetFileName: '/singscope/assets/index-safe123.js?ignored=yes',
      },
    })

    expect(result.filename).toBe('singscope-analysis-debug.zip')
    expect(result.blob.size).toBeLessThanOrEqual(ANALYSIS_DEBUG_LIMITS.packageBytes)
    const archive = await extractArchive(result.blob)
    expect([...archive.entries.keys()].sort()).toEqual([
      'README.txt',
      'contour.csv',
      'diagnostics.json',
      'estimated-notes.csv',
      'manifest.json',
      'source-audio.mp4',
    ])
    expect(archive.compression.get('source-audio.mp4')).toBe(0)
    expect(archive.entries.get('source-audio.mp4')).toEqual(audioBytes)

    const diagnosticsText = new TextDecoder().decode(archive.entries.get('diagnostics.json'))
    const diagnostics = JSON.parse(diagnosticsText)
    expect(diagnostics.detector).toEqual({
      version: analysis.detectorVersion,
      config: DEFAULT_YIN_CONFIG,
    })
    expect(diagnostics.segmentation).toEqual({
      version: 'candidate-segmentation-v1',
      config: segmentationConfig,
    })
    expect(diagnostics.analysis).toEqual({
      durationSeconds: analysis.durationSeconds,
      contour: analysis.contour,
      candidateNotes: analysis.candidateNotes,
    })
    expect(diagnostics.userReport.expectedNoteCount).toBe(7)
    expect(diagnostics.capture).toMatchObject({
      decodedSampleRateHz: 48_000,
      decodedChannelCount: 1,
      appliedSampleRateHz: 48_000,
      appliedChannelCount: 1,
      noiseSuppression: true,
    })
    expect(diagnostics.browser.appAssetFileName).toBe('index-safe123.js')
    expect(diagnosticsText).not.toContain('must-never-be-exported')
    expect(diagnosticsText).not.toContain('Private microphone name')

    const contourCsv = new TextDecoder().decode(archive.entries.get('contour.csv'))
    expect(contourCsv).toContain('candidate_hz,accepted_frequency_hz')
    expect(contourCsv).toContain('439.2,,')
    expect(contourCsv).toContain('low-confidence')
    const notesCsv = new TextDecoder().decode(archive.entries.get('estimated-notes.csv'))
    expect(notesCsv).toContain("'=unsafe-candidate-key")

    const manifestBytes = archive.entries.get('manifest.json')
    expect(manifestBytes).toBeDefined()
    const manifest = analysisDebugManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    )
    expect(manifest.sourceAudioPath).toBe('source-audio.mp4')
    expect(manifest.contourPointCount).toBe(3)
    expect(manifest.candidateNoteCount).toBe(1)
    for (const file of manifest.files) {
      const bytes = archive.entries.get(file.path)
      expect(bytes, file.path).toBeDefined()
      expect(bytes?.byteLength).toBe(file.byteLength)
      expect(bytes === undefined ? null : sha256Bytes(bytes)).toBe(file.sha256)
    }

    const readme = new TextDecoder().decode(archive.entries.get('README.txt'))
    expect(readme).toMatch(/never uploaded automatically/i)
    expect(readme).toMatch(/Attaching it to ChatGPT.*uploads it/i)

    const packageBytes = new Uint8Array(await result.blob.arrayBuffer())
    await expect(
      validateAnalysisDebugArchive(packageBytes, {
        packageId: result.manifest.packageId,
        packageSha256: sha256Bytes(packageBytes),
        packageBytes: packageBytes.byteLength,
        schemaVersion: 1,
        declaredLength: packageBytes.byteLength,
      }),
    ).resolves.toBeUndefined()
  })

  it('supports fixed safe extensions for recorded and uploaded audio MIME types', () => {
    expect(debugAudioExtensionForMimeType('audio/mp4; codecs=mp4a.40.2')).toBe('mp4')
    expect(debugAudioExtensionForMimeType('video/mp4')).toBe('mp4')
    expect(debugAudioExtensionForMimeType('audio/webm;codecs=opus')).toBe('webm')
    expect(debugAudioExtensionForMimeType('audio/mpeg')).toBe('mp3')
    expect(debugAudioExtensionForMimeType('audio/aac')).toBe('aac')
    expect(debugAudioExtensionForMimeType('text/html')).toBeNull()
  })

  it('rejects analysis outside the 60-second diagnostic bounds', async () => {
    await expect(
      createAnalysisDebugPackage({
        audio: { blob: new Blob(['audio'], { type: 'audio/mp4' }), extension: 'mp4' },
        analysis: { ...analysis, durationSeconds: 61 },
        detectorConfig: DEFAULT_YIN_CONFIG,
        segmentationConfig,
      }),
    ).rejects.toThrow()
  })

  it('rejects an extension that disagrees with the actual audio MIME type', async () => {
    await expect(
      createAnalysisDebugPackage({
        audio: { blob: new Blob(['audio'], { type: 'audio/mpeg' }), extension: 'mp4' },
        analysis,
        detectorConfig: DEFAULT_YIN_CONFIG,
        segmentationConfig,
      }),
    ).rejects.toThrow(/does not match/)
  })

  it('rejects empty audio before preparing an upload the report service cannot accept', async () => {
    await expect(
      createAnalysisDebugPackage({
        audio: { blob: new Blob([], { type: 'audio/webm' }), extension: 'webm' },
        analysis,
        detectorConfig: DEFAULT_YIN_CONFIG,
        segmentationConfig,
      }),
    ).rejects.toThrow(/audio is empty/)
  })
})
