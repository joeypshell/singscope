/// <reference types="node" />

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BlobReader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js'
import { expect, test } from '@playwright/test'

import {
  installDeterministicBrowserAdapters,
  openApp,
  openSyntheticDemo,
  recordSyntheticTake,
  twoTrackMidiFixture,
} from './helpers'

test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowserAdapters(page)
})

test('demo practice saves a take and opens transparent review', async ({ page }) => {
  await recordSyntheticTake(page)

  await expect(page.getByText('Review · Take 1')).toBeVisible()
  await expect(
    page.getByText('No overall score. Every number is independently inspectable.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cents view' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Coach-ready package' })).toBeVisible()

  const persistedTakeCount = await page.evaluate(async () => {
    const request = indexedDB.open('singscope:app:v1')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'))
    })
    try {
      const transaction = database.transaction('projects', 'readonly')
      const recordsRequest = transaction.objectStore('projects').getAll()
      const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        recordsRequest.onsuccess = () => resolve(recordsRequest.result as Record<string, unknown>[])
        recordsRequest.onerror = () =>
          reject(recordsRequest.error ?? new Error('Projects could not be read.'))
      })
      const payload = records[0]?.['payload'] as { takes?: unknown[] } | undefined
      return payload?.takes?.length ?? 0
    } finally {
      database.close()
    }
  })
  expect(persistedTakeCount).toBe(1)
})

test('enabled loop repetitions are saved as separate takes', async ({ page }) => {
  await openSyntheticDemo(page)
  const loopEnd = page.getByLabel('Loop end')
  await loopEnd.fill('0.300')
  await loopEnd.press('Tab')
  await expect(page.getByLabel('Repetitions')).toHaveValue('2')
  await expect(page.getByLabel('Repeat automatically as separate takes')).toBeChecked()

  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page).toHaveURL(/#\/review\//, { timeout: 15_000 })
  await expect(page.getByText('Review · Take 2')).toBeVisible()

  const persistedTakeCount = await page.evaluate(async () => {
    const request = indexedDB.open('singscope:app:v1')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'))
    })
    try {
      const transaction = database.transaction('projects', 'readonly')
      const recordsRequest = transaction.objectStore('projects').getAll()
      const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        recordsRequest.onsuccess = () => resolve(recordsRequest.result as Record<string, unknown>[])
        recordsRequest.onerror = () =>
          reject(recordsRequest.error ?? new Error('Projects could not be read.'))
      })
      const payload = records[0]?.['payload'] as { takes?: unknown[] } | undefined
      return payload?.takes?.length ?? 0
    } finally {
      database.close()
    }
  })
  expect(persistedTakeCount).toBe(2)
})

test('backing audio and MIDI track selection create a rendered target', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('heading', { name: 'Reference and target' })).toBeVisible()

  await page.getByLabel('Project title').fill('MIDI acceptance melody')
  await page
    .getByLabel(/Backing audio/)
    .setInputFiles(join(process.cwd(), 'public', 'demo-reference.wav'))
  await expect(page.getByText('Reference: demo-reference.wav')).toBeVisible({ timeout: 10_000 })

  await page.getByLabel(/MIDI format 0 or 1/).setInputFiles({
    name: 'two-tracks.mid',
    mimeType: 'audio/midi',
    buffer: twoTrackMidiFixture(),
  })
  await expect(page.getByText(/2 notes loaded from Melody/)).toBeVisible({ timeout: 10_000 })

  const track = page.getByLabel('Melody track')
  await expect(track).toBeVisible()
  await track.selectOption('2')
  await expect(page.getByText(/1 MIDI notes imported/)).toBeVisible()
  await expect(page.getByText('Note 1', { exact: true })).toBeVisible()
  await expect(page.getByLabel('MIDI note')).toHaveValue('67')

  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
  await page.getByRole('button', { name: 'Save project' }).click()
  await expect(page).toHaveURL(/#\/practice\//, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'MIDI acceptance melody' })).toBeVisible()
  await expect(
    page.getByRole('img', { name: /Live target and detected pitch chart/ }),
  ).toBeVisible()

  const noteCount = await page.evaluate(async () => {
    const request = indexedDB.open('singscope:app:v1')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'))
    })
    try {
      const transaction = database.transaction('projects', 'readonly')
      const recordsRequest = transaction.objectStore('projects').getAll()
      const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        recordsRequest.onsuccess = () => resolve(recordsRequest.result as Record<string, unknown>[])
        recordsRequest.onerror = () =>
          reject(recordsRequest.error ?? new Error('Projects could not be read.'))
      })
      const payload = records[0]?.['payload'] as { notes?: unknown[] } | undefined
      return payload?.notes?.length ?? 0
    } finally {
      database.close()
    }
  })
  expect(noteCount).toBe(1)
})

test('prepared feedback ZIP contains every required coach file', async ({ page }) => {
  await recordSyntheticTake(page)

  const wavOption = page.getByLabel(/Include WAV/)
  if (await wavOption.isChecked()) await wavOption.uncheck()
  await page.getByRole('button', { name: 'Prepare package' }).click()

  const save = page.getByRole('button', { name: /Save to Files/ })
  await expect(save).toBeEnabled({ timeout: 20_000 })
  const downloadPromise = page.waitForEvent('download')
  await save.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('singscope-feedback.zip')

  const downloadPath = await download.path()
  const bytes = await readFile(downloadPath)
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(bytes)])))
  try {
    const entries = await reader.getEntries()
    const names = entries.map((entry) => entry.filename).sort()
    expect(names).toEqual(
      [
        'README.txt',
        'manifest.json',
        'pitch-chart.png',
        'pitch-data.csv',
        'recording.webm',
        'report.html',
        'session.json',
        'target-notes.csv',
      ].sort(),
    )

    const fileEntry = (name: string): FileEntry => {
      const entry: Entry | undefined = entries.find((candidate) => candidate.filename === name)
      if (entry === undefined || entry.directory)
        throw new Error(`${name} is missing from the ZIP.`)
      return entry
    }

    const manifestText = await fileEntry('manifest.json').getData(new TextWriter())
    const manifest = JSON.parse(manifestText) as {
      format: string
      includesReferenceAudio: boolean
      files: { path: string; sha256: string }[]
    }
    expect(manifest.format).toBe('singscope-feedback-package')
    expect(manifest.includesReferenceAudio).toBe(false)
    expect(manifest.files.map((file) => file.path)).not.toContain('reference.wav')
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)

    const report = await fileEntry('report.html').getData(new TextWriter())
    expect(report).not.toMatch(/<script/i)

    const chart = await fileEntry('pitch-chart.png').getData(new Uint8ArrayWriter())
    expect([...chart.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  } finally {
    await reader.close()
  }
})

test('IndexedDB project survives a full reload', async ({ page }) => {
  await openSyntheticDemo(page)
  const urlBeforeReload = page.url()

  await page.reload()

  await expect(page).toHaveURL(urlBeforeReload)
  await expect(page.getByRole('heading', { name: 'Synthetic warm-up' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Rising phrase/ })).toBeVisible()
  await expect(
    page.getByRole('img', { name: /Live target and detected pitch chart/ }),
  ).toBeVisible()
})
