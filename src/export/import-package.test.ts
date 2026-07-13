import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import { describe, expect, it } from 'vitest'

import { stageArchive } from './import-package'

describe('staged archive validation', () => {
  it('rejects unexpected executable paths before reading imported data', async () => {
    const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
    await writer.add('evil.exe', new BlobReader(new Blob(['not executable'])), {
      useWebWorkers: false,
    })
    const archive = await writer.close()

    await expect(stageArchive(archive, 'feedback')).rejects.toThrow(/unexpected path/)
  })

  it('rejects a package whose manifest omits required fixed files', async () => {
    const manifest = {
      format: 'singscope-feedback-package',
      schemaVersion: 1,
      packageId: '3e412ccf-778e-4386-a4ce-11f39c51eb0d',
      projectId: '12ad03d1-d323-4e53-9b44-ccfe552da537',
      takeId: '62502936-8db7-4a4e-9995-16095f427eca',
      createdAt: '2026-07-13T12:00:00.000Z',
      detectorVersion: 'yin-1',
      metricsVersion: 'metrics-1',
      includesReferenceAudio: false,
      files: [],
      omissions: [],
    }
    const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
    await writer.add(
      'manifest.json',
      new BlobReader(new Blob([JSON.stringify(manifest)], { type: 'application/json' })),
      { useWebWorkers: false },
    )
    const archive = await writer.close()

    await expect(stageArchive(archive, 'feedback')).rejects.toThrow(/missing required file/)
  })
})
