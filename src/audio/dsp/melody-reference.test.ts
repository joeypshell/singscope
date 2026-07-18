import { describe, expect, it } from 'vitest'

import {
  MELODY_REFERENCE_MAX_DURATION_SECONDS,
  MELODY_REFERENCE_SAMPLE_RATE_HZ,
  melodyReferenceDurationSeconds,
  renderMelodyReferenceWav,
  type MelodyReferenceNote,
} from './melody-reference'

function ascii(view: DataView, offset: number, length: number): string {
  return Array.from({ length }, (_, index) =>
    String.fromCharCode(view.getUint8(offset + index)),
  ).join('')
}

function pcm(buffer: ArrayBuffer): Int16Array {
  return new Int16Array(buffer, 44)
}

function crossingCount(samples: Int16Array, startSeconds: number, endSeconds: number): number {
  const start = Math.floor(startSeconds * MELODY_REFERENCE_SAMPLE_RATE_HZ)
  const end = Math.min(samples.length, Math.floor(endSeconds * MELODY_REFERENCE_SAMPLE_RATE_HZ))
  let crossings = 0
  let previous = samples[start] ?? 0
  for (let index = start + 1; index < end; index += 1) {
    const current = samples[index] ?? 0
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings += 1
    previous = current
  }
  return crossings
}

const A4: MelodyReferenceNote = { midiNote: 69, startSeconds: 0, endSeconds: 0.5 }

describe('manual melody reference WAV', () => {
  it('writes a deterministic mono PCM header with a bounded silent tail', () => {
    const buffer = renderMelodyReferenceWav({
      notes: [A4],
      transpositionSemitones: 0,
      alignmentSeconds: 0,
      timelineDurationSeconds: 1,
    })
    const view = new DataView(buffer)
    const expectedSamples = Math.ceil(1.25 * MELODY_REFERENCE_SAMPLE_RATE_HZ)

    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(MELODY_REFERENCE_SAMPLE_RATE_HZ)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(expectedSamples * 2)
    expect(buffer.byteLength).toBe(44 + expectedSamples * 2)
    expect([...pcm(buffer).slice(-100)]).toEqual(Array.from({ length: 100 }, () => 0))
  })

  it('preserves note timing and true silence gaps without mutating input order', () => {
    const notes = [
      { midiNote: 71, startSeconds: 0.4, endSeconds: 0.6 },
      { midiNote: 69, startSeconds: 0.1, endSeconds: 0.25 },
    ] as const
    const original = structuredClone(notes)
    const samples = pcm(
      renderMelodyReferenceWav({
        notes,
        transpositionSemitones: 0,
        alignmentSeconds: 0,
        timelineDurationSeconds: 0.6,
      }),
    )
    const slice = (start: number, end: number) =>
      samples.slice(
        Math.floor(start * MELODY_REFERENCE_SAMPLE_RATE_HZ),
        Math.floor(end * MELODY_REFERENCE_SAMPLE_RATE_HZ),
      )

    expect([...slice(0, 0.09)].every((sample) => sample === 0)).toBe(true)
    expect([...slice(0.12, 0.22)].some((sample) => sample !== 0)).toBe(true)
    expect([...slice(0.27, 0.38)].every((sample) => sample === 0)).toBe(true)
    expect([...slice(0.43, 0.55)].some((sample) => sample !== 0)).toBe(true)
    expect(notes).toEqual(original)
  })

  it('renders displayed pitch after transposition', () => {
    const base = pcm(
      renderMelodyReferenceWav({
        notes: [A4],
        transpositionSemitones: 0,
        alignmentSeconds: 0,
        timelineDurationSeconds: 0.5,
      }),
    )
    const octaveUp = pcm(
      renderMelodyReferenceWav({
        notes: [A4],
        transpositionSemitones: 12,
        alignmentSeconds: 0,
        timelineDurationSeconds: 0.5,
      }),
    )

    const baseCrossings = crossingCount(base, 0.05, 0.4)
    const octaveCrossings = crossingCount(octaveUp, 0.05, 0.4)
    expect(baseCrossings).toBeGreaterThan(250)
    expect(octaveCrossings / baseCrossings).toBeCloseTo(2, 1)
  })

  it('derives the aligned project duration and keeps it positive', () => {
    expect(melodyReferenceDurationSeconds([A4], 0.75)).toBe(1.25)
    expect(melodyReferenceDurationSeconds([{ ...A4, startSeconds: 0, endSeconds: 0.2 }], -1)).toBe(
      0,
    )
  })

  it('rejects unsafe durations, invalid notes, and pitches outside MIDI range', () => {
    expect(() =>
      renderMelodyReferenceWav({
        notes: [A4],
        transpositionSemitones: 0,
        alignmentSeconds: 0,
        timelineDurationSeconds: MELODY_REFERENCE_MAX_DURATION_SECONDS + 0.001,
      }),
    ).toThrow(/20 minutes/)
    expect(() => melodyReferenceDurationSeconds([{ ...A4, endSeconds: 0 }], 0)).toThrow(/invalid/)
    expect(() =>
      renderMelodyReferenceWav({
        notes: [{ midiNote: 120, startSeconds: 0, endSeconds: 1 }],
        transpositionSemitones: 12,
        alignmentSeconds: 0,
        timelineDurationSeconds: 1,
      }),
    ).toThrow(/outside MIDI/)
    expect(() =>
      renderMelodyReferenceWav({
        notes: [{ midiNote: 100, startSeconds: 0, endSeconds: 1 }],
        transpositionSemitones: 0,
        alignmentSeconds: 0,
        timelineDurationSeconds: 1,
      }),
    ).toThrow(/80–1,200 Hz/)
  })

  it('keeps the maximum WAV and conservative decode peak inside iPhone limits', () => {
    const sampleCount = Math.ceil(
      MELODY_REFERENCE_MAX_DURATION_SECONDS * MELODY_REFERENCE_SAMPLE_RATE_HZ,
    )
    const wavBytes = 44 + sampleCount * 2
    const conservativePeakBytes = wavBytes * 2 + sampleCount * 4

    expect(wavBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(conservativePeakBytes).toBeLessThan(96 * 1024 * 1024)
  })
})
