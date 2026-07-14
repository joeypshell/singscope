import { midiToFrequency } from '../domain/pitch'
import { DETECTOR_VERSION } from '../domain/versions'
import type { AppPitchPoint, AppProject, AppTargetNote, AppTake } from './types'

const DEMO_MELODY: readonly (readonly [number, number, number, string])[] = [
  [0, 1.5, 60, 'see'],
  [1.75, 3.25, 62, 'the'],
  [3.5, 5, 64, 'line'],
  [5.25, 7.5, 67, 'rise'],
]

export function createDemoNotes(): readonly AppTargetNote[] {
  return DEMO_MELODY.map(([startSeconds, endSeconds, midiNote, lyric]) => ({
    id: crypto.randomUUID(),
    startSeconds,
    endSeconds,
    midiNote,
    lyric,
    scorable: true,
  }))
}

export function createMockPitchTrace(notes: readonly AppTargetNote[]): readonly AppPitchPoint[] {
  const points: AppPitchPoint[] = []
  const contextOrigin = 10
  for (let timeSeconds = 0; timeSeconds <= 7.5; timeSeconds += 0.02) {
    const note = notes.find(
      (candidate) => timeSeconds >= candidate.startSeconds && timeSeconds < candidate.endSeconds,
    )
    const inBreath = note === undefined || timeSeconds - note.startSeconds < 0.08
    const confidence = inBreath ? 0.34 : 0.9 + Math.sin(timeSeconds * 1.7) * 0.04
    const midi = note ? note.midiNote + Math.sin(timeSeconds * 5.2) * 0.12 - 0.08 : null
    const frequencyHz = midi === null ? null : midiToFrequency(midi)
    points.push({
      timeSeconds: Number(timeSeconds.toFixed(3)),
      contextTimeSeconds: contextOrigin + timeSeconds,
      candidateHz: frequencyHz,
      frequencyHz: inBreath ? null : frequencyHz,
      midiNote: inBreath ? null : midi,
      confidence,
      rms: inBreath ? 0.015 : 0.13,
      peak: inBreath ? 0.04 : 0.3,
      gapReason: inBreath ? (note ? 'below-confidence' : 'silence') : null,
      detectorVersion: DETECTOR_VERSION,
    })
  }
  return points
}

export function createDemoTake(notes: readonly AppTargetNote[], label = 'Demo take'): AppTake {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    label,
    projectStartSeconds: 0,
    durationSeconds: 7.5,
    audioAssetId: null,
    audioMimeType: null,
    partialReason: null,
    points: createMockPitchTrace(notes),
  }
}

export function createDemoProject(): AppProject {
  const now = new Date().toISOString()
  const notes = createDemoNotes()
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    title: 'Synthetic warm-up',
    createdAt: now,
    updatedAt: now,
    referenceName: 'Bundled synthetic sine melody',
    referenceAssetId: null,
    referenceMimeType: 'audio/wav',
    referenceDurationSeconds: 8,
    isSyntheticDemo: true,
    targetMode: 'manual',
    targetStatus: 'Authoritative synthetic target · no copyrighted audio',
    targetSourceAssetId: null,
    targetSourceName: null,
    targetSourceMimeType: null,
    targetRevision: 1,
    transpositionSemitones: 0,
    alignmentSeconds: 0,
    timingOffsetSeconds: 0,
    notes,
    targetPitchPoints: [],
    loops: [
      {
        id: crypto.randomUUID(),
        name: 'Rising phrase',
        startSeconds: 0,
        endSeconds: 7.5,
        repetitions: 2,
        enabled: true,
      },
    ],
    takes: [],
    lastBackupAt: null,
  }
}
