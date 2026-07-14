/// <reference types="node" />

import { readFile } from 'node:fs/promises'

import {
  BlobReader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js'
import { expect, test } from '@playwright/test'

import { installDeterministicBrowserAdapters, openApp } from './helpers'

test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowserAdapters(page)
})

test('recorded-melody diagnostics require a fresh save tap and include raw evidence', async ({
  page,
}) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('heading', { name: 'Reference and target' })).toBeVisible()

  await page.getByLabel('Project title').fill('Debug package acceptance')
  await page
    .getByRole('group', { name: 'Target source' })
    .getByRole('button', { name: 'Audio / record' })
    .click()

  const recorder = page.getByRole('region', { name: 'Record a melody' })
  await recorder.getByRole('button', { name: 'Start recording' }).click()
  await expect(recorder.getByRole('status')).toContainText('Recording melody')
  await recorder.getByRole('button', { name: 'Stop and analyze' }).click()

  await expect(page.getByText(/7 estimated notes from your recording/)).toBeVisible({
    timeout: 15_000,
  })

  const debugPanel = page.getByRole('region', { name: 'Help diagnose a missed-note bug' })
  await expect(debugPanel).toBeVisible()
  await debugPanel.getByLabel('Number of notes you played (optional)').fill('7')
  await debugPanel.getByLabel('Microphone route').selectOption('built-in')
  await debugPanel
    .getByLabel('What went wrong? (optional)')
    .fill('Seven piano notes were audible, but only four appeared in the target.')

  const prepare = debugPanel.getByRole('button', { name: '1. Prepare debug package' })
  const shareOrSave = debugPanel.getByRole('button', { name: /^2\. Share \/ Save/ })
  await expect(shareOrSave).toBeDisabled()

  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await prepare.click()
  await expect(shareOrSave).toBeEnabled({ timeout: 20_000 })
  expect(downloads).toEqual([])

  const downloadPromise = page.waitForEvent('download')
  await shareOrSave.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('singscope-analysis-debug.zip')

  const downloadPath = await download.path()
  const bytes = await readFile(downloadPath)
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(bytes)])))
  try {
    const entries = await reader.getEntries()
    const fileEntry = (name: string): FileEntry => {
      const entry: Entry | undefined = entries.find((candidate) => candidate.filename === name)
      if (entry === undefined || entry.directory)
        throw new Error(`${name} is missing from the ZIP.`)
      return entry
    }

    const manifestText = await fileEntry('manifest.json').getData(new TextWriter())
    const manifest = JSON.parse(manifestText) as {
      format: string
      sourceAudioPath: string
      contourPointCount: number
      candidateNoteCount: number
      files: { path: string; byteLength: number; sha256: string }[]
    }
    expect(manifest.format).toBe('singscope-analysis-debug-package')
    expect(manifest.sourceAudioPath).toMatch(/^source-audio\.(aac|m4a|mp3|mp4|webm|wav)$/)
    expect(manifest.contourPointCount).toBeGreaterThan(0)
    expect(manifest.candidateNoteCount).toBe(7)
    expect(manifest.files.every((file) => file.byteLength > 0)).toBe(true)
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)

    const names = entries.map((entry) => entry.filename)
    expect(names).toEqual(
      expect.arrayContaining([
        'manifest.json',
        manifest.sourceAudioPath,
        'diagnostics.json',
        'contour.csv',
        'estimated-notes.csv',
        'README.txt',
      ]),
    )

    const audio = await fileEntry(manifest.sourceAudioPath).getData(new Uint8ArrayWriter())
    expect(audio.byteLength).toBeGreaterThan(44)

    const analysisText = await fileEntry('diagnostics.json').getData(new TextWriter())
    const analysis = JSON.parse(analysisText) as {
      userReport: { expectedNoteCount: number | null; description: string | null }
      capture: { routeCategory: string | null }
      analysis: { contour: unknown[]; candidateNotes: unknown[] }
    }
    expect(analysis.userReport).toEqual({
      expectedNoteCount: 7,
      description: 'Seven piano notes were audible, but only four appeared in the target.',
    })
    expect(analysis.capture.routeCategory).toBe('built-in')
    expect(analysis.analysis.contour.length).toBeGreaterThan(0)
    expect(analysis.analysis.candidateNotes).toHaveLength(7)

    const contourCsv = await fileEntry('contour.csv').getData(new TextWriter())
    expect(contourCsv).toContain('candidate_hz')
    expect(contourCsv.split(/\r?\n/).length).toBeGreaterThan(2)

    const notesCsv = await fileEntry('estimated-notes.csv').getData(new TextWriter())
    expect(notesCsv).toContain('mean_confidence')
    expect(notesCsv.split(/\r?\n/).length).toBeGreaterThan(7)
  } finally {
    await reader.close()
  }
})
