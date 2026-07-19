/// <reference types="node" />

import { createHash } from 'node:crypto'

import {
  BlobReader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js'
import { expect, test, type Page, type Route } from '@playwright/test'

import { installDeterministicBrowserAdapters, openApp, recordSyntheticTake } from './helpers'

const REPORT_URL = '**/functions/v1/analysis-report'
const RECEIPT = {
  format: 'singscope-analysis-report-receipt',
  schemaVersion: 1,
  reportId: '7f034c18-3f71-4cc8-9ae7-d353f5ef8001',
  receivedAt: '2026-07-14T18:30:00.000Z',
} as const
const TICKET = {
  format: 'singscope-analysis-report-ticket',
  schemaVersion: 1,
  ticket: 'playwright-ticket.signature',
  difficulty: 4,
  expiresAt: '2026-07-14T18:32:00.000Z',
} as const

interface CapturedReportUpload {
  readonly bytes: number[]
  readonly headers: Record<string, string>
}

test.setTimeout(90_000)

test.beforeEach(async ({ page }) => {
  await installDeterministicBrowserAdapters(page)
  await page.addInitScript(() => {
    const uploads: CapturedReportUpload[] = []
    const state = window as typeof window & {
      __singscopeReportUploads?: CapturedReportUpload[]
    }
    state.__singscopeReportUploads = uploads
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/functions/v1/analysis-report') && init?.body instanceof Blob) {
        uploads.push({
          bytes: [...new Uint8Array(await init.body.arrayBuffer())],
          headers: Object.fromEntries(new Headers(init.headers).entries()),
        })
      }
      return originalFetch(input, init)
    }
  })
})

async function capturedUploads(page: Page): Promise<CapturedReportUpload[]> {
  return page.evaluate(() => {
    const state = window as typeof window & {
      __singscopeReportUploads?: CapturedReportUpload[]
    }
    return state.__singscopeReportUploads ?? []
  })
}

function isTicketRequest(route: Route): boolean {
  return route.request().headers()['content-type']?.startsWith('application/json') ?? false
}

async function recordDeterministicMelody(page: Page) {
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
  return page.getByRole('region', { name: 'Report a missed-note bug' })
}

test('explicitly sends recorded-melody diagnostics once and includes raw evidence', async ({
  page,
}) => {
  let uploadCount = 0
  await page.route(REPORT_URL, async (route) => {
    if (isTicketRequest(route)) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(TICKET),
      })
      return
    }
    uploadCount += 1
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(RECEIPT),
    })
  })

  const debugPanel = await recordDeterministicMelody(page)
  await expect(debugPanel).toBeVisible()
  await debugPanel.getByLabel('Number of notes you played (optional)').fill('7')
  await debugPanel.getByLabel('Microphone route').selectOption('built-in')
  await debugPanel
    .getByLabel('What went wrong? (optional)')
    .fill('Seven piano notes were audible, but only four appeared in the target.')

  const send = debugPanel.getByRole('button', { name: 'Send bug report' })
  await expect(send).toBeEnabled()
  expect(uploadCount).toBe(0)

  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await send.click()
  await expect(debugPanel.getByText('Bug report sent', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    debugPanel.getByText(/Report ID: 7f034c18-3f71-4cc8-9ae7-d353f5ef8001/),
  ).toBeVisible()
  await expect(debugPanel.getByRole('button', { name: 'Report sent' })).toBeDisabled()

  expect(uploadCount).toBe(1)
  expect(downloads).toEqual([])
  const uploads = await capturedUploads(page)
  expect(uploads).toHaveLength(1)
  const upload = uploads[0]
  if (upload === undefined) throw new Error('Report upload was not seen.')
  expect(upload.headers['content-type']).toBe('application/zip')
  expect(upload.headers['x-singscope-schema-version']).toBe('1')
  expect(upload.headers['x-singscope-package-id']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  expect(upload.headers['x-singscope-package-sha256']).toBe(
    createHash('sha256').update(Buffer.from(upload.bytes)).digest('hex'),
  )

  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(upload.bytes)])))
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

