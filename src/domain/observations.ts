import type { DetectedPitchPoint, TargetNote, TargetSet } from './types'

export type TargetLookupReason = 'outside-target' | 'overlap' | 'unscorable' | null

export interface TargetAtTime {
  readonly midiNote: number | null
  readonly targetNoteId: string | null
  readonly scorable: boolean
  readonly reason: TargetLookupReason
}

export interface ScoringObservation {
  readonly timeSeconds: number
  readonly targetNoteId: string | null
  readonly targetMidiNote: number | null
  readonly observedMidiNote: number | null
  readonly confidence: number | null
  readonly scorable: boolean
  readonly gapReason: string | null
}

export function findOverlappingNoteIds(notes: readonly TargetNote[]): ReadonlySet<string> {
  const sorted = [...notes].sort(
    (left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds,
  )
  const overlapping = new Set<string>()
  for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
    const left = sorted[leftIndex]
    if (left === undefined) continue
    for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
      const right = sorted[rightIndex]
      if (right === undefined || right.startSeconds >= left.endSeconds) break
      if (right.endSeconds > left.startSeconds) {
        overlapping.add(left.id)
        overlapping.add(right.id)
      }
    }
  }
  return overlapping
}

export function withOverlapScoringFlags(notes: readonly TargetNote[]): readonly TargetNote[] {
  const overlapping = findOverlappingNoteIds(notes)
  return notes.map((note) => ({ ...note, scorable: note.scorable && !overlapping.has(note.id) }))
}

function pitchPointAt(targetSet: TargetSet, localTimeSeconds: number): number | null {
  const points = targetSet.pitchPoints
  if (points.length === 0) return null

  let low = 0
  let high = points.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const point = points[middle]
    if (point === undefined) return null
    if (point.timeSeconds < localTimeSeconds) low = middle + 1
    else if (point.timeSeconds > localTimeSeconds) high = middle - 1
    else return point.midiNote === null ? null : point.midiNote + targetSet.transposeSemitones
  }

  const before = points[high]
  const after = points[low]
  if (
    before === undefined ||
    after === undefined ||
    before.midiNote === null ||
    after.midiNote === null
  ) {
    return null
  }
  const width = after.timeSeconds - before.timeSeconds
  if (!(width > 0)) return null
  const mix = (localTimeSeconds - before.timeSeconds) / width
  return before.midiNote + (after.midiNote - before.midiNote) * mix + targetSet.transposeSemitones
}

export function lookupTargetAtTime(targetSet: TargetSet, projectTimeSeconds: number): TargetAtTime {
  if (!Number.isFinite(projectTimeSeconds) || projectTimeSeconds < 0) {
    return { midiNote: null, targetNoteId: null, scorable: false, reason: 'outside-target' }
  }
  const localTimeSeconds = projectTimeSeconds - targetSet.alignmentSeconds
  const matchingNotes = targetSet.notes.filter(
    (note) => localTimeSeconds >= note.startSeconds && localTimeSeconds < note.endSeconds,
  )
  if (matchingNotes.length > 1) {
    return { midiNote: null, targetNoteId: null, scorable: false, reason: 'overlap' }
  }
  const note = matchingNotes[0]
  if (note !== undefined) {
    return {
      midiNote: note.midiNote + targetSet.transposeSemitones,
      targetNoteId: note.id,
      scorable: note.scorable,
      reason: note.scorable ? null : 'unscorable',
    }
  }

  const pointMidi = pitchPointAt(targetSet, localTimeSeconds)
  if (pointMidi !== null) {
    return { midiNote: pointMidi, targetNoteId: null, scorable: true, reason: null }
  }
  return { midiNote: null, targetNoteId: null, scorable: false, reason: 'outside-target' }
}

export function buildScoringObservations(
  points: readonly DetectedPitchPoint[],
  targetSet: TargetSet,
): readonly ScoringObservation[] {
  return points.map((point) => {
    const target = lookupTargetAtTime(targetSet, point.timeSeconds)
    return {
      timeSeconds: point.timeSeconds,
      targetNoteId: target.targetNoteId,
      targetMidiNote: target.midiNote,
      observedMidiNote: point.midiNote,
      confidence: point.confidence,
      scorable: target.scorable && point.gapReason !== 'timeline-gap',
      gapReason: point.gapReason ?? target.reason,
    }
  })
}
