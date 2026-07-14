import { describe, expect, it } from 'vitest'

import type { TargetSet } from '../../domain/types'
import {
  MonophonicAnalysisCancelledError,
  analyzeForegroundMonophonicMediaPass,
  analyzeMonophonicAudioBuffer,
  analyzeMonophonicPcm,
  createAnalyzedTargetDraftInput,
  decideMonophonicAnalysisStrategy,
  estimateDecodedPcmBytes,
  mixAudioBufferToMono,
  segmentMonophonicContour,
  type AudioBufferLike,
  type ForegroundMonophonicMediaPass,
  type MonophonicAnalysisResult,
  type MonophonicContourPoint,
  type NormalizedMonophonicPcmChunk,
} from './monophonic'

function sine(sampleRateHz: number, frequencyHz: number, durationSeconds: number): Float32Array {
  return Float32Array.from(
    { length: Math.round(sampleRateHz * durationSeconds) },
    (_, index) => 0.4 * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz),
  )
}

function decayingPianoPhrase(sampleRateHz: number, midiNotes: readonly number[]): Float32Array {
  const leadSeconds = 2.1
  const noteSeconds = 0.42
  const onsetIntervalSeconds = 0.24
  const tailSeconds = 0.5
  const totalSeconds =
    leadSeconds +
    Math.max(0, midiNotes.length - 1) * onsetIntervalSeconds +
    noteSeconds +
    tailSeconds
  let noiseState = 0x6d2b_79f5
  const noise = (): number => {
    noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0
    return (noiseState / 0xffff_ffff) * 2 - 1
  }
  const output = Float32Array.from(
    { length: Math.round(totalSeconds * sampleRateHz) },
    () => noise() * 0.0006,
  )

  for (let noteIndex = 0; noteIndex < midiNotes.length; noteIndex += 1) {
    const midiNote = midiNotes[noteIndex] ?? 57
    const frequencyHz = 440 * 2 ** ((midiNote - 69) / 12)
    const startSample = Math.round((leadSeconds + noteIndex * onsetIntervalSeconds) * sampleRateHz)
    const noteSamples = Math.round(noteSeconds * sampleRateHz)
    for (let offset = 0; offset < noteSamples; offset += 1) {
      const time = offset / sampleRateHz
      const attack = Math.min(1, time / 0.012)
      const decay = Math.exp((-5.4 * time) / noteSeconds)
      const envelope = attack * decay
      const phase = 2 * Math.PI * frequencyHz * time
      // A bright, struck-string spectrum plus a short aperiodic hammer transient.
      const pitched =
        0.22 * Math.sin(phase) +
        0.3 * Math.sin(2 * phase + 0.13) +
        0.12 * Math.sin(3 * phase + 0.3) +
        0.05 * Math.sin(4 * phase + 0.5)
      const hammer = time < 0.025 ? noise() * 0.08 * (1 - time / 0.025) : 0
      const index = startSample + offset
      output[index] = (output[index] ?? 0) + pitched * envelope + hammer
    }
  }
  return output
}

function contourPoint(
  timeSeconds: number,
  midiNote: number | null,
  confidence: number | null = 0.95,
): MonophonicContourPoint {
  const frequencyHz = midiNote === null ? null : 440 * 2 ** ((midiNote - 69) / 12)
  return {
    timeSeconds,
    candidateHz: frequencyHz,
    frequencyHz,
    midiNote,
    confidence,
    rms: midiNote === null ? 0.001 : 0.2,
    peak: midiNote === null ? 0.002 : 0.4,
    gapReason: midiNote === null ? 'silence' : null,
  }
}

function bufferFromChannels(
  sampleRate: number,
  channels: readonly Float32Array[],
): AudioBufferLike {
  const first = channels[0]
  if (first === undefined) throw new Error('A test buffer needs a channel')
  return {
    numberOfChannels: channels.length,
    length: first.length,
    sampleRate,
    duration: first.length / sampleRate,
    getChannelData(channel: number) {
      const samples = channels[channel]
      if (samples === undefined) throw new RangeError('channel')
      return samples
    },
  }
}