test('explicitly sends a completed practice take from Review with capture diagnostics', async ({
  page,
}) => {
  let uploadCount = 0
  await page.route(REPORT_URL, async (route) => {
    if (isTicketRequest(route)) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(TICKET),
      })
      return
    }
    uploadCount += 1
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(RECEIPT),
    })
  })

  await recordSyntheticTake(page)
  expect(uploadCount).toBe(0)

  await page.getByText('Report recording problem', { exact: true }).click()
  const debugPanel = page.getByRole('region', { name: 'Report this take' })
  await expect(debugPanel).toBeVisible()
  await debugPanel.getByLabel('Number of notes you played (optional)').fill('7')
  await debugPanel.getByLabel('Audio route').selectOption('speaker')
  await debugPanel
    .getByLabel('What went wrong? (optional)')
    .fill('The guide became grainy and the singing was not captured correctly.')
  expect(uploadCount).toBe(0)

  await debugPanel.getByRole('button', { name: 'Send bug report' }).click()
  await expect(debugPanel.getByText('Bug report sent', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  expect(uploadCount).toBe(1)

  const uploads = await capturedUploads(page)
  expect(uploads).toHaveLength(1)
  const upload = uploads[0]
  if (upload === undefined) throw new Error('Practice-take report upload was not seen.')
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(upload.bytes)])))
  try {
    const entries = await reader.getEntries()
    const fileEntry = (name: string): FileEntry => {
      const entry = entries.find((candidate) => candidate.filename === name)
      if (entry === undefined || entry.directory)
        throw new Error(`${name} is missing from the ZIP.`)
      return entry
    }
    const manifest = JSON.parse(await fileEntry('manifest.json').getData(new TextWriter())) as {
      sourceAudioPath: string
      contourPointCount: number
    }
    expect(manifest.contourPointCount).toBeGreaterThan(0)
    const sourceAudio = await fileEntry(manifest.sourceAudioPath).getData(new Uint8ArrayWriter())
    expect(sourceAudio.byteLength).toBeGreaterThan(44)

    const diagnosticsText = await fileEntry('diagnostics.json').getData(new TextWriter())
    const diagnostics = JSON.parse(diagnosticsText) as {
      userReport: { expectedNoteCount: number | null; description: string | null }
      capture: {
        routeCategory: string | null
        recorderDurationSeconds: number | null
      }
      analysis: { contour: unknown[] }
    }
    expect(diagnostics.userReport.expectedNoteCount).toBe(7)
    expect(diagnostics.userReport.description).toContain(
      'The guide became grainy and the singing was not captured correctly.',
    )
    expect(diagnostics.userReport.description).toContain(
      'Automatic runtime diagnostics: profile=raw',
    )
    expect(diagnostics.capture.routeCategory).toBe('speaker')
    expect(diagnostics.capture.recorderDurationSeconds).toBeGreaterThan(0)
    expect(diagnostics.analysis.contour.length).toBeGreaterThan(0)
    expect(diagnosticsText).not.toContain('Synthetic warm-up')
  } finally {
    await reader.close()
  }
})

