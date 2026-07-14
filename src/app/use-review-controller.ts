import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  DETECTOR_VERSION,
  METRICS_FORMULA_VERSION,
  metricDisplays,
  reviewScene,
  takeMetrics,
} from './view-models'
import {
  ExportPreparer,
  canSharePreparedPackage,
  createCsv,
  createFeedbackReadme,
  createStaticReport,
  discardPreparedExport,
  materializePreparedExport,
  savePreparedPackage,
  sharePreparedPackage,
  type EncodedAudioExport,
  type PreparedPackage,
  type PreparedExportHandle,
  type ReferenceAudioExport,
  type StaticReportInput,
} from '../export'
import type { ExportView } from '../features/review/ExportPanel'
import { calculateCanvasResolution, renderPitchChart } from '../rendering'
import { getBinaryStore } from './files'
import type { AppProject, AppTake } from './types'

type ExportPhase = ExportView['phase']

interface ExportState {
  phase: ExportPhase
  packageSizeLabel: string | null
  shareSheetEligible: boolean
  includeReference: boolean
  includeWav: boolean
  omissions: readonly string[]
  errorMessage: string | null
  individualFiles?: {
    recording: boolean
    pitchCsv: boolean
    targetCsv: boolean
    chartPng: boolean
    sessionJson: boolean
    reportHtml: boolean
    manifestJson: boolean
    readme: boolean
  }
}

interface IndividualExports {
  recording: Blob
  recordingName: string
  pitchCsv: Blob
  targetCsv: Blob
  chartPng: Blob
  sessionJson: Blob
  reportHtml: Blob
  manifestJson: Blob | null
  readme: Blob
}

type IndividualKind = Exclude<keyof IndividualExports, 'recordingName'>

export interface ReviewController {
  playbackPhase: 'idle' | 'playing' | 'paused'
  currentSeconds: number
  traceDisplay: 'raw' | 'smoothed' | 'both'
  pitchMode: 'pitch' | 'cents'
  zoomLevel: number
  loopPlayback: boolean
  export: ExportState
  play(): void
  pause(): void
  stop(): void
  seek(seconds: number): void
  setTraceDisplay(value: 'raw' | 'smoothed' | 'both'): void
  setPitchMode(value: 'pitch' | 'cents'): void
  zoomIn(): void
  zoomOut(): void
  setLoopPlayback(value: boolean): void
  setIncludeReference(value: boolean): void
  setIncludeWav(value: boolean): void
  prepareExport(): void
  shareExport(): void
  downloadIndividual(kind: IndividualKind): void
}

function extensionFromMime(mimeType: string): EncodedAudioExport['extension'] {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mp4')) return mimeType.includes('video') ? 'mp4' : 'm4a'
  throw new Error('This take has no supported encoded recording. Record a new take in Safari.')
}

function referenceExtension(mimeType: string | null): ReferenceAudioExport['extension'] {
  if (mimeType?.includes('webm')) return 'webm'
  if (mimeType?.includes('wav')) return 'wav'
  if (mimeType?.includes('video/mp4')) return 'mp4'
  return 'm4a'
}

type CsvValue = boolean | number | string | null

function csv(headers: readonly string[], rows: readonly (readonly CsvValue[])[]): Blob {
  return new Blob([createCsv(headers, rows)], { type: 'text/csv;charset=utf-8' })
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

async function createChartPng(project: AppProject, take: AppTake): Promise<Blob> {
  const canvas = document.createElement('canvas')
  const resolution = calculateCanvasResolution(1600, 900, 1)
  canvas.width = resolution.pixelWidth
  canvas.height = resolution.pixelHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas export is unavailable.')
  renderPitchChart(context, reviewScene(project, take, 0), resolution)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Pitch chart could not be encoded.'))),
      'image/png',
    ),
  )
}

