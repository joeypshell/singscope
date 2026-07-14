import type { EditableTargetNote } from './TargetNoteEditor'

export interface RollViewport {
  readonly durationSeconds: number
  readonly minMidi: number
  readonly maxMidi: number
}

export function calculateRollViewport(
  notes: readonly EditableTargetNote[],
  transpositionSemitones: number,
  requestedDurationSeconds: number | undefined,
): RollViewport {
  let lowestMidi = Number.POSITIVE_INFINITY
  let highestMidi = Number.NEGATIVE_INFINITY
  let durationSeconds =
    requestedDurationSeconds !== undefined && Number.isFinite(requestedDurationSeconds)
      ? requestedDurationSeconds
      : 0
  for (const note of notes) {
    const effectiveMidi = note.midiNote + transpositionSemitones
    if (Number.isFinite(effectiveMidi)) {
      lowestMidi = Math.min(lowestMidi, effectiveMidi)
      highestMidi = Math.max(highestMidi, effectiveMidi)
    }
    if (Number.isFinite(note.endSeconds))
      durationSeconds = Math.max(durationSeconds, note.endSeconds)
  }

  if (!Number.isFinite(lowestMidi) || !Number.isFinite(highestMidi)) {
    return { durationSeconds: Math.max(0.25, durationSeconds), minMidi: 60, maxMidi: 72 }
  }

  let minMidi = Math.floor(lowestMidi) - 2
  let maxMidi = Math.ceil(highestMidi) + 2
  if (maxMidi - minMidi < 12) {
    const center = (minMidi + maxMidi) / 2
    minMidi = Math.floor(center - 6)
    maxMidi = Math.ceil(center + 6)
  }
  if (minMidi < 0) {
    maxMidi -= minMidi
    minMidi = 0
  }
  if (maxMidi > 127) {
    minMidi -= maxMidi - 127
    maxMidi = 127
  }

  return {
    durationSeconds: Math.max(0.25, durationSeconds),
    minMidi: Math.max(0, minMidi),
    maxMidi: Math.min(127, maxMidi),
  }
}
