import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderMelodyReferenceWav } from '../audio/dsp'
import type { AppProject } from './types'
import { referenceAudioUrl } from './files'

const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

afterEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: originalCreateObjectUrl,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: originalRevokeObjectUrl,
  })
})

function manualProject(): AppProject {
  const timestamp = '2026-07-17T00:00:00.000Z'
  return {
    id: '10000000-0000-4000-8000-000000000001',
    schemaVersion: 1,
    title: 'Entered melody',
    createdAt: timestamp,
    updatedAt: timestamp,
    referenceName: 'Entered melody · synthesized locally',
    referenceAssetId: null,
    referenceMimeType: 'audio/wav',
    referenceDurationSeconds: 1.1,
    isSyntheticDemo: false,
    targetMode: 'manual',
    targetStatus: 'Authoritative target revision',
    targetSourceAssetId: null,
    targetSourceName: null,
    targetSourceMimeType: null,
    targetRevision: 1,
    transpositionSemitones: 2,
    alignmentSeconds: 0,
    timingOffsetSeconds: 0,
    notes: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        startSeconds: 0,
        endSeconds: 0.5,
        midiNote: 67,
        lyric: '',
        scorable: true,
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        startSeconds: 0.6,
        endSeconds: 1.1,
        midiNote: 65,
        lyric: '',
        scorable: true,
      },
    ],
    targetPitchPoints: [],
    loops: [],
    takes: [],
    lastBackupAt: null,
  }
}

describe('referenceAudioUrl', () => {
  it('turns a note-only manual project into revocable local WAV audio', async () => {
    const createObjectUrl = vi.fn((blobValue: Blob) => {
      void blobValue
      return 'blob:synthesized-manual-reference'
    })
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })

    const result = await referenceAudioUrl(manualProject(), (input) =>
      Promise.resolve(renderMelodyReferenceWav(input)),
    )

    expect(result.url).toBe('blob:synthesized-manual-reference')
    expect(createObjectUrl).toHaveBeenCalledOnce()
    const blob = createObjectUrl.mock.calls[0]?.[0]
    expect(blob).toBeInstanceOf(Blob)
    if (!(blob instanceof Blob)) throw new Error('The generated reference was not a Blob.')
    expect(blob.type).toBe('audio/wav')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(bytes.byteLength).toBeGreaterThan(44)

    result.revoke()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:synthesized-manual-reference')
  })
})