test('keeps a Safari decode failure directly reportable with the failed recording', async ({
  page,
}) => {
  await page.route(REPORT_URL, async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(isTicketRequest(route) ? TICKET : RECEIPT),
    })
  })
  await openApp(page)
  await page.evaluate(() => {
    Object.defineProperty(window.AudioContext.prototype, 'decodeAudioData', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Decoding failed', 'EncodingError')),
    })
  })
  await page.getByRole('button', { name: 'New project' }).click()
  await page.getByLabel('Project title').fill('Decode failure evidence')
  await page
    .getByRole('group', { name: 'Target source' })
    .getByRole('button', { name: 'Audio / record' })
    .click()

  const recorder = page.getByRole('region', { name: 'Record a melody' })
  await recorder.getByRole('button', { name: 'Start recording' }).click()
  await expect(recorder.getByRole('status')).toContainText('Recording melody')
  await recorder.getByRole('button', { name: 'Stop and analyze' }).click()

  await expect(recorder.getByRole('alert')).toContainText('Recording needs attention')
  await expect(recorder).toContainText('could not decode this audio for pitch analysis')
  const debugPanel = page.getByRole('region', { name: 'Report this recording failure' })
  await expect(debugPanel).toBeVisible()
  const description = debugPanel.getByLabel('What went wrong? (optional)')
  await expect(description).toHaveValue(
    /Recording decode failed before pitch analysis: Decoding failed/,
  )
  await description.fill('Happened twice on this iPhone.')
  await debugPanel.getByLabel('Number of notes you played (optional)').fill('7')
  await debugPanel.getByRole('button', { name: 'Send bug report' }).click()
  await expect(debugPanel.getByText('Bug report sent', { exact: true })).toBeVisible({
    timeout: 20_000,
  })

  const uploads = await capturedUploads(page)
  expect(uploads).toHaveLength(1)
  const upload = uploads[0]
  if (upload === undefined) throw new Error('Decode-failure report upload was not seen.')
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(upload.bytes)])))
  try {
    const entries = await reader.getEntries()
    const fileEntry = (name: string): FileEntry => {
      const entry = entries.find((candidate) => candidate.filename === name)
      if (entry === undefined || entry.directory)
        throw new Error(`${name} is missing from the ZIP.`)
      return entry
    }
    const manifest = JSON.parse(await fileEntry('manifest.json').getData(new TextWriter())) as {
      sourceAudioPath: string
      contourPointCount: number
      candidateNoteCount: number
    }
    expect(manifest.contourPointCount).toBe(0)
    expect(manifest.candidateNoteCount).toBe(0)
    const sourceBytes = await fileEntry(manifest.sourceAudioPath).getData(new Uint8ArrayWriter())
    expect(sourceBytes.byteLength).toBeGreaterThan(44)
    const diagnostics = JSON.parse(
      await fileEntry('diagnostics.json').getData(new TextWriter()),
    ) as {
      userReport: { expectedNoteCount: number | null; description: string | null }
      capture: {
        decodedDurationSeconds: number | null
        decodedSampleRateHz: number | null
        decodedChannelCount: number | null
      }
    }
    expect(diagnostics.userReport.expectedNoteCount).toBe(7)
    expect(diagnostics.userReport.description).toContain('Decoding failed')
    expect(diagnostics.userReport.description).toContain(
      'User note: Happened twice on this iPhone.',
    )
    expect(diagnostics.capture.decodedDurationSeconds).toBeNull()
    expect(diagnostics.capture.decodedSampleRateHz).toBeNull()
    expect(diagnostics.capture.decodedChannelCount).toBeNull()
  } finally {
    await reader.close()
  }
})

test('unconfirmed direct report offers idempotent retry plus local save', async ({ page }) => {
  let uploadCount = 0
  await page.route(REPORT_URL, async (route) => {
    if (isTicketRequest(route)) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(TICKET),
      })
      return
    }
    uploadCount += 1
    if (uploadCount === 1) {
      await route.fulfill({ status: 503, body: 'Unavailable' })
      return
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(RECEIPT),
    })
  })

  const debugPanel = await recordDeterministicMelody(page)
  await debugPanel.getByRole('button', { name: 'Send bug report' }).click()
  await expect(
    debugPanel.getByText('Bug report delivery not confirmed', { exact: true }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(debugPanel.getByRole('button', { name: /Retry sending report/ })).toBeEnabled()
  const save = debugPanel.getByRole('button', { name: 'Save debug package' })
  await expect(save).toBeEnabled()
  expect(uploadCount).toBe(1)

  const downloadPromise = page.waitForEvent('download')
  await save.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('singscope-analysis-debug.zip')
  expect(uploadCount).toBe(1)

  await debugPanel.getByRole('button', { name: /Retry sending report/ }).click()
  await expect(debugPanel.getByText('Bug report sent', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  expect(uploadCount).toBe(2)
  const uploads = await capturedUploads(page)
  expect(uploads).toHaveLength(2)
  const firstUpload = uploads[0]
  const secondUpload = uploads[1]
  if (firstUpload === undefined || secondUpload === undefined) {
    throw new Error('Both report attempts were not captured.')
  }
  expect(createHash('sha256').update(Buffer.from(secondUpload.bytes)).digest('hex')).toBe(
    createHash('sha256').update(Buffer.from(firstUpload.bytes)).digest('hex'),
  )
})
