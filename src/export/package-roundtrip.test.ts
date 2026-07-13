import { describe, expect, it } from 'vitest'

import { createProjectBackup } from './backup-package'
import { createFeedbackPackage } from './feedback-package'
import { stageArchive } from './import-package'

const PROJECT_ID = '12ad03d1-d323-4e53-9b44-ccfe552da537'
const TAKE_ID = '62502936-8db7-4a4e-9995-16095f427eca'

describe('versioned packages', () => {
  it('creates and validates a coach-ready feedback package', async () => {
    const result = await createFeedbackPackage({
      projectId: PROJECT_ID,
      takeId: TAKE_ID,
      detectorVersion: 'yin-1',
      metricsVersion: 'metrics-1',
      createdAt: '2026-07-13T12:00:00.000Z',
      recording: { blob: new Blob(['encoded'], { type: 'audio/mp4' }), extension: 'mp4' },
      pitch: {
        headers: ['time_seconds', 'hz'],
        rows: [
          [0, null],
          [0.02, 440],
        ],
      },
      notes: { headers: ['note', 'accuracy_50'], rows: [['A4', 1]] },
      sections: { headers: ['section', 'coverage'], rows: [['Verse', 0.8]] },
      summary: { accuracy50: 0.8, overallScore: null },
      settings: { confidenceThreshold: 0.75 },
      chartPng: new Blob(['png'], { type: 'image/png' }),
      report: {
        title: 'Take <one>',
        projectName: 'Warmups',
        takeLabel: 'Take 1',
        recordedAt: '2026-07-13T12:00:00.000Z',
        metrics: { 'Within ±50 cents': '80%' },
      },
    })

    expect(result.manifest.includesReferenceAudio).toBe(false)
    const staged = await stageArchive(result.blob, 'feedback')
    expect(staged.manifest.format).toBe('singscope-feedback-package')
    expect(staged.entries.has('recording.mp4')).toBe(true)
    expect(staged.entries.has('pitch-data.csv')).toBe(true)
    expect(staged.entries.has('target-notes.csv')).toBe(true)
    expect(staged.entries.has('session.json')).toBe(true)
    expect(staged.entries.has('pitch-chart.png')).toBe(true)
    expect(new TextDecoder().decode(staged.entries.get('report.html'))).not.toContain('<script')
  })

  it('requires an explicit rights confirmation before reference audio is included', async () => {
    const result = await createFeedbackPackage({
      projectId: PROJECT_ID,
      takeId: TAKE_ID,
      detectorVersion: 'yin-1',
      metricsVersion: 'metrics-1',
      recording: { blob: new Blob(['encoded'], { type: 'audio/mp4' }), extension: 'mp4' },
      reference: { blob: new Blob(['reference'], { type: 'audio/mp4' }), extension: 'mp4' },
      includeReferenceAudio: true,
      referenceRightsConfirmed: false,
      pitch: { headers: ['time'], rows: [] },
      notes: { headers: ['note'], rows: [] },
      sections: { headers: ['section'], rows: [] },
      summary: {},
      settings: {},
      chartPng: new Blob(['png'], { type: 'image/png' }),
      report: {
        title: 'Take',
        projectName: 'Warmups',
        takeLabel: 'Take 1',
        recordedAt: 'today',
        metrics: {},
      },
    })
    expect(result.manifest.includesReferenceAudio).toBe(false)
    expect(result.omissions[0]).toMatch(/rights warning/)
  })

  it('round-trips a project backup with pitch and binary assets', async () => {
    const result = await createProjectBackup({
      projectId: PROJECT_ID,
      createdAt: '2026-07-13T12:00:00.000Z',
      project: { id: PROJECT_ID, name: 'Warmups' },
      references: [],
      targets: [],
      sections: [],
      takes: [],
      settings: {},
      pitchChunks: [{ filename: 'take-0001.json', value: [{ timeSeconds: 0, hz: null }] }],
      assets: [{ filename: 'backing.mp4', blob: new Blob(['audio'], { type: 'audio/mp4' }) }],
    })

    const staged = await stageArchive(result.blob, 'backup')
    expect(staged.manifest.format).toBe('singscope-project-backup')
    expect(staged.entries.has('assets/backing.mp4')).toBe(true)
    expect(staged.entries.has('pitch/take-0001.json')).toBe(true)
  })
})
