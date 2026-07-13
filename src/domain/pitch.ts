import { isFiniteNumber, isPositiveFinite } from './guards'

export const A4_FREQUENCY_HZ = 440
export const A4_MIDI_NOTE = 69
export const CENTS_PER_SEMITONE = 100

export function frequencyToMidi(frequencyHz: number): number | null {
  if (!isPositiveFinite(frequencyHz)) return null
  return A4_MIDI_NOTE + 12 * Math.log2(frequencyHz / A4_FREQUENCY_HZ)
}

export function midiToFrequency(midiNote: number): number | null {
  if (!isFiniteNumber(midiNote)) return null
  const frequency = A4_FREQUENCY_HZ * 2 ** ((midiNote - A4_MIDI_NOTE) / 12)
  return Number.isFinite(frequency) && frequency > 0 ? frequency : null
}

export function centsBetweenFrequencies(
  observedFrequencyHz: number,
  targetFrequencyHz: number,
): number | null {
  if (!isPositiveFinite(observedFrequencyHz) || !isPositiveFinite(targetFrequencyHz)) return null
  return 1200 * Math.log2(observedFrequencyHz / targetFrequencyHz)
}

export function centsBetweenMidi(observedMidiNote: number, targetMidiNote: number): number | null {
  if (!isFiniteNumber(observedMidiNote) || !isFiniteNumber(targetMidiNote)) return null
  return (observedMidiNote - targetMidiNote) * CENTS_PER_SEMITONE
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

export function midiNoteName(midiNote: number): string | null {
  if (!isFiniteNumber(midiNote)) return null
  const rounded = Math.round(midiNote)
  const pitchClass = ((rounded % 12) + 12) % 12
  const name = NOTE_NAMES[pitchClass]
  if (name === undefined) return null
  const octave = Math.floor(rounded / 12) - 1
  return `${name}${octave}`
}
