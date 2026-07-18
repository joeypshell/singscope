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

test('review loops the captured visible window instead of a moving viewport', async ({ page }) => {
  await openSyntheticDemo(page)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(
    page.getByRole('region', { name: 'Practice transport' }).getByText('● Recording'),
  ).toBeVisible({ timeout: 8_000 })
  await page.waitForTimeout(2_500)
  await page
    .getByRole('region', { name: 'Practice transport' })
    .getByRole('button', { name: 'Stop' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page).toHaveURL(/#\/review\//, { timeout: 10_000 })

  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByLabel('Loop the visible review range').check()
  await page
    .getByRole('region', { name: 'Practice transport' })
    .getByRole('button', { name: 'Start' })
    .click()
  await page.waitForTimeout(1_600)

  const position = Number(
    await page
      .getByRole('region', { name: 'Practice transport' })
      .getByLabel('Timeline position')
      .inputValue(),
  )
  expect(position).toBeLessThan(1.2)
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

test('manual piano entry saves without an upload and becomes the practice reference', async ({
  page,
}) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('heading', { name: 'Reference and target' })).toBeVisible()

  // Step entry is deliberately scoped to Manual; MIDI and Audio / record retain their own inputs.
  await expect(page.getByRole('heading', { name: 'Enter melody with piano' })).toHaveCount(0)

  await page.getByLabel('Project title').fill('Seven tapped notes')

  const sources = page.getByRole('group', { name: 'Target source' })
  await sources.getByRole('button', { name: 'Manual' }).click()
  await expect(page.getByText('Backing audio (optional for Manual)')).toBeVisible()
  await expect(
    page.getByText('Practice reference: Entered melody · synthesized locally'),
  ).toBeVisible()
  await expect(page.getByText(/No upload is needed/)).toBeVisible()
  const keyboard = page.getByRole('region', { name: 'Enter melody with piano' })
  await expect(keyboard).toBeVisible()

  await page.getByLabel('Transpose (semitones)').fill('2')
  await keyboard.getByLabel('Note length').selectOption('0.5')
  await keyboard.getByLabel('Gap before each new note').selectOption('0.1')

  const keys = keyboard.getByRole('group', { name: 'Piano keys, octave 4' })
  await keys.getByRole('button', { name: 'Add A4' }).click({ clickCount: 2, delay: 20 })
  for (const noteName of ['G4', 'E4', 'F4', 'G4', 'A4']) {
    await keys.getByRole('button', { name: `Add ${noteName}` }).click()
  }

  await expect(keyboard.getByText('7 notes entered.')).toBeVisible()
  await expect(page.getByLabel('Piano note sequence')).toContainText(
    'A4 · A4 · G4 · E4 · F4 · G4 · A4',
  )

  // Keys name the effective pitch; storage keeps the source pitch before the +2 transpose.
  const midiNotes = page.getByLabel('MIDI note')
  await expect(midiNotes).toHaveCount(7)
  await expect(midiNotes.nth(0)).toHaveValue('67')
  await expect(midiNotes.nth(1)).toHaveValue('67')
  await expect(midiNotes.nth(2)).toHaveValue('65')
  await expect(midiNotes.nth(3)).toHaveValue('62')
  await expect(midiNotes.nth(4)).toHaveValue('63')
  await expect(midiNotes.nth(5)).toHaveValue('65')
  await expect(midiNotes.nth(6)).toHaveValue('67')

  const starts = page.getByLabel('Start')
  const ends = page.getByLabel('End')
  for (const [index, value] of [
    '0:00.0',
    '0:00.6',
    '0:01.2',
    '0:01.8',
    '0:02.4',
    '0:03.0',
    '0:03.6',
  ].entries()) {
    await expect(starts.nth(index)).toHaveValue(value)
  }
  for (const [index, value] of [
    '0:00.5',
    '0:01.1',
    '0:01.7',
    '0:02.3',
    '0:02.9',
    '0:03.5',
    '0:04.1',
  ].entries()) {
    await expect(ends.nth(index)).toHaveValue(value)
  }

  await keyboard.getByRole('button', { name: 'Play melody so far' }).click()
  const stopPreview = keyboard.getByRole('button', { name: 'Stop playback' })
  await expect(stopPreview).toBeVisible()
  await expect(stopPreview).toHaveAttribute('aria-pressed', 'true')
  await stopPreview.click()
  await expect(keyboard.getByRole('button', { name: 'Play melody so far' })).toBeVisible()
  await expect(keyboard.getByRole('alert')).toHaveCount(0)

  await keyboard.getByRole('button', { name: 'Undo last note' }).click()
  await expect(keyboard.getByText('6 notes entered.')).toBeVisible()
  await expect(midiNotes).toHaveCount(6)
  await expect(page.getByLabel('Piano note sequence')).toContainText('A4 · A4 · G4 · E4 · F4 · G4')
  await keys.getByRole('button', { name: 'Add A4' }).click()
  await expect(keyboard.getByText('7 notes entered.')).toBeVisible()

  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
  await expect(page.getByText(/Choose a valid backing audio file/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save project' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save project' }).click()
  await expect(page).toHaveURL(/#\/practice\//, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Seven tapped notes' })).toBeVisible()
  await expect(page.getByText('This project has no backing audio.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled({ timeout: 10_000 })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Seven tapped notes' })).toBeVisible()
  await expect(page.getByText('This project has no backing audio.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled({ timeout: 10_000 })
  const persisted = await page.evaluate(async () => {
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
      const payload = records
        .map((record) => record['payload'])
        .find(
          (
            candidate,
          ): candidate is {
            title: string
            targetMode: string
            transpositionSemitones: number
            referenceName: string | null
            referenceAssetId: string | null
            referenceMimeType: string | null
            referenceDurationSeconds: number
            notes: { midiNote: number; startSeconds: number; endSeconds: number }[]
          } =>
            typeof candidate === 'object' &&
            candidate !== null &&
            (candidate as { title?: unknown }).title === 'Seven tapped notes',
        )
      return payload
        ? {
            targetMode: payload.targetMode,
            transpose: payload.transpositionSemitones,
            referenceName: payload.referenceName,
            referenceAssetId: payload.referenceAssetId,
            referenceMimeType: payload.referenceMimeType,
            referenceDurationSeconds: payload.referenceDurationSeconds,
            notes: payload.notes.map(({ midiNote, startSeconds, endSeconds }) => ({
              midiNote,
              startSeconds,
              endSeconds,
            })),
          }
        : null
    } finally {
      database.close()
    }
  })
  expect(persisted).toEqual({
    targetMode: 'manual',
    transpose: 2,
    referenceName: 'Entered melody · synthesized locally',
    referenceAssetId: null,
    referenceMimeType: 'audio/wav',
    referenceDurationSeconds: 4.1,
    notes: [
      { midiNote: 67, startSeconds: 0, endSeconds: 0.5 },
      { midiNote: 67, startSeconds: 0.6, endSeconds: 1.1 },
      { midiNote: 65, startSeconds: 1.2, endSeconds: 1.7 },
      { midiNote: 62, startSeconds: 1.8, endSeconds: 2.3 },
      { midiNote: 63, startSeconds: 2.4, endSeconds: 2.9 },
      { midiNote: 65, startSeconds: 3, endSeconds: 3.5 },
      { midiNote: 67, startSeconds: 3.6, endSeconds: 4.1 },
    ],
  })

  await page.getByRole('button', { name: 'Start' }).click()
  await expect(
    page.getByRole('region', { name: 'Practice transport' }).getByText('● Recording'),
  ).toBeVisible({ timeout: 8_000 })
  await page
    .getByRole('region', { name: 'Practice transport' })
    .getByRole('button', { name: 'Stop' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(page).toHaveURL(/#\/review\//, { timeout: 10_000 })
})

test('recorded melody becomes editable piano notes and a playable local reference', async ({
  page,
}) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New project' }).click()
  await expect(page.getByRole('heading', { name: 'Reference and target' })).toBeVisible()

  await page.getByLabel('Project title').fill('Recorded piano melody')
  const sources = page.getByRole('group', { name: 'Target source' })
  await sources.getByRole('button', { name: 'Audio / record' }).click()

  const recorder = page.getByRole('region', { name: 'Record a melody' })
  await expect(recorder.getByLabel('Also use this melody audio as the backing audio')).toBeChecked()
  await recorder.getByRole('button', { name: 'Start recording' }).click()
  await expect(recorder.getByRole('status')).toContainText('Recording melody')
  await recorder.getByRole('button', { name: 'Stop and analyze' }).click()

  await expect(page.getByText(/7 estimated notes from your recording/)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByLabel('Piano note sequence')).toContainText(
    'A3 · A4 · G♯4 · E4 · F♯4 · G♯4 · A4',
  )
  const midiNotes = page.getByLabel('MIDI note')
  await expect(midiNotes).toHaveCount(7)
  await midiNotes.first().fill('62')
  await expect(page.getByLabel('Piano note sequence')).toContainText('D4 · A4 · G♯4')

  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
  await page.getByRole('button', { name: 'Save project' }).click()
  await expect(page).toHaveURL(/#\/practice\//, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Recorded piano melody' })).toBeVisible()

  const persisted = await page.evaluate(async () => {
    const request = indexedDB.open('singscope:app:v1')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'))
    })
    try {
      const projectTransaction = database.transaction('projects', 'readonly')
      const projectsRequest = projectTransaction.objectStore('projects').getAll()
      const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        projectsRequest.onsuccess = () =>
          resolve(projectsRequest.result as Record<string, unknown>[])
        projectsRequest.onerror = () =>
          reject(projectsRequest.error ?? new Error('Projects could not be read.'))
      })
      const payload = records[0]?.['payload'] as
        | {
            referenceAssetId?: string
            targetSourceAssetId?: string
            targetMode?: string
            targetSourceMimeType?: string
            notes?: { midiNote?: number }[]
            targetPitchPoints?: {
              candidateHz?: number | null
              frequencyHz?: number | null
              gapReason?: string | null
            }[]
          }
        | undefined
      const assetTransaction = database.transaction('assets', 'readonly')
      const assetsRequest = assetTransaction.objectStore('assets').getAll()
      const assets = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        assetsRequest.onsuccess = () => resolve(assetsRequest.result as Record<string, unknown>[])
        assetsRequest.onerror = () =>
          reject(assetsRequest.error ?? new Error('Assets could not be read.'))
      })
      return {
        targetMode: payload?.targetMode,
        targetSourceMimeType: payload?.targetSourceMimeType,
        sharesReference: payload?.referenceAssetId === payload?.targetSourceAssetId,
        midiNotes: payload?.notes?.map((note) => note.midiNote),
        hasPitchGaps: payload?.targetPitchPoints?.some((point) => point.frequencyHz === null),
        hasRejectedCandidates: payload?.targetPitchPoints?.some(
          (point) =>
            point.frequencyHz === null &&
            typeof point.candidateHz === 'number' &&
            point.gapReason === 'below-confidence',
        ),
        committedAssetCount: assets.filter((asset) => asset['status'] === 'committed').length,
      }
    } finally {
      database.close()
    }
  })
  expect(persisted).toMatchObject({
    targetMode: 'isolated-vocal',
    targetSourceMimeType: 'audio/webm;codecs=opus',
    sharesReference: true,
    midiNotes: [62, 69, 68, 64, 66, 68, 69],
    hasPitchGaps: true,
    hasRejectedCandidates: true,
    committedAssetCount: 1,
  })

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Recorded piano melody' })).toBeVisible()
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

    const sessionText = await fileEntry('session.json').getData(new TextWriter())
    const session = JSON.parse(sessionText) as {
      summary: { target: { alignmentSeconds: number; transpositionSemitones: number } }
      settings: { alignmentSeconds: number; transpositionSemitones: number }
    }
    expect(session.summary.target).toMatchObject({
      alignmentSeconds: 0,
      transpositionSemitones: 0,
    })
    expect(session.settings).toMatchObject({ alignmentSeconds: 0, transpositionSemitones: 0 })

    const targetCsv = await fileEntry('target-notes.csv').getData(new TextWriter())
    expect(targetCsv.split(/\r?\n/, 1)[0]).toBe(
      'id,source_start_seconds,source_end_seconds,source_midi_note,effective_start_seconds,effective_end_seconds,effective_midi_note,lyric,scorable',
    )

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
