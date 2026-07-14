import { describe, expect, it } from 'vitest'

import {
  buildScoringObservations,
  lookupTargetAtTime,
  withOverlapScoringFlags,
} from './observations'
import type { DetectedPitchPoint, TargetNote, TargetSet } from './types'
import { DETECTOR_VERSION, TARGET_SET_SCHEMA_VERSION } from './versions'

const targetSet: TargetSet = {
  schemaVersion: TARGET_SET_SCHEMA_VERSION,
  id: 'target',
  projectId: 'project',
  revision: 1,
  kind: 'manual',
  status: 'active',
  createdAt: '2026-07-13T17:00:00.000Z',
  sourceAssetId: null,
  parentTargetSetId: null,
  alignmentSeconds: 0.5,
  transposeSemitones: 2,
  notes: [
    {
      id: 'note-a',
      startSeconds: 0,
      endSeconds: 1,
      midiNote: 60,
      lyric: null,
      sourceTrack: null,
      scorable: true,
    },
  ],
  pitchPoints: [],
}

const baseNote: TargetNote = {
  id: 'note-a',
  startSeconds: 0,
  endSeconds: 1,
  midiNote: 60,
  lyric: null,
  sourceTrack: null,
  scorable: true,
}

describe('target observations', () => {
  it('applies alignment and transposition', () => {
    expect(lookupTargetAtTime(targetSet, 0.75)).toEqual({
      midiNote: 62,
      targetNoteId: 'note-a',
      scorable: true,
      reason: null,
    })
    expect(lookupTargetAtTime(targetSet, 0.25).midiNote).toBeNull()
  })

  it('does not score a hidden analyzed contour outside the editable note list', () => {
    const withHiddenContour: TargetSet = {
      ...targetSet,
      kind: 'analyzed',
      pitchPoints: [
        { timeSeconds: 1.4, frequencyHz: 523.25, midiNote: 72, confidence: 0.98 },
        { timeSeconds: 1.5, frequencyHz: 523.25, midiNote: 72, confidence: 0.98 },
      ],
    }
    expect(lookupTargetAtTime(withHiddenContour, 2)).toEqual({
      midiNote: null,
      targetNoteId: null,
      scorable: false,
      reason: 'outside-target',
    })
  })

  it('flags every member of a note overlap as unscorable', () => {
    const notes = withOverlapScoringFlags([
      { ...baseNote, endSeconds: 2 },
      { ...baseNote, id: 'note-b', startSeconds: 1, endSeconds: 3 },
      { ...baseNote, id: 'note-c', startSeconds: 4, endSeconds: 5 },
    ])
    expect(notes.map((note) => note.scorable)).toEqual([false, false, true])
  })

  it('leaves a timeline gap unscored while preserving the detector candidate', () => {
    const point: DetectedPitchPoint = {
      timeSeconds: 0.75,
      contextTimeSeconds: 5,
      candidateHz: 293.66,
      frequencyHz: null,
      midiNote: null,
      confidence: 0.9,
      rms: 0.1,
      peak: 0.2,
      gapReason: 'timeline-gap',
      detectorVersion: DETECTOR_VERSION,
    }
    expect(buildScoringObservations([point], targetSet)).toEqual([
      {
        timeSeconds: 0.75,
        targetNoteId: 'note-a',
        targetMidiNote: 62,
        observedMidiNote: null,
        confidence: 0.9,
        scorable: false,
        gapReason: 'timeline-gap',
      },
    ])
    expect(point.candidateHz).toBe(293.66)
  })
})
