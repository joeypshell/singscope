import { describe, expect, it } from 'vitest'

import { analyzeMonophonicPcm } from './monophonic'

function seededNoise(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return (state / 0xffff_ffff) * 2 - 1
  }
}

/**
 * Models a short piano phrase captured by a phone: bright decaying notes,
 * quiet microphone hiss, and loud aperiodic attack/room tails between notes.
 * Those tails are musical signal, even when YIN cannot assign them a pitch.
 */
function phonePianoPhrase(sampleRateHz: number, midiNotes: readonly number[]): Float32Array {
  const leadInSeconds = 0.45
  const onsetSpacingSeconds = 0.56
  const pitchedSeconds = 0.34
  const durationSeconds = leadInSeconds + midiNotes.length * onsetSpacingSeconds + 0.4
  const noise = seededNoise(0x43a6_284d)
  const output = Float32Array.from(
    { length: Math.round(durationSeconds * sampleRateHz) },
    () => noise() * 0.0015,
  )

  for (const [noteIndex, midiNote] of midiNotes.entries()) {
    const frequencyHz = 440 * 2 ** ((midiNote - 69) / 12)
    const onsetSample = Math.round((leadInSeconds + noteIndex * onsetSpacingSeconds) * sampleRateHz)
    const pitchedSamples = Math.round(pitchedSeconds * sampleRateHz)
    for (let index = 0; index < pitchedSamples; index += 1) {
      const time = index / sampleRateHz
      const attack = Math.min(1, time / 0.009)
      const decay = Math.exp(-3.2 * time)
      const phase = 2 * Math.PI * frequencyHz * time
      const piano =
        0.5 * Math.sin(phase) +
        0.22 * Math.sin(2.002 * phase + 0.13) +
        0.12 * Math.sin(3.008 * phase + 0.31) +
        0.06 * Math.sin(4.018 * phase + 0.47)
      const destination = onsetSample + index
      output[destination] = (output[destination] ?? 0) + 0.24 * attack * decay * piano
    }

    // A phone microphone hears the aperiodic hammer and room/processing tail,
    // too. It is intentionally above the static silence gate but below the note.
    const tailStart = onsetSample + pitchedSamples
    const tailSamples = Math.round((onsetSpacingSeconds - pitchedSeconds) * sampleRateHz)
    for (let index = 0; index < tailSamples; index += 1) {
      const decay = Math.exp((-0.35 * index) / tailSamples)
      const destination = tailStart + index
      output[destination] = (output[destination] ?? 0) + noise() * 0.12 * decay
    }
  }
  return output
}

describe('recorded piano melody regressions', () => {
  it('recovers all seven short notes without octave substitutions after unpitched tails', () => {
    const expectedMidi = [57, 69, 68, 64, 66, 68, 69]
    const recording = phonePianoPhrase(48_000, expectedMidi)
    const analysis = analyzeMonophonicPcm(recording, 48_000)

    expect(analysis.candidateNotes.map((note) => note.midiNote)).toEqual(expectedMidi)
    expect(analysis.candidateNotes).toHaveLength(7)
    expect(analysis.contour.some((point) => point.gapReason === 'low-confidence')).toBe(true)
  })
})