describe('monophonic analysis admission', () => {
  it('uses whole-file analysis only beneath the encoded, duration, and peak-memory budgets', () => {
    const short = {
      encodedByteLength: 5 * 1024 * 1024,
      durationSeconds: 60,
      sampleRateHz: 48_000,
      channelCount: 2,
    }
    const long = { ...short, durationSeconds: 8 * 60 }
    expect(decideMonophonicAnalysisStrategy(short).strategy).toBe('offline-buffer')
    expect(decideMonophonicAnalysisStrategy(long).strategy).toBe('foreground-media-pass')
    expect(
      decideMonophonicAnalysisStrategy({ ...short, encodedByteLength: 33 * 1024 * 1024 }),
    ).toMatchObject({ strategy: 'reject', rejection: 'encoded-file-too-large' })
    expect(
      decideMonophonicAnalysisStrategy({ ...short, durationSeconds: 8 * 60 + 0.01 }),
    ).toMatchObject({ strategy: 'reject', rejection: 'duration-too-long' })
    expect(decideMonophonicAnalysisStrategy({ ...short, channelCount: 9 })).toMatchObject({
      strategy: 'reject',
      rejection: 'too-many-channels',
    })
  })

  it('rejects invalid estimates instead of overflowing or fabricating a byte count', () => {
    expect(estimateDecodedPcmBytes(Number.NaN, 48_000, 2)).toBeNull()
    expect(
      decideMonophonicAnalysisStrategy({
        encodedByteLength: -1,
        durationSeconds: 1,
        sampleRateHz: 48_000,
        channelCount: 1,
      }),
    ).toMatchObject({ strategy: 'reject', rejection: 'invalid-metadata' })
  })
})

describe('offline monophonic analysis', () => {
  it('mixes channels deterministically without normalization or clipping tricks', () => {
    const left = Float32Array.of(1, 0.5, -0.5)
    const right = Float32Array.of(-1, 0.5, 0.5)
    expect([...mixAudioBufferToMono(bufferFromChannels(48_000, [left, right]))]).toEqual([
      0, 0.5, 0,
    ])
  })

  it('returns raw contour frames and editable candidate notes from Float32 PCM', () => {
    const result = analyzeMonophonicPcm(sine(48_000, 220, 0.3), 48_000)
    expect(result.contour.length).toBeGreaterThan(5)
    expect(result.contour.every((point) => point.confidence !== null)).toBe(true)
    expect(result.candidateNotes).toHaveLength(1)
    expect(result.candidateNotes[0]).toMatchObject({
      candidateKey: 'candidate-000001',
      midiNote: 57,
    })
  })

  it('retains every event in a short seven-note piano phrase after a two-second lead-in', () => {
    const expectedMidi = [57, 69, 68, 64, 66, 64, 61]
    const result = analyzeMonophonicPcm(decayingPianoPhrase(48_000, expectedMidi), 48_000)

    expect(result.candidateNotes.map((note) => note.midiNote)).toEqual(expectedMidi)
  })

  it('honors AbortSignal between bounded offline frame batches', async () => {
    const controller = new AbortController()
    const buffer = bufferFromChannels(24_000, [sine(24_000, 220, 0.3)])
    let yields = 0
    await expect(
      analyzeMonophonicAudioBuffer(buffer, {
        admission: decideMonophonicAnalysisStrategy({
          encodedByteLength: 1_000,
          durationSeconds: buffer.duration,
          sampleRateHz: buffer.sampleRate,
          channelCount: buffer.numberOfChannels,
        }),
        signal: controller.signal,
        framesPerYield: 1,
        yieldControl: () => {
          yields += 1
          controller.abort()
          return Promise.resolve()
        },
      }),
    ).rejects.toBeInstanceOf(MonophonicAnalysisCancelledError)
    expect(yields).toBe(1)
  })

  it('refuses an AudioBuffer when pre-decode admission selected the streaming path', async () => {
    const buffer = bufferFromChannels(24_000, [sine(24_000, 220, 0.1)])
    const admission = decideMonophonicAnalysisStrategy({
      encodedByteLength: 10 * 1024 * 1024,
      durationSeconds: 8 * 60,
      sampleRateHz: 48_000,
      channelCount: 2,
    })
    expect(admission.strategy).toBe('foreground-media-pass')
    await expect(analyzeMonophonicAudioBuffer(buffer, { admission })).rejects.toThrow(
      /not admitted/,
    )
  })
})

