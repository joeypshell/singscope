import { describe, expect, it } from 'vitest'

import { createDemoProject, createDemoTake } from './demo'
import { appProjectSchema } from './project-schema'
import type { AppPitchPoint } from './types'
import {
  projectScene,
  reviewScene,
  takeMetrics,
  targetAnalysisScene,
  toTargetSet,
} from './view-models'

function pitchPoint(overrides: Partial<AppPitchPoint> = {}): AppPitchPoint {
  return {
    timeSeconds: 0.5,
    contextTimeSeconds: 10.5,
    candidateHz: 110,
    frequencyHz: null,
    midiNote: null,
    confidence: 0.5,
    rms: 0.1,
    peak: 0.2,
    gapReason: 'below-confidence',
    detectorVersion: 'yin-24k-v1',
    ...overrides,
  }
}

describe('application view models', () => {
  it('preserves the source asset link for an analyzed target revision', () => {
    const targetSourceAssetId = crypto.randomUUID()
    const project = {
      ...createDemoProject(),
      targetMode: 'isolated-vocal' as const,
      targetSourceAssetId,
      targetSourceName: 'recorded-melody.m4a',
      targetSourceMimeType: 'audio/mp4',
    }

    expect(toTargetSet(project)).toMatchObject({
      kind: 'analyzed',
      sourceAssetId: targetSourceAssetId,
    })
  })

  it('renders raw low-confidence candidates and auto-ranges low and high supported notes', () => {
    const project = createDemoProject()
    const scene = projectScene(
      project,
      [pitchPoint(), pitchPoint({ timeSeconds: 0.7, candidateHz: 1046.5, confidence: 0.6 })],
      0.7,
    )

    expect(scene.raw.map((point) => point.frequencyHz)).toEqual([110, 1046.5])
    expect(scene.viewport.minMidi).toBeLessThanOrEqual(45)
    expect(scene.viewport.maxMidi).toBeGreaterThanOrEqual(84)
  })

  it('keeps the exact-source verifier at recorded pitch before project transpose', () => {
    const project = {
      ...createDemoProject(),
      transpositionSemitones: 12,
      targetPitchPoints: [
        {
          timeSeconds: 0.5,
          candidateHz: 130.81,
          frequencyHz: null,
          midiNote: null,
          confidence: 0.58,
          rms: 0.08,
          peak: 0.2,
          gapReason: 'below-confidence' as const,
        },
        {
          timeSeconds: 0.7,
          candidateHz: 261.63,
          frequencyHz: 261.63,
          midiNote: 60,
          confidence: 0.95,
          rms: 0.1,
          peak: 0.24,
          gapReason: null,
        },
      ],
      notes: [
        {
          id: crypto.randomUUID(),
          startSeconds: 0,
          endSeconds: 1,
          midiNote: 60,
          lyric: '',
          scorable: true,
        },
      ],
    }
    const scene = targetAnalysisScene(project, 1)

    expect(scene.targets[0]?.frequencyHz).toBeCloseTo(261.63, 1)
    expect(scene.source[1]?.frequencyHz).toBeCloseTo(261.63, 1)
    expect(scene.raw.map((point) => point.frequencyHz)).toEqual([130.81, 261.63])
    expect(scene.gaps).toHaveLength(1)
    expect(scene.viewport.minMidi).toBeLessThanOrEqual(48)
  })

  it('keeps legacy analyzed-target points readable without inventing raw candidates', () => {
    const project = {
      ...createDemoProject(),
      targetPitchPoints: [
        { timeSeconds: 0.5, frequencyHz: 261.63, midiNote: 60, confidence: 0.95 },
      ],
    }
    const migrated = appProjectSchema.parse(project)
    const scene = targetAnalysisScene(migrated, 1)

    expect(scene.source[0]?.frequencyHz).toBeCloseTo(261.63, 1)
    expect(scene.raw[0]?.frequencyHz).toBeNull()
  })

  it('validates additive source-gap diagnostics without assuming normalized levels', () => {
    const project = appProjectSchema.parse({
      ...createDemoProject(),
      targetPitchPoints: [
        {
          timeSeconds: 0.5,
          candidateHz: null,
          frequencyHz: null,
          midiNote: null,
          confidence: null,
          rms: null,
          peak: null,
          gapReason: 'source-gap',
        },
        {
          timeSeconds: 0.7,
          candidateHz: 220,
          frequencyHz: null,
          midiNote: null,
          confidence: 0.5,
          rms: 1.1,
          peak: 1.2,
          gapReason: 'below-confidence',
        },
      ],
    })

    expect(project.targetPitchPoints[0]?.gapReason).toBe('source-gap')
    expect(project.targetPitchPoints[1]).toMatchObject({
      peak: 1.2,
      gapReason: 'below-confidence',
    })
  })

  it('maps a nonzero project loop onto take-local review time', () => {
    const project = {
      ...createDemoProject(),
      referenceDurationSeconds: 20,
      notes: [
        {
          id: crypto.randomUUID(),
          startSeconds: 10,
          endSeconds: 11,
          midiNote: 60,
          lyric: '',
          scorable: true,
        },
      ],
    }
    const point = pitchPoint({
      timeSeconds: 10.5,
      candidateHz: 261.63,
      frequencyHz: 261.63,
      midiNote: 60,
      confidence: 0.95,
      gapReason: null,
    })
    const take = {
      ...createDemoTake(project.notes),
      projectStartSeconds: 10,
      durationSeconds: 2,
      points: [point],
    }
    const scene = reviewScene(project, take, 0.5)

    expect(scene.viewport).toMatchObject({ startSeconds: 0, endSeconds: 2 })
    expect(scene.targets[0]).toMatchObject({ startSeconds: 0, endSeconds: 1 })
    expect(scene.raw[0]?.timeSeconds).toBeCloseTo(0.5)
    expect(scene.playheadSeconds).toBe(0.5)
  })

  it('infers the project origin for loop takes saved before the mapping field existed', () => {
    const project = createDemoProject()
    const take = {
      ...createDemoTake(project.notes),
      projectStartSeconds: undefined,
      durationSeconds: 2,
      points: [pitchPoint({ timeSeconds: 10.02 }), pitchPoint({ timeSeconds: 11.98 })],
    }
    const migrated = appProjectSchema.parse({ ...project, takes: [take] })
    expect(migrated.takes[0]?.projectStartSeconds).toBeCloseTo(10)
  })

  it('does not charge a loop take for target entrances outside its recorded interval', () => {
    const project = {
      ...createDemoProject(),
      notes: [
        {
          id: crypto.randomUUID(),
          startSeconds: 0,
          endSeconds: 1,
          midiNote: 67,
          lyric: '',
          scorable: true,
        },
        {
          id: crypto.randomUUID(),
          startSeconds: 10,
          endSeconds: 11,
          midiNote: 60,
          lyric: '',
          scorable: true,
        },
      ],
      loops: [],
    }
    const take = {
      ...createDemoTake(project.notes),
      projectStartSeconds: 10,
      durationSeconds: 1,
      points: [
        pitchPoint({
          timeSeconds: 10.5,
          candidateHz: 261.63,
          frequencyHz: 261.63,
          midiNote: 60,
          confidence: 0.95,
          gapReason: null,
        }),
      ],
    }
    expect(takeMetrics(project, take).overall.noteAccuracy).toBe(1)
  })

  it('applies timing offset consistently to traces, gaps, and metrics', () => {
    const project = {
      ...createDemoProject(),
      timingOffsetSeconds: 0.2,
      notes: [
        {
          id: crypto.randomUUID(),
          startSeconds: 0.7,
          endSeconds: 1.2,
          midiNote: 60,
          lyric: '',
          scorable: true,
        },
      ],
      loops: [],
    }
    const gap = pitchPoint({ timeSeconds: 0.5 })
    const accepted = pitchPoint({
      timeSeconds: 0.55,
      candidateHz: 261.63,
      frequencyHz: 261.63,
      midiNote: 60,
      confidence: 0.95,
      gapReason: null,
    })
    const take = { ...createDemoTake(project.notes), points: [gap, accepted] }
    const scene = reviewScene(project, take, 0.7)

    expect(scene.raw[0]?.timeSeconds).toBeCloseTo(0.7)
    expect(scene.gaps[0]?.startSeconds).toBeCloseTo(0.7)
    expect(takeMetrics(project, take).overall.coverage).not.toBeNull()
  })
})