async function createWavIfSafe(
  encoded: Blob,
): Promise<{ blob: Blob; estimatedPeakMemoryBytes: number } | null> {
  if (encoded.size > 20 * 1024 * 1024) return null
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await encoded.arrayBuffer())
    const channels = Math.min(2, decoded.numberOfChannels)
    const dataBytes = decoded.length * channels * 2
    const estimatedPeakMemoryBytes =
      encoded.size + decoded.length * decoded.numberOfChannels * 4 + dataBytes * 2
    if (dataBytes + 44 > 32 * 1024 * 1024 || estimatedPeakMemoryBytes >= 96 * 1024 * 1024)
      return null
    const buffer = new ArrayBuffer(44 + dataBytes)
    const view = new DataView(buffer)
    const write = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1)
        view.setUint8(offset + index, value.charCodeAt(index))
    }
    write(0, 'RIFF')
    view.setUint32(4, 36 + dataBytes, true)
    write(8, 'WAVE')
    write(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, channels, true)
    view.setUint32(24, decoded.sampleRate, true)
    view.setUint32(28, decoded.sampleRate * channels * 2, true)
    view.setUint16(32, channels * 2, true)
    view.setUint16(34, 16, true)
    write(36, 'data')
    view.setUint32(40, dataBytes, true)
    let offset = 44
    for (let frame = 0; frame < decoded.length; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, decoded.getChannelData(channel)[frame] ?? 0))
        view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true)
        offset += 2
      }
    }
    return { blob: new Blob([buffer], { type: 'audio/wav' }), estimatedPeakMemoryBytes }
  } catch {
    return null
  } finally {
    await context.close()
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function useReviewController(project: AppProject, take: AppTake): ReviewController {
  const [playbackPhase, setPlaybackPhase] = useState<'idle' | 'playing' | 'paused'>('idle')
  const [currentSeconds, setCurrentSeconds] = useState(0)
  const [traceDisplay, setTraceDisplay] = useState<'raw' | 'smoothed' | 'both'>('both')
  const [pitchMode, setPitchMode] = useState<'pitch' | 'cents'>('pitch')
  const [zoomLevel, setZoomLevel] = useState(1)
  const [loopPlayback, setLoopPlayback] = useState(false)
  const [exportState, setExportState] = useState<ExportState>({
    phase: 'idle',
    packageSizeLabel: null,
    shareSheetEligible: false,
    includeReference: false,
    includeWav: true,
    omissions: [],
    errorMessage: null,
  })
  const audio = useRef<HTMLAudioElement | null>(null)
  const audioUrl = useRef<string | null>(null)
  const playbackOptions = useRef({ loopPlayback, pitchMode, zoomLevel })
  const playbackLoopRange = useRef<{ startSeconds: number; endSeconds: number } | null>(null)
  const prepared = useRef<PreparedPackage | null>(null)
  const preparedHandle = useRef<PreparedExportHandle | null>(null)
  const individual = useRef<IndividualExports | null>(null)

  useEffect(() => {
    playbackOptions.current = { loopPlayback, pitchMode, zoomLevel }
  }, [loopPlayback, pitchMode, zoomLevel])

  useEffect(
    () => () => {
      const handle = preparedHandle.current
      if (handle) void discardPreparedExport(handle)
    },
    [],
  )

  useEffect(() => {
    let active = true
    const isActive = () => active
    void (async () => {
      let blob: Blob | null = null
      if (take.audioAssetId) blob = await (await getBinaryStore()).read(take.audioAssetId)
      if (!blob && project.isSyntheticDemo) {
        blob = await (
          await fetch(
            new URL(`${import.meta.env.BASE_URL}demo-reference.wav`, window.location.origin),
          )
        ).blob()
      }
      if (!blob || !isActive()) return
      const url = URL.createObjectURL(blob)
      audioUrl.current = url
      const element = new Audio(url)
      element.preload = 'metadata'
      element.addEventListener('timeupdate', () => {
        const options = playbackOptions.current
        const loopRange = playbackLoopRange.current
        if (options.loopPlayback && loopRange && element.currentTime >= loopRange.endSeconds) {
          element.currentTime = loopRange.startSeconds
        }
        setCurrentSeconds(element.currentTime)
      })
      element.addEventListener('ended', () => setPlaybackPhase('idle'))
      audio.current = element
    })().catch((error: unknown) => {
      setExportState((current) => ({
        ...current,
        errorMessage: error instanceof Error ? error.message : 'Take audio is unavailable.',
      }))
    })
    return () => {
      active = false
      audio.current?.pause()
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current)
      audio.current = null
    }
  }, [project, take])

  const prepareExport = useCallback(() => {
    setExportState((current) => ({
      ...current,
      phase: 'preparing',
      errorMessage: null,
      omissions: [],
    }))
    void (async () => {
      const previousHandle = preparedHandle.current
      preparedHandle.current = null
      prepared.current = null
      if (previousHandle) await discardPreparedExport(previousHandle)
      if (!take.audioAssetId) throw new Error('This take has no encoded recording to export.')
      const recording = await (await getBinaryStore()).read(take.audioAssetId)
      if (!recording) throw new Error('The encoded recording is missing from local storage.')
      const recordingMimeType =
        recording.type.length > 0 ? recording.type : (take.audioMimeType ?? '')
      const extension = extensionFromMime(recordingMimeType)
      const chartPng = await createChartPng(project, take)
      const report = takeMetrics(project, take)
      const metrics = report.overall
      const session = {
        schemaVersion: 1,
        project: { id: project.id, name: project.title },
        take: {
          id: take.id,
          recordedAt: take.createdAt,
          projectStartSeconds: take.projectStartSeconds,
          projectEndSeconds: take.projectStartSeconds + take.durationSeconds,
          partialReason: take.partialReason,
        },
        target: {
          mode: project.targetMode,
          revision: project.targetRevision,
          confidence: project.targetMode === 'isolated-vocal' ? 'estimated' : 'authoritative',
          alignmentSeconds: project.alignmentSeconds,
          transpositionSemitones: project.transpositionSemitones,
        },
        settings: {
          concertAHz: 440,
          confidenceThreshold: 0.75,
          timingOffsetSeconds: project.timingOffsetSeconds,
          alignmentSeconds: project.alignmentSeconds,
          transpositionSemitones: project.transpositionSemitones,
        },
        tuningHz: 440,
        toleranceCents: 50,
        metrics,
        sectionMetrics: report.sections,
      }
      const pitchRows = take.points.map((point) => [
        point.timeSeconds,
        point.timeSeconds - take.projectStartSeconds,
        point.contextTimeSeconds,
        point.candidateHz,
        point.frequencyHz,
        point.midiNote,
        point.confidence,
        point.rms,
        point.peak,
        point.gapReason,
      ])
      const noteRows = project.notes.map((note) => [
        note.id,
        note.startSeconds,
        note.endSeconds,
        note.midiNote,
        note.startSeconds + project.alignmentSeconds,
        note.endSeconds + project.alignmentSeconds,
        note.midiNote + project.transpositionSemitones,
        note.lyric,
        note.scorable,
      ])
      const sectionRows = report.sections.map((section) => [
        section.sectionName,
        section.startSeconds,
        section.endSeconds,
        section.metrics.within50Cents,
        section.metrics.coverage,
      ])
      const pitchHeaders = [
        'time_seconds',
        'recording_time_seconds',
        'audio_context_seconds',
        'raw_candidate_hz',
        'accepted_frequency_hz',
        'midi_float',
        'confidence',
        'rms',
        'peak',
        'gap_reason',
      ]
      const noteHeaders = [
        'id',
        'source_start_seconds',
        'source_end_seconds',
        'source_midi_note',
        'effective_start_seconds',
        'effective_end_seconds',
        'effective_midi_note',
        'lyric',
        'scorable',
      ]
      const pitchCsv = csv(pitchHeaders, pitchRows)
      const targetCsv = csv(noteHeaders, noteRows)
      const sessionJson = new Blob([`${JSON.stringify(session, null, 2)}\n`], {
        type: 'application/json',
      })

      let wav: { blob: Blob; estimatedPeakMemoryBytes: number } | undefined
      const omissions: string[] = []
      if (exportState.includeWav) {
        wav = (await createWavIfSafe(recording)) ?? undefined
        if (!wav)
          omissions.push(
            'WAV was omitted because decoding or the iPhone memory limit made it unsafe.',
          )
      }

      let reference: ReferenceAudioExport | undefined
      if (exportState.includeReference) {
        let referenceBlob: Blob | null = null
        if (project.isSyntheticDemo) {
          referenceBlob = await (
            await fetch(
              new URL(`${import.meta.env.BASE_URL}demo-reference.wav`, window.location.origin),
            )
          ).blob()
        } else if (project.referenceAssetId) {
          referenceBlob = await (await getBinaryStore()).read(project.referenceAssetId)
        }
        if (referenceBlob)
          reference = {
            blob: referenceBlob,
            extension: referenceExtension(project.referenceMimeType),
          }
      }

      const reportInput: StaticReportInput = {
        title: 'SingScope feedback report',
        projectName: project.title,
        takeLabel: take.label,
        recordedAt: take.createdAt,
        metadata: {
          'Target source': project.targetMode,
          'Target quality': project.targetMode === 'isolated-vocal' ? 'Estimated' : 'Authoritative',
          'Concert pitch': 'A4 = 440 Hz',
          'Scoring tolerance': '±50 cents',
          'Recording MIME': recording.type.length > 0 ? recording.type : take.audioMimeType,
        },
        metrics: Object.fromEntries(
          metricDisplays(metrics).map((item) => [item.label, item.value]),
        ),
        notes: [
          ...omissions,
          take.partialReason
            ? `This is a recoverable partial take: ${take.partialReason}.`
            : 'This take completed normally.',
        ],
      }
      individual.current = {
        recording,
        recordingName: `recording.${extension}`,
        pitchCsv,
        targetCsv,
        chartPng,
        sessionJson,
        reportHtml: new Blob([createStaticReport(reportInput)], {
          type: 'text/html;charset=utf-8',
        }),
        manifestJson: null,
        readme: new Blob([createFeedbackReadme(omissions)], { type: 'text/plain;charset=utf-8' }),
      }
      setExportState((current) => ({
        ...current,
        individualFiles: {
          recording: true,
          pitchCsv: true,
          targetCsv: true,
          chartPng: true,
          sessionJson: true,
          reportHtml: true,
          manifestJson: false,
          readme: true,
        },
      }))

      const preparer = new ExportPreparer()
      try {
        const handle = await preparer.prepareFeedback({
          projectId: project.id,
          takeId: take.id,
          detectorVersion: DETECTOR_VERSION,
          metricsVersion: METRICS_FORMULA_VERSION,
          recording: { blob: recording, extension },
          ...(wav ? { wav } : {}),
          ...(reference ? { reference } : {}),
          includeReferenceAudio: exportState.includeReference,
          referenceRightsConfirmed: exportState.includeReference,
          pitch: { headers: pitchHeaders, rows: pitchRows },
          notes: { headers: noteHeaders, rows: noteRows },
          sections: {
            headers: ['name', 'start_seconds', 'end_seconds', 'within_50', 'coverage'],
            rows: sectionRows,
          },
          summary: session,
          settings: session.settings,
          chartPng,
          report: reportInput,
          readmeNotes: omissions,
        })
        preparedHandle.current = handle
        if (!handle.feedbackManifest) throw new Error('Prepared package is missing its manifest.')
        const currentIndividual = individual.current
        individual.current = {
          ...currentIndividual,
          manifestJson: new Blob([`${JSON.stringify(handle.feedbackManifest, null, 2)}\n`], {
            type: 'application/json',
          }),
        }
        const packageValue = await materializePreparedExport(handle)
        prepared.current = packageValue
        setExportState((current) => {
          const currentFiles = current.individualFiles
          return {
            ...current,
            phase: 'ready',
            packageSizeLabel: formatBytes(packageValue.blob.size),
            shareSheetEligible: canSharePreparedPackage(packageValue),
            omissions,
            ...(currentFiles ? { individualFiles: { ...currentFiles, manifestJson: true } } : {}),
          }
        })
      } finally {
        preparer.terminate()
      }
    })().catch((error: unknown) => {
      setExportState((current) => ({
        ...current,
        phase: 'error',
        errorMessage: error instanceof Error ? error.message : 'Export could not be prepared.',
      }))
    })
  }, [exportState.includeReference, exportState.includeWav, project, take])

  const shareExport = useCallback(() => {
    const value = prepared.current
    if (!value) return
    setExportState((current) => ({ ...current, phase: 'sharing' }))
    void (
      canSharePreparedPackage(value)
        ? sharePreparedPackage(value)
        : Promise.resolve(savePreparedPackage(value))
    )
      .then(async () => {
        const handle = preparedHandle.current
        preparedHandle.current = null
        if (handle) await discardPreparedExport(handle)
        setExportState((current) => ({ ...current, phase: 'complete' }))
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setExportState((current) => ({ ...current, phase: 'ready' }))
          return
        }
        setExportState((current) => ({
          ...current,
          phase: 'error',
          errorMessage: error instanceof Error ? error.message : 'Package could not be shared.',
        }))
      })
  }, [])

  return useMemo(
    () => ({
      playbackPhase,
      currentSeconds,
      traceDisplay,
      pitchMode,
      zoomLevel,
      loopPlayback,
      export: exportState,
      play() {
        const range = playbackLoopRange.current
        if (
          audio.current &&
          loopPlayback &&
          range &&
          (audio.current.currentTime < range.startSeconds ||
            audio.current.currentTime >= range.endSeconds)
        ) {
          audio.current.currentTime = range.startSeconds
          setCurrentSeconds(range.startSeconds)
        }
        const promise = audio.current?.play()
        if (promise)
          void promise
            .then(() => setPlaybackPhase('playing'))
            .catch(() => setPlaybackPhase('paused'))
      },
      pause() {
        audio.current?.pause()
        setPlaybackPhase('paused')
      },
      stop() {
        audio.current?.pause()
        if (audio.current) audio.current.currentTime = 0
        setCurrentSeconds(0)
        setPlaybackPhase('idle')
      },
      seek(seconds: number) {
        if (audio.current) audio.current.currentTime = seconds
        setCurrentSeconds(seconds)
      },
      setTraceDisplay,
      setPitchMode,
      zoomIn: () =>
        setZoomLevel((value) => {
          const next = Math.min(8, value * 1.5)
          if (loopPlayback) {
            playbackLoopRange.current = reviewScene(
              project,
              take,
              currentSeconds,
              pitchMode,
              next,
            ).viewport
          }
          return next
        }),
      zoomOut: () =>
        setZoomLevel((value) => {
          const next = Math.max(1, value / 1.5)
          if (loopPlayback) {
            playbackLoopRange.current = reviewScene(
              project,
              take,
              currentSeconds,
              pitchMode,
              next,
            ).viewport
          }
          return next
        }),
      setLoopPlayback(value: boolean) {
        playbackLoopRange.current = value
          ? reviewScene(project, take, currentSeconds, pitchMode, zoomLevel).viewport
          : null
        setLoopPlayback(value)
      },
      setIncludeReference: (includeReference: boolean) =>
        setExportState((current) => ({ ...current, includeReference, phase: 'idle' })),
      setIncludeWav: (includeWav: boolean) =>
        setExportState((current) => ({ ...current, includeWav, phase: 'idle' })),
      prepareExport,
      shareExport,
      downloadIndividual(kind: IndividualKind) {
        const files = individual.current
        if (!files) return
        if (kind === 'recording') download(files.recording, files.recordingName)
        if (kind === 'pitchCsv') download(files.pitchCsv, 'pitch-data.csv')
        if (kind === 'targetCsv') download(files.targetCsv, 'target-notes.csv')
        if (kind === 'chartPng') download(files.chartPng, 'pitch-chart.png')
        if (kind === 'sessionJson') download(files.sessionJson, 'session.json')
        if (kind === 'reportHtml') download(files.reportHtml, 'report.html')
        if (kind === 'manifestJson' && files.manifestJson)
          download(files.manifestJson, 'manifest.json')
        if (kind === 'readme') download(files.readme, 'README.txt')
      },
    }),
    [
      currentSeconds,
      exportState,
      loopPlayback,
      pitchMode,
      playbackPhase,
      prepareExport,
      project,
      shareExport,
      take,
      traceDisplay,
      zoomLevel,
    ],
  )
}