describe('candidate segmentation and draft isolation', () => {
  it('uses the detector frame support so short stable notes are not visually shortened away', () => {
    const notes = segmentMonophonicContour([contourPoint(0.032, 60), contourPoint(0.052, 60)])
    expect(notes).toHaveLength(1)
    expect(notes[0]?.startSeconds).toBe(0)
    expect(notes[0]?.endSeconds).toBeCloseTo(0.084)
  })

  it('bridges a short gap while preserving it in the contour and splits a real note change', () => {
    const contour = [
      contourPoint(0.03, 60),
      contourPoint(0.05, 60.1),
      contourPoint(0.07, null),
      contourPoint(0.09, 59.9),
      contourPoint(0.11, 60),
      contourPoint(0.13, 64),
      contourPoint(0.15, 64.1),
      contourPoint(0.17, 64),
      contourPoint(0.19, 64),
    ]
    const notes = segmentMonophonicContour(contour, { minimumNoteDurationSeconds: 0.06 })
    expect(notes).toHaveLength(2)
    expect(notes.map((note) => note.midiNote)).toEqual([60, 64])
    expect(notes[0]?.preservedGapCount).toBe(1)
    expect(contour[2]?.gapReason).toBe('silence')
  })

  it('returns a new analyzed draft and never reuses or mutates manual notes', () => {
    const manualNotes = Object.freeze([
      Object.freeze({
        id: 'manual-note',
        startSeconds: 0,
        endSeconds: 1,
        midiNote: 60,
        lyric: 'keep me',
        sourceTrack: null,
        scorable: true,
      }),
    ])
    const previous: Pick<TargetSet, 'id' | 'revision' | 'alignmentSeconds' | 'transposeSemitones'> =
      Object.freeze({
        id: 'manual-revision',
        revision: 4,
        alignmentSeconds: -0.12,
        transposeSemitones: 2,
      })
    const analysis: MonophonicAnalysisResult = {
      detectorVersion: 'yin-test',
      durationSeconds: 1,
      contour: [
        contourPoint(0.1, 62),
        {
          ...contourPoint(0.12, 62, 0.55),
          frequencyHz: null,
          midiNote: null,
          gapReason: 'low-confidence',
        },
      ],
      candidateNotes: [
        {
          candidateKey: 'candidate-000001',
          startSeconds: 0,
          endSeconds: 1,
          midiNote: 62,
          meanConfidence: 0.9,
          sourcePointStartIndex: 0,
          sourcePointEndIndex: 0,
          preservedGapCount: 0,
        },
      ],
    }
    const draft = createAnalyzedTargetDraftInput(analysis, {
      sourceAssetId: 'isolated-source',
      previousRevision: previous,
    })
    expect(draft).toMatchObject({
      revision: 5,
      kind: 'analyzed',
      status: 'draft',
      parentTargetSetId: 'manual-revision',
      alignmentSeconds: -0.12,
      transposeSemitones: 2,
    })
    expect(draft.notes[0]?.midiNote).toBe(62)
    expect(draft.pitchPoints[1]).toMatchObject({
      candidateHz: analysis.contour[1]?.candidateHz,
      frequencyHz: null,
      midiNote: null,
      confidence: 0.55,
      rms: 0.2,
      peak: 0.4,
      gapReason: 'below-confidence',
    })
    expect(manualNotes[0]?.lyric).toBe('keep me')
  })
})

describe('foreground normalized media pass', () => {
  it('analyzes bounded chunks and preserves explicit source gaps', async () => {
    const controller = new AbortController()
    const first = sine(24_000, 220, 0.1)
    const second = sine(24_000, 220, 0.1)
    const chunks: readonly NormalizedMonophonicPcmChunk[] = [
      { sequence: 0, startSample: 0, sampleCount: first.length, samples: first, gapReason: null },
      {
        sequence: 1,
        startSample: first.length,
        sampleCount: 960,
        samples: null,
        gapReason: 'source-gap',
      },
      {
        sequence: 2,
        startSample: first.length + 960,
        sampleCount: second.length,
        samples: second,
        gapReason: null,
      },
    ]
    const pass: ForegroundMonophonicMediaPass = {
      normalizedSampleRateHz: 24_000,
      durationSeconds: 0.24,
      async *chunks() {
        await Promise.resolve()
        for (const chunk of chunks) yield chunk
      },
      cancel() {
        return undefined
      },
    }
    const result = await analyzeForegroundMonophonicMediaPass(pass, {
      signal: controller.signal,
    })
    expect(result.contour.some((point) => point.gapReason === 'source-gap')).toBe(true)
    expect(result.contour.some((point) => point.frequencyHz !== null)).toBe(true)
  })

  it('cancels the media adapter and rejects with a typed cancellation', async () => {
    const controller = new AbortController()
    let cancelledWith: string | null = null
    const samples = sine(24_000, 220, 0.1)
    const pass: ForegroundMonophonicMediaPass = {
      normalizedSampleRateHz: 24_000,
      durationSeconds: 0.2,
      async *chunks() {
        await Promise.resolve()
        yield { sequence: 0, startSample: 0, sampleCount: samples.length, samples, gapReason: null }
        controller.abort()
        yield {
          sequence: 1,
          startSample: samples.length,
          sampleCount: samples.length,
          samples,
          gapReason: null,
        }
      },
      cancel(reason) {
        cancelledWith = reason
      },
    }
    await expect(
      analyzeForegroundMonophonicMediaPass(pass, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(MonophonicAnalysisCancelledError)
    expect(cancelledWith).toBe('user-cancelled')
  })
})
