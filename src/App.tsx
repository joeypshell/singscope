import { useCallback, useEffect, useRef, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router'

import {
  analyzeMonophonicAudioBuffer,
  createAnalyzedTargetDraftInput,
  decideMonophonicAnalysisStrategy,
  DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS,
  YinPitchDetector,
  type CandidateSegmentationOptions,
  type MonophonicAnalysisResult,
  type PitchDetectorConfig,
} from './audio/dsp'
import {
  RecordedSourceCapture,
  type CaptureSettings,
  type RecordingInterruption,
  type RecordedSourceResult,
  type RecordedSourceSnapshot,
} from './audio/runtime'
import { centsBetweenMidi, findOverlappingNoteIds } from './domain'
import {
  DashboardScreen,
  OnboardingScreen,
  PracticeScreen,
  ProjectSetupScreen,
  ReviewScreen,
  type MidiTrackView,
  type PracticeLoopView,
  type TargetMode,
} from './features'
import { StatusBanner } from './components/StatusBanner'
import type { EditableTargetNote } from './components/TargetNoteEditor'
import { parseMidiFile, type ParsedMidi } from './midi/midi'
import {
  getDatabase,
  finalizeRecoveredRecording,
  probeStorage,
  recoverBinaryState,
  requestPersistentStorageAfterExplicitSave,
} from './persistence'
import { createDemoProject } from './app/demo'
import {
  audioDurationSeconds,
  getBinaryStore,
  importProjectBackup,
  saveProjectBackup,
  storeBinary,
  validateAudioFile,
} from './app/files'
import { appProjectSchema } from './app/project-schema'
import { useAppStore } from './app/store'
import type {
  AnalysisDebugRouteCategory,
  AnalysisDebugView,
  AppProject,
  AppTargetNote,
  AppTargetPitchPoint,
} from './app/types'
import { currentPitchLabel, usePracticeController } from './app/use-practice-controller'
import { useReviewController } from './app/use-review-controller'
import {
  inspectedPoint,
  metricDisplays,
  projectScene,
  reviewScene,
  takeMetrics,
  targetAnalysisScene,
} from './app/view-models'
import {
  debugAudioExtensionForMimeType,
  discardPreparedExport,
  ExportPreparer,
  materializePreparedExport,
  pruneExportScratch,
  savePreparedPackage,
  type AnalysisDebugPackageInput,
  type AnalysisDebugDisplayMode,
  type PreparedExportHandle,
  type PreparedPackage,
} from './export'
import { analysisReportConfigurationFromEnv, sendAnalysisReport } from './report'

const ONBOARDING_KEY = 'singscope:onboarding:v1'
const ANALYSIS_REPORT_TIMEOUT_MS = 120_000
const ANALYSIS_REPORT_CONFIGURATION = analysisReportConfigurationFromEnv({
  VITE_SINGSCOPE_REPORT_ENDPOINT: import.meta.env.VITE_SINGSCOPE_REPORT_ENDPOINT,
  VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY: import.meta.env.VITE_SINGSCOPE_REPORT_PUBLISHABLE_KEY,
})

function installedDisplayMode(): boolean {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean }
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    standaloneNavigator.standalone === true
  )
}

function analysisDebugDisplayMode(): AnalysisDebugDisplayMode {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean }
  if (
    window.matchMedia('(display-mode: standalone)').matches ||
    standaloneNavigator.standalone === true
  ) {
    return 'standalone'
  }
  if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen'
  if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'minimal-ui'
  return 'browser'
}

function packageSizeLabel(byteLength: number): string {
  const mebibytes = byteLength / (1024 * 1024)
  if (mebibytes >= 1) return `${mebibytes.toFixed(1)} MiB`
  return `${Math.max(1, Math.ceil(byteLength / 1024)).toString()} KiB`
}

function asMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'QuotaExceededError'
  ) {
    return 'Local storage is full. No new data was committed. Delete an unneeded project, save a backup, or free iPhone storage, then try again.'
  }
  return error instanceof Error ? error.message : 'Something went wrong. Try again.'
}

function binaryAssetIds(project: AppProject): ReadonlySet<string> {
  return new Set(
    [
      project.referenceAssetId,
      project.targetSourceAssetId,
      ...project.takes.map((take) => take.audioAssetId),
    ].filter((id): id is string => id !== null),
  )
}

function unsharedBinaryAssetIds(
  project: AppProject,
  projects: readonly AppProject[],
): readonly string[] {
  const usedElsewhere = new Set(
    projects
      .filter((candidate) => candidate.id !== project.id)
      .flatMap((candidate) => [...binaryAssetIds(candidate)]),
  )
  return [...binaryAssetIds(project)].filter((id) => !usedElsewhere.has(id))
}

async function deleteBinaryAssets(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0
  const binaryStore = await getBinaryStore()
  const database = getDatabase()
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const operations = await Promise.allSettled([
        binaryStore.delete(id),
        database.assets.delete(id),
        database.commitStates.delete(id),
        database.journals.delete(id),
      ])
      const failure = operations.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }),
  )
  return results.filter((result) => result.status === 'rejected').length
}

function AppStatus() {
  const message = useAppStore((state) => state.message)
  const setMessage = useAppStore((state) => state.setMessage)
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => {
    const onUpdate = () => setUpdateReady(true)
    window.addEventListener('singscope:update-ready', onUpdate)
    return () => window.removeEventListener('singscope:update-ready', onUpdate)
  }, [])
  if (!message && !updateReady) return null
  return (
    <aside className="ss-global-status" aria-live="polite">
      <StatusBanner
        tone={message ? 'warning' : 'info'}
        title={message ? 'SingScope needs attention' : 'An update is ready'}
        message={message ?? 'Install the verified update when you are not recording.'}
        actionLabel={updateReady ? 'Update now' : 'Dismiss'}
        onAction={() => {
          if (updateReady) window.dispatchEvent(new CustomEvent('singscope:apply-update'))
          else setMessage(null)
        }}
      />
    </aside>
  )
}

function DashboardRoute() {
  const navigate = useNavigate()
  const projects = useAppStore((state) => state.projects)
  const storageState = useAppStore((state) => state.storageState)
  const putProject = useAppStore((state) => state.putProject)
  const deleteProject = useAppStore((state) => state.deleteProject)
  const markBackedUp = useAppStore((state) => state.markBackedUp)
  const setMessage = useAppStore((state) => state.setMessage)
  const [onboarded, setOnboarded] = useState(
    () => localStorage.getItem(ONBOARDING_KEY) === 'complete',
  )

  const importBackup = useCallback(
    (file: File) => {
      void importProjectBackup(file)
        .then(async (project) => {
          await putProject(project)
          setOnboarded(true)
          localStorage.setItem(ONBOARDING_KEY, 'complete')
          void navigate(`/practice/${project.id}`)
        })
        .catch((error: unknown) => setMessage(asMessage(error)))
    },
    [navigate, putProject, setMessage],
  )

  if (!onboarded) {
    return (
      <OnboardingScreen
        installed={installedDisplayMode()}
        storageProbe={storageState}
        onContinue={() => {
          localStorage.setItem(ONBOARDING_KEY, 'complete')
          setOnboarded(true)
        }}
        onImportBackup={importBackup}
      />
    )
  }

  return (
    <DashboardScreen
      projects={projects.map((project) => ({
        id: project.id,
        title: project.title,
        updatedLabel: `Updated ${new Date(project.updatedAt).toLocaleDateString()}`,
        takeCount: project.takes.length,
        backupState:
          project.lastBackupAt === null
            ? 'never'
            : Date.parse(project.lastBackupAt) >= Date.parse(project.updatedAt)
              ? 'current'
              : 'due',
      }))}
      storageMessage={
        storageState === 'ready'
          ? 'IndexedDB and OPFS probes passed. Back up after every important take.'
          : storageState === 'limited'
            ? 'OPFS is unavailable; bounded IndexedDB binary storage passed its probe and will be used as a fallback.'
            : storageState === 'checking'
              ? 'Checking IndexedDB and OPFS…'
              : 'Recording is unavailable until local storage recovers.'
      }
      installed={installedDisplayMode()}
      onCreateProject={() => navigate('/setup/new')}
      onOpenDemo={() => {
        const demo = createDemoProject()
        void putProject(demo)
          .then(() => navigate(`/practice/${demo.id}`))
          .catch((error: unknown) => setMessage(asMessage(error)))
      }}
      onOpenProject={(id) => navigate(`/practice/${id}`)}
      onImportBackup={importBackup}
      onExportBackup={(id) => {
        const project = projects.find((candidate) => candidate.id === id)
        if (!project) return
        void saveProjectBackup(project)
          .then(() => markBackedUp(id))
          .catch((error: unknown) => setMessage(asMessage(error)))
      }}
      onDeleteProject={(id) => {
        const project = projects.find((candidate) => candidate.id === id)
        if (
          !project ||
          !window.confirm(
            `Delete “${project.title}”, its recordings, and its imported audio? This cannot be undone.`,
          )
        ) {
          return
        }
        const assetIds = unsharedBinaryAssetIds(project, projects)
        void (async () => {
          await deleteProject(id)
          const failedDeletes = await deleteBinaryAssets(assetIds)
          if (failedDeletes > 0) {
            setMessage(
              `The project was deleted, but ${failedDeletes} local binary asset${failedDeletes === 1 ? '' : 's'} could not be removed. Safari may reclaim the orphaned storage later.`,
            )
          }
        })().catch((error: unknown) => setMessage(asMessage(error)))
      }}
    />
  )
}

interface SetupState {
  readonly id: string
  readonly createdAt: string
  readonly title: string
  readonly referenceName: string | null
  readonly referenceMimeType: string | null
  readonly referenceAssetId: string | null
  readonly referenceDurationSeconds: number
  readonly referenceFile: File | null
  readonly targetMode: TargetMode
  readonly targetStatus: string
  readonly targetSourceAssetId: string | null
  readonly targetSourceName: string | null
  readonly targetSourceMimeType: string | null
  readonly targetSourceDurationSeconds: number
  readonly targetSourceFile: File | null
  readonly targetPitchPoints: readonly AppTargetPitchPoint[]
  readonly notes: readonly AppTargetNote[]
  readonly transpositionSemitones: number
  readonly alignmentSeconds: number
  readonly midi: ParsedMidi | null
  readonly midiTracks: readonly MidiTrackView[]
  readonly selectedMidiTrackId: string | null
  readonly targetRevision: number
  readonly analysisDebugDraft: AnalysisDebugDraft | null
  readonly existing: AppProject | null
  readonly busy: boolean
  readonly error: string | null
}

interface AnalysisDebugDraft {
  readonly analysis: MonophonicAnalysisResult
  readonly detectorConfig: PitchDetectorConfig
  readonly segmentationConfig: CandidateSegmentationOptions
  readonly decodedDurationSeconds: number | null
  readonly decodedSampleRateHz: number | null
  readonly decodedChannelCount: number | null
  readonly recorderDurationSeconds: number | null
  readonly captureSettings: CaptureSettings | null
  readonly partialReason: RecordingInterruption | null
  readonly failureDescription: string | null
}

interface PreparedAnalysisDebug {
  readonly handle: PreparedExportHandle
  readonly packageValue: PreparedPackage
}

const INITIAL_ANALYSIS_DEBUG: AnalysisDebugView = {
  context: 'analysis-result',
  phase: 'idle',
  reportingAvailable: ANALYSIS_REPORT_CONFIGURATION !== null,
  canSavePackage: false,
  packageSizeLabel: null,
  errorMessage: null,
  reportId: null,
  receivedAt: null,
  expectedNoteCount: null,
  issueDescription: '',
  routeCategory: 'unknown',
}

function inferredTargetSourceDuration(project: AppProject): number {
  return Math.max(
    0,
    ...project.targetPitchPoints.map((point) => point.timeSeconds + 0.032),
    ...project.notes.map((note) => note.endSeconds),
  )
}

function initialSetup(project: AppProject | null): SetupState {
  const now = new Date().toISOString()
  return {
    id: project?.id ?? crypto.randomUUID(),
    createdAt: project?.createdAt ?? now,
    title: project?.title ?? '',
    referenceName: project?.referenceName ?? null,
    referenceMimeType: project?.referenceMimeType ?? null,
    referenceAssetId: project?.referenceAssetId ?? null,
    referenceDurationSeconds: project?.referenceDurationSeconds ?? 0,
    referenceFile: null,
    targetMode: project?.targetMode ?? 'midi',
    targetStatus: project?.targetStatus ?? 'Choose a target source.',
    targetSourceAssetId: project?.targetSourceAssetId ?? null,
    targetSourceName: project?.targetSourceName ?? null,
    targetSourceMimeType: project?.targetSourceMimeType ?? null,
    targetSourceDurationSeconds:
      project !== null &&
      project.targetSourceAssetId !== null &&
      project.targetSourceAssetId === project.referenceAssetId
        ? project.referenceDurationSeconds
        : project
          ? inferredTargetSourceDuration(project)
          : 0,
    targetSourceFile: null,
    targetPitchPoints: project?.targetPitchPoints ?? [],
    notes: project?.notes ?? [],
    transpositionSemitones: project?.transpositionSemitones ?? 0,
    alignmentSeconds: project?.alignmentSeconds ?? 0,
    midi: null,
    midiTracks: [],
    selectedMidiTrackId: null,
    targetRevision: project?.targetRevision ?? 0,
    // Persisted analyses intentionally do not recreate a debug draft: the exact
    // raw result and source bytes must both still be present in this setup route.
    analysisDebugDraft: null,
    existing: project,
    busy: false,
    error: null,
  }
}

function notesForTrack(parsed: ParsedMidi, trackId: string): readonly AppTargetNote[] {
  const track = Number(trackId)
  return (parsed.notesByTrack.get(track) ?? []).map((note) => ({
    id: crypto.randomUUID(),
    startSeconds: note.startSeconds,
    endSeconds: note.endSeconds,
    midiNote: note.midiNote,
    lyric: note.label ?? '',
    scorable: !note.overlapsAnotherNote,
  }))
}

function normalizedScoring(notes: readonly AppTargetNote[]): readonly AppTargetNote[] {
  const overlaps = findOverlappingNoteIds(
    notes.map((note) => ({ ...note, lyric: note.lyric || null, sourceTrack: null })),
  )
  return notes.map((note) => ({ ...note, scorable: !overlaps.has(note.id) }))
}

interface AnalyzedSource {
  readonly durationSeconds: number
  readonly sourceAssetId: string
  readonly targetRevision: number
  readonly notes: readonly AppTargetNote[]
  readonly pitchPoints: readonly AppTargetPitchPoint[]
  readonly analysis: MonophonicAnalysisResult
  readonly detectorConfig: PitchDetectorConfig
  readonly segmentationConfig: CandidateSegmentationOptions
  readonly decodedSampleRateHz: number
  readonly decodedChannelCount: number
}

class SourceAudioDecodeError extends Error {
  readonly decoderDetail: string

  constructor(cause: unknown) {
    super('This browser could not decode this audio for pitch analysis.', { cause })
    this.name = 'SourceAudioDecodeError'
    this.decoderDetail = asMessage(cause)
  }
}

function createMonophonicAnalysisConfiguration() {
  const detector = new YinPitchDetector()
  const segmentationConfig: CandidateSegmentationOptions = Object.freeze({
    ...DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS,
    confidenceThreshold: detector.config.confidenceThreshold,
    analysisHopSeconds: detector.config.hopDurationSeconds,
    analysisFrameSeconds: detector.config.frameDurationSeconds,
  })
  return { detector, segmentationConfig }
}

function decodeFailureDebugDraft(
  result: Pick<RecordedSourceResult, 'durationSeconds' | 'settings' | 'partialReason'>,
  decoderDetail: string,
): AnalysisDebugDraft {
  const { detector, segmentationConfig } = createMonophonicAnalysisConfiguration()
  return {
    analysis: {
      detectorVersion: detector.version,
      durationSeconds: Math.max(0, Math.min(60, result.durationSeconds)),
      contour: [],
      candidateNotes: [],
    },
    detectorConfig: detector.config,
    segmentationConfig,
    decodedDurationSeconds: null,
    decodedSampleRateHz: null,
    decodedChannelCount: null,
    recorderDurationSeconds: result.durationSeconds,
    captureSettings: result.settings,
    partialReason: result.partialReason,
    failureDescription: `Recording decode failed before pitch analysis: ${decoderDetail}`.slice(
      0,
      300,
    ),
  }
}

async function analyzeMonophonicSourceFile(
  file: File,
  existing: AppProject | null,
): Promise<AnalyzedSource> {
  const durationSeconds = await validateAudioFile(file, 'isolated')
  const provisional = decideMonophonicAnalysisStrategy({
    encodedByteLength: file.size,
    durationSeconds,
    sampleRateHz: 48_000,
    channelCount: 1,
  })
  if (provisional.strategy !== 'offline-buffer') {
    throw new Error(
      'This accepted source needs the cancellable foreground media pass. Keep the source shorter or mono for this setup screen.',
    )
  }

  const context = new AudioContext()
  try {
    let buffer: AudioBuffer
    try {
      buffer = await context.decodeAudioData(await file.arrayBuffer())
    } catch (error) {
      throw new SourceAudioDecodeError(error)
    }
    const admission = decideMonophonicAnalysisStrategy({
      encodedByteLength: file.size,
      durationSeconds: buffer.duration,
      sampleRateHz: buffer.sampleRate,
      channelCount: buffer.numberOfChannels,
    })
    if (admission.strategy !== 'offline-buffer') {
      throw new Error(
        'Decoded audio exceeds the whole-file memory budget; use a shorter monophonic source.',
      )
    }
    const { detector, segmentationConfig } = createMonophonicAnalysisConfiguration()
    const analysis = await analyzeMonophonicAudioBuffer(buffer, {
      admission,
      detector,
      segmentation: segmentationConfig,
    })
    const sourceAssetId = crypto.randomUUID()
    const draft = createAnalyzedTargetDraftInput(analysis, {
      sourceAssetId,
      previousRevision: existing
        ? {
            id: existing.id,
            revision: existing.targetRevision,
            alignmentSeconds: existing.alignmentSeconds,
            transposeSemitones: existing.transpositionSemitones,
          }
        : null,
    })
    if (draft.notes.length === 0) {
      throw new Error(
        'No stable notes were detected. Try again in a quieter place, hold each note longer, and leave a short gap between notes.',
      )
    }
    return {
      durationSeconds: buffer.duration,
      sourceAssetId,
      targetRevision: draft.revision - 1,
      notes: draft.notes.map((note) => ({
        id: crypto.randomUUID(),
        startSeconds: note.startSeconds,
        endSeconds: note.endSeconds,
        midiNote: note.midiNote,
        lyric: '',
        scorable: note.scorable,
      })),
      // Editable notes come from accepted segmentation, while pitchPoints retain
      // every raw detector candidate and normalized analysis-gap reason.
      pitchPoints: draft.pitchPoints,
      analysis,
      detectorConfig: detector.config,
      segmentationConfig,
      decodedSampleRateHz: buffer.sampleRate,
      decodedChannelCount: buffer.numberOfChannels,
    }
  } finally {
    await context.close()
  }
}

interface RecordedMelodyState {
  readonly phase: 'idle' | 'requesting' | 'recording' | 'finalizing' | 'analyzing' | 'error'
  readonly elapsedSeconds: number
  readonly captureSettings: CaptureSettings | null
  readonly errorMessage: string | null
  readonly hasRecordedSource: boolean
}

const INITIAL_RECORDED_MELODY: RecordedMelodyState = {
  phase: 'idle',
  elapsedSeconds: 0,
  captureSettings: null,
  errorMessage: null,
  hasRecordedSource: false,
}

function captureFailureMessage(error: unknown): string {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  ) {
    return 'Allow microphone access for SingScope in Safari settings, then try again.'
  }
  return asMessage(error)
}

function recordedFileName(mimeType: string): string {
  const extension = mimeType.includes('mp4')
    ? 'm4a'
    : mimeType.includes('webm')
      ? 'webm'
      : mimeType.includes('wav')
        ? 'wav'
        : 'audio'
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  return `recorded-melody-${timestamp}.${extension}`
}

function recordedViewPhase(snapshot: RecordedSourceSnapshot): RecordedMelodyState['phase'] {
  switch (snapshot.phase) {
    case 'idle':
    case 'discarded':
      return 'idle'
    case 'requesting':
      return 'requesting'
    case 'recording':
      return 'recording'
    case 'finalizing':
    case 'complete':
      return 'finalizing'
    case 'error':
      return 'error'
  }
}

function setupValidation(state: SetupState): string | null {
  if (!state.title.trim()) return 'Enter a project title.'
  if (!state.referenceName || state.referenceDurationSeconds <= 0)
    return 'Choose a valid backing audio file, or use the melody audio as the reference.'
  if (
    state.targetMode === 'isolated-vocal' &&
    !state.targetSourceAssetId &&
    !state.targetSourceFile
  ) {
    return 'Upload or record a monophonic melody before saving this target.'
  }
  if (state.notes.length === 0) return 'Add or import at least one target note.'
  if (
    state.notes.some(
      (note) => !Number.isInteger(note.midiNote) || note.midiNote < 0 || note.midiNote > 127,
    )
  )
    return 'MIDI notes must be whole numbers from 0 to 127.'
  if (
    state.notes.some(
      (note) =>
        !Number.isFinite(note.startSeconds) ||
        note.startSeconds < 0 ||
        note.endSeconds <= note.startSeconds,
    )
  )
    return 'Every target note needs a finite start and a later end.'
  if (
    state.notes.some(
      (note) =>
        note.midiNote + state.transpositionSemitones < 0 ||
        note.midiNote + state.transpositionSemitones > 127,
    )
  ) {
    return 'Transpose moves at least one target outside the supported MIDI piano range (0–127).'
  }
  return null
}

function SetupRoute() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const projects = useAppStore((store) => store.projects)
  const putProject = useAppStore((store) => store.putProject)
  const setMessage = useAppStore((store) => store.setMessage)
  const existing =
    projectId && projectId !== 'new'
      ? (projects.find((project) => project.id === projectId) ?? null)
      : null
  const [state, setState] = useState(() => initialSetup(existing))
  const [useRecordedSourceAsReference, setUseRecordedSourceAsReference] = useState(
    () =>
      existing === null ||
      (existing.targetSourceAssetId !== null &&
        existing.targetSourceAssetId === existing.referenceAssetId),
  )
  const [recordedMelody, setRecordedMelody] = useState<RecordedMelodyState>(INITIAL_RECORDED_MELODY)
  const stateRef = useRef(state)
  const useRecordedSourceAsReferenceRef = useRef(useRecordedSourceAsReference)
  const recordedCaptureRef = useRef<RecordedSourceCapture | null>(null)
  const recordedCaptureUnsubscribeRef = useRef<(() => void) | null>(null)
  const recordedCaptureGenerationRef = useRef(0)
  const [analysisSourceUrl, setAnalysisSourceUrl] = useState<string | null>(null)
  const [analysisDebug, setAnalysisDebug] = useState<AnalysisDebugView>(INITIAL_ANALYSIS_DEBUG)
  const analysisDebugSourceRef = useRef<File | null>(null)
  const preparedAnalysisDebugRef = useRef<PreparedAnalysisDebug | null>(null)
  const analysisDebugPreparerRef = useRef<ExportPreparer | null>(null)
  const analysisDebugUploadAbortRef = useRef<AbortController | null>(null)
  const analysisDebugGenerationRef = useRef(0)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  useEffect(() => {
    useRecordedSourceAsReferenceRef.current = useRecordedSourceAsReference
  }, [useRecordedSourceAsReference])
  useEffect(() => {
    const controller = new AbortController()
    const isAborted = () => controller.signal.aborted
    let objectUrl: string | null = null
    void (async () => {
      await Promise.resolve()
      if (isAborted()) return
      setAnalysisSourceUrl(null)
      const source =
        state.targetSourceFile ??
        (state.targetSourceAssetId
          ? await (await getBinaryStore()).read(state.targetSourceAssetId)
          : null)
      if (!source || isAborted()) return
      objectUrl = URL.createObjectURL(source)
      setAnalysisSourceUrl(objectUrl)
    })().catch(() => {
      if (!isAborted()) setAnalysisSourceUrl(null)
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [state.targetSourceAssetId, state.targetSourceFile])
  const patch = (value: Partial<SetupState>) => setState((current) => ({ ...current, ...value }))
  const validation = setupValidation(state)

  const releasePreparedAnalysisDebug = useCallback(() => {
    analysisDebugGenerationRef.current += 1
    analysisDebugUploadAbortRef.current?.abort()
    analysisDebugUploadAbortRef.current = null
    analysisDebugPreparerRef.current?.terminate()
    analysisDebugPreparerRef.current = null
    const prepared = preparedAnalysisDebugRef.current
    preparedAnalysisDebugRef.current = null
    if (prepared) void discardPreparedExport(prepared.handle).catch(() => undefined)
  }, [])

  const invalidateAnalysisDebug = useCallback(() => {
    releasePreparedAnalysisDebug()
    analysisDebugSourceRef.current = null
    setAnalysisDebug((current) => ({
      ...INITIAL_ANALYSIS_DEBUG,
      expectedNoteCount: current.expectedNoteCount,
      issueDescription: current.issueDescription,
      routeCategory: current.routeCategory,
    }))
  }, [releasePreparedAnalysisDebug])

  const applyAnalyzedSource = useCallback(
    async (
      file: File,
      origin: 'upload' | 'recording',
      partialReason: RecordedSourceResult['partialReason'] = null,
      captureMetadata: Pick<RecordedSourceResult, 'durationSeconds' | 'settings'> | null = null,
    ) => {
      const analyzed = await analyzeMonophonicSourceFile(file, stateRef.current.existing)
      invalidateAnalysisDebug()
      analysisDebugSourceRef.current = file
      const useAsReference = useRecordedSourceAsReferenceRef.current
      const sourceDescription = origin === 'recording' ? 'from your recording' : 'in a new draft'
      const interruptionMessage = partialReason
        ? ' The recording was interrupted and did not resume automatically; review this recovered partial draft carefully.'
        : ''
      setState((current) => ({
        ...current,
        busy: false,
        error: null,
        targetMode: 'isolated-vocal',
        targetSourceAssetId: analyzed.sourceAssetId,
        targetSourceName: file.name.slice(0, 255),
        targetSourceMimeType: file.type || 'application/octet-stream',
        targetSourceDurationSeconds: analyzed.durationSeconds,
        targetSourceFile: file,
        targetRevision: analyzed.targetRevision,
        notes: analyzed.notes,
        targetPitchPoints: analyzed.pitchPoints,
        analysisDebugDraft: {
          analysis: analyzed.analysis,
          detectorConfig: analyzed.detectorConfig,
          segmentationConfig: analyzed.segmentationConfig,
          decodedDurationSeconds: analyzed.durationSeconds,
          decodedSampleRateHz: analyzed.decodedSampleRateHz,
          decodedChannelCount: analyzed.decodedChannelCount,
          recorderDurationSeconds: captureMetadata?.durationSeconds ?? null,
          captureSettings: captureMetadata?.settings ?? null,
          partialReason,
          failureDescription: null,
        },
        targetStatus: `${analyzed.notes.length} estimated notes ${sourceDescription}. Review the piano note names, timing, and MIDI values before saving.${interruptionMessage}`,
        ...(useAsReference
          ? {
              referenceAssetId: analyzed.sourceAssetId,
              referenceName: file.name.slice(0, 255),
              referenceMimeType: file.type || 'application/octet-stream',
              referenceDurationSeconds: analyzed.durationSeconds,
              referenceFile: file,
            }
          : {}),
      }))
      return analyzed
    },
    [invalidateAnalysisDebug],
  )

  const releaseRecordedCapture = useCallback((capture: RecordedSourceCapture) => {
    if (recordedCaptureRef.current !== capture) return
    recordedCaptureUnsubscribeRef.current?.()
    recordedCaptureUnsubscribeRef.current = null
    recordedCaptureRef.current = null
  }, [])

  const startRecordedMelody = useCallback(() => {
    const current = stateRef.current
    if (
      current.notes.length > 0 &&
      !window.confirm(
        'Record a new analyzed draft? Existing notes remain unchanged unless the new recording is analyzed successfully and you save it.',
      )
    ) {
      return
    }
    if (recordedCaptureRef.current) return
    invalidateAnalysisDebug()

    const generation = ++recordedCaptureGenerationRef.current
    const capture = new RecordedSourceCapture()
    recordedCaptureRef.current = capture
    setRecordedMelody({
      phase: 'requesting',
      elapsedSeconds: 0,
      captureSettings: null,
      errorMessage: null,
      hasRecordedSource: recordedMelody.hasRecordedSource,
    })
    setState((value) => ({
      ...value,
      busy: true,
      error: null,
      analysisDebugDraft: null,
      targetStatus: 'Requesting microphone access on this device…',
    }))

    recordedCaptureUnsubscribeRef.current = capture.subscribe((snapshot) => {
      if (
        generation !== recordedCaptureGenerationRef.current ||
        recordedCaptureRef.current !== capture
      ) {
        return
      }
      const phase = recordedViewPhase(snapshot)
      setRecordedMelody((value) => ({
        ...value,
        phase,
        elapsedSeconds: snapshot.durationSeconds,
        captureSettings: snapshot.settings,
        errorMessage: snapshot.error,
      }))
      if (phase === 'recording') {
        setState((value) => ({
          ...value,
          targetStatus: 'Recording melody locally. Sing, hum, whistle, or play one note at a time.',
        }))
      }
    })

    void capture.result
      .then(async (result) => {
        if (generation !== recordedCaptureGenerationRef.current) return
        releaseRecordedCapture(capture)
        setRecordedMelody((value) => ({
          ...value,
          phase: 'analyzing',
          elapsedSeconds: result.durationSeconds,
          captureSettings: result.settings,
          errorMessage: null,
        }))
        setState((value) => ({
          ...value,
          busy: true,
          targetStatus: 'Analyzing recording on this device…',
        }))
        const file = new File([result.blob], recordedFileName(result.mimeType), {
          type: result.mimeType,
          lastModified: Date.now(),
        })
        try {
          await applyAnalyzedSource(file, 'recording', result.partialReason, {
            durationSeconds: result.durationSeconds,
            settings: result.settings,
          })
          if (generation !== recordedCaptureGenerationRef.current) return
          setRecordedMelody((value) => ({
            ...value,
            phase: 'idle',
            hasRecordedSource: true,
          }))
        } catch (error) {
          if (generation !== recordedCaptureGenerationRef.current) return
          const decodeFailure = error instanceof SourceAudioDecodeError ? error : null
          const message = decodeFailure
            ? `${decodeFailure.message} You can report the failed recording below or record again.`
            : captureFailureMessage(error)
          const decodeFailureDraft = decodeFailure
            ? decodeFailureDebugDraft(result, decodeFailure.decoderDetail)
            : null
          if (decodeFailureDraft) {
            releasePreparedAnalysisDebug()
            analysisDebugSourceRef.current = file
            setAnalysisDebug((current) => ({
              ...INITIAL_ANALYSIS_DEBUG,
              context: 'decode-failure',
              expectedNoteCount: current.expectedNoteCount,
              issueDescription: decodeFailureDraft.failureDescription ?? '',
              routeCategory: current.routeCategory,
            }))
          }
          setRecordedMelody((value) => ({
            ...value,
            phase: 'error',
            errorMessage: message,
          }))
          setState((value) => ({
            ...value,
            busy: false,
            error: message,
            ...(decodeFailureDraft ? { analysisDebugDraft: decodeFailureDraft } : {}),
            targetStatus: 'Analysis stopped without changing the current target notes.',
          }))
        }
      })
      .catch((error: unknown) => {
        if (
          generation !== recordedCaptureGenerationRef.current ||
          recordedCaptureRef.current !== capture
        ) {
          return
        }
        releaseRecordedCapture(capture)
        const message = captureFailureMessage(error)
        setRecordedMelody((value) => ({
          ...value,
          phase: 'error',
          errorMessage: message,
        }))
        setState((value) => ({
          ...value,
          busy: false,
          error: message,
          targetStatus: 'Recording stopped without changing the current target notes.',
        }))
      })

    void capture.start().catch((error: unknown) => {
      if (
        generation !== recordedCaptureGenerationRef.current ||
        recordedCaptureRef.current !== capture
      ) {
        return
      }
      releaseRecordedCapture(capture)
      const message = captureFailureMessage(error)
      setRecordedMelody((value) => ({
        ...value,
        phase: 'error',
        errorMessage: message,
      }))
      setState((value) => ({
        ...value,
        busy: false,
        error: message,
        targetStatus: 'Microphone recording did not start.',
      }))
    })
  }, [
    applyAnalyzedSource,
    invalidateAnalysisDebug,
    recordedMelody.hasRecordedSource,
    releasePreparedAnalysisDebug,
    releaseRecordedCapture,
  ])

  useEffect(
    () => () => {
      recordedCaptureGenerationRef.current += 1
      recordedCaptureUnsubscribeRef.current?.()
      recordedCaptureUnsubscribeRef.current = null
      const capture = recordedCaptureRef.current
      recordedCaptureRef.current = null
      if (capture) void capture.discard().catch(() => undefined)
    },
    [],
  )

  useEffect(
    () => () => {
      releasePreparedAnalysisDebug()
    },
    [releasePreparedAnalysisDebug],
  )

  const uploadPreparedAnalysisDebug = useCallback(
    (prepared: PreparedAnalysisDebug, generation: number) => {
      const configuration = ANALYSIS_REPORT_CONFIGURATION
      const manifest = prepared.handle.analysisDebugManifest
      if (configuration === null || manifest === undefined) {
        setAnalysisDebug((value) => ({
          ...value,
          phase: 'error',
          canSavePackage: true,
          packageSizeLabel: packageSizeLabel(prepared.handle.byteLength),
          errorMessage:
            configuration === null
              ? 'Direct reporting is not configured in this build.'
              : 'The prepared package is missing its report identity. Save it locally and try a fresh analysis.',
          reportId: null,
          receivedAt: null,
        }))
        return
      }

      const abortController = new AbortController()
      let timedOut = false
      const timeoutId = window.setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, ANALYSIS_REPORT_TIMEOUT_MS)
      analysisDebugUploadAbortRef.current = abortController
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'uploading',
        canSavePackage: true,
        packageSizeLabel: packageSizeLabel(prepared.handle.byteLength),
        errorMessage: null,
        reportId: null,
        receivedAt: null,
      }))
      void (async () => {
        try {
          const receipt = await sendAnalysisReport(configuration, {
            blob: prepared.packageValue.blob,
            packageId: manifest.packageId,
            packageSha256: prepared.packageValue.sha256,
            signal: abortController.signal,
          })
          if (generation !== analysisDebugGenerationRef.current) return
          if (preparedAnalysisDebugRef.current === prepared) {
            preparedAnalysisDebugRef.current = null
          }
          await discardPreparedExport(prepared.handle).catch(() => undefined)
          setAnalysisDebug((value) => ({
            ...value,
            phase: 'complete',
            canSavePackage: false,
            errorMessage: null,
            reportId: receipt.reportId,
            receivedAt: receipt.receivedAt,
          }))
        } catch (error) {
          if (generation !== analysisDebugGenerationRef.current) return
          setAnalysisDebug((value) => ({
            ...value,
            phase: 'error',
            canSavePackage: true,
            errorMessage: timedOut
              ? 'Sending timed out, so delivery was not confirmed. The service may already have received it. Retrying is safe and reuses the same report identity; nothing will be sent later in the background.'
              : asMessage(error),
            reportId: null,
            receivedAt: null,
          }))
        } finally {
          window.clearTimeout(timeoutId)
          if (analysisDebugUploadAbortRef.current === abortController) {
            analysisDebugUploadAbortRef.current = null
          }
        }
      })()
    },
    [],
  )

  const sendAnalysisDebug = useCallback(() => {
    if (ANALYSIS_REPORT_CONFIGURATION === null) {
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'error',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: 'Direct reporting is not configured in this build.',
        reportId: null,
        receivedAt: null,
      }))
      return
    }

    const existingPrepared = preparedAnalysisDebugRef.current
    if (existingPrepared) {
      uploadPreparedAnalysisDebug(existingPrepared, analysisDebugGenerationRef.current)
      return
    }

    const current = stateRef.current
    const draft = current.analysisDebugDraft
    const source = analysisDebugSourceRef.current ?? current.targetSourceFile
    if (!draft || !source) {
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'error',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: 'Record or upload and analyze a new source before sending diagnostics.',
        reportId: null,
        receivedAt: null,
      }))
      return
    }
    const sourceMediaType =
      source.type.length > 0 ? source.type : (current.targetSourceMimeType ?? '')
    const extension = debugAudioExtensionForMimeType(sourceMediaType)
    if (!extension) {
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'error',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage:
          'This source audio format cannot be placed in a safe debug package. Record again on this device or use AAC, M4A, MP3, MP4, WebM, or WAV.',
        reportId: null,
        receivedAt: null,
      }))
      return
    }

    releasePreparedAnalysisDebug()
    const generation = analysisDebugGenerationRef.current
    setAnalysisDebug((value) => ({
      ...value,
      phase: 'preparing',
      canSavePackage: false,
      packageSizeLabel: null,
      errorMessage: null,
      reportId: null,
      receivedAt: null,
    }))
    const preparer = new ExportPreparer()
    analysisDebugPreparerRef.current = preparer
    const appAssetFileName = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src]',
    )?.src
    const userDescription = analysisDebug.issueDescription.trim()
    const failureUserNote = draft.failureDescription
      ? userDescription.startsWith(draft.failureDescription)
        ? userDescription.slice(draft.failureDescription.length).trim()
        : userDescription
      : ''
    const reportDescription = draft.failureDescription
      ? `${draft.failureDescription}${failureUserNote ? ` User note: ${failureUserNote}` : ''}`.slice(
          0,
          500,
        )
      : userDescription.length > 0
        ? userDescription
        : null
    const input: AnalysisDebugPackageInput = {
      audio: { blob: source, extension },
      analysis: draft.analysis,
      detectorConfig: draft.detectorConfig,
      segmentationConfig: draft.segmentationConfig,
      captureMetadata: {
        recorderDurationSeconds: draft.recorderDurationSeconds,
        decodedDurationSeconds: draft.decodedDurationSeconds,
        decodedSampleRateHz: draft.decodedSampleRateHz,
        decodedChannelCount: draft.decodedChannelCount,
        settings: draft.captureSettings,
        partialReason: draft.partialReason,
        routeCategory: analysisDebug.routeCategory,
      },
      browserMetadata: {
        userAgent: navigator.userAgent,
        viewportWidthCssPixels: window.innerWidth,
        viewportHeightCssPixels: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        displayMode: analysisDebugDisplayMode(),
        appAssetFileName: appAssetFileName ?? null,
      },
      userReport: {
        expectedNoteCount: analysisDebug.expectedNoteCount,
        description: reportDescription,
      },
    }

    void (async () => {
      let handle: PreparedExportHandle | null = null
      try {
        const preparedHandle = await preparer.prepareAnalysisDebug(input)
        handle = preparedHandle
        const packageValue = await materializePreparedExport(preparedHandle)
        if (generation !== analysisDebugGenerationRef.current) {
          await discardPreparedExport(preparedHandle).catch(() => undefined)
          return
        }
        const prepared = { handle: preparedHandle, packageValue }
        preparedAnalysisDebugRef.current = prepared
        uploadPreparedAnalysisDebug(prepared, generation)
      } catch (error) {
        if (handle) await discardPreparedExport(handle).catch(() => undefined)
        if (generation !== analysisDebugGenerationRef.current) return
        setAnalysisDebug((value) => ({
          ...value,
          phase: 'error',
          canSavePackage: false,
          packageSizeLabel: null,
          errorMessage: asMessage(error),
          reportId: null,
          receivedAt: null,
        }))
      } finally {
        preparer.terminate()
        if (analysisDebugPreparerRef.current === preparer) {
          analysisDebugPreparerRef.current = null
        }
      }
    })()
  }, [
    analysisDebug.expectedNoteCount,
    analysisDebug.issueDescription,
    analysisDebug.routeCategory,
    releasePreparedAnalysisDebug,
    uploadPreparedAnalysisDebug,
  ])

  const saveAnalysisDebugPackage = useCallback(() => {
    const prepared = preparedAnalysisDebugRef.current
    if (!prepared) {
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'error',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: 'Send the report again to prepare a package before saving it.',
      }))
      return
    }
    try {
      savePreparedPackage(prepared.packageValue)
      setAnalysisDebug((value) => ({
        ...value,
        errorMessage:
          'A local debug package was saved. Delivery was not confirmed, so the service may still have received the report.',
      }))
    } catch (error) {
      setAnalysisDebug((value) => ({ ...value, errorMessage: asMessage(error) }))
    }
  }, [])

  const changeAnalysisDebugExpectedNoteCount = useCallback(
    (count: number | null) => {
      releasePreparedAnalysisDebug()
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'idle',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: null,
        reportId: null,
        receivedAt: null,
        expectedNoteCount: count === null ? null : Math.max(1, Math.min(100, Math.trunc(count))),
      }))
    },
    [releasePreparedAnalysisDebug],
  )

  const changeAnalysisDebugIssueDescription = useCallback(
    (description: string) => {
      releasePreparedAnalysisDebug()
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'idle',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: null,
        reportId: null,
        receivedAt: null,
        issueDescription: description.slice(0, 500),
      }))
    },
    [releasePreparedAnalysisDebug],
  )

  const changeAnalysisDebugRouteCategory = useCallback(
    (routeCategory: AnalysisDebugRouteCategory) => {
      releasePreparedAnalysisDebug()
      setAnalysisDebug((value) => ({
        ...value,
        phase: 'idle',
        canSavePackage: false,
        packageSizeLabel: null,
        errorMessage: null,
        reportId: null,
        receivedAt: null,
        routeCategory,
      }))
    },
    [releasePreparedAnalysisDebug],
  )

  const selectMidiTrack = useCallback(
    (trackId: string, parsed = state.midi) => {
      if (!parsed) return
      const notes = notesForTrack(parsed, trackId)
      patch({
        selectedMidiTrackId: trackId,
        notes,
        targetPitchPoints: [],
        targetStatus: `${notes.length} MIDI notes imported. ${notes.some((note) => !note.scorable) ? 'Overlaps are unscorable until corrected.' : 'Selected track is scorable.'}`,
        error: null,
      })
    },
    [state.midi],
  )

  return (
    <ProjectSetupScreen
      model={{
        title: state.title,
        referenceName: state.referenceName,
        targetMode: state.targetMode,
        targetStatus: state.targetStatus,
        notes: state.notes,
        transpositionSemitones: state.transpositionSemitones,
        alignmentSeconds: state.alignmentSeconds,
        validationMessage: state.error ?? validation,
        canSave: !state.busy && validation === null,
        midiTracks: state.midiTracks,
        selectedMidiTrackId: state.selectedMidiTrackId,
        recordedMelody,
        analysisSourceUrl,
        analysisDebug: state.analysisDebugDraft ? analysisDebug : undefined,
        analysisScene:
          state.targetMode === 'isolated-vocal' && state.targetPitchPoints.length > 0
            ? targetAnalysisScene(
                {
                  notes: state.notes,
                  targetPitchPoints: state.targetPitchPoints,
                  transpositionSemitones: state.transpositionSemitones,
                  alignmentSeconds: state.alignmentSeconds,
                  timingOffsetSeconds: 0,
                },
                state.targetSourceDurationSeconds || state.referenceDurationSeconds,
              )
            : undefined,
      }}
      onBack={() => navigate('/')}
      onTitleChange={(title) => patch({ title, error: null })}
      onReferenceFile={(file) => {
        patch({ busy: true, error: null })
        void validateAudioFile(file, 'backing')
          .then((duration) => {
            setUseRecordedSourceAsReference(false)
            patch({
              busy: false,
              referenceAssetId: null,
              referenceFile: file,
              referenceName: file.name.slice(0, 255),
              referenceMimeType: file.type || 'application/octet-stream',
              referenceDurationSeconds: duration,
            })
          })
          .catch((error: unknown) => patch({ busy: false, error: asMessage(error) }))
      }}
      onTargetModeChange={(targetMode) =>
        patch({
          targetMode,
          targetPitchPoints: targetMode === 'isolated-vocal' ? state.targetPitchPoints : [],
          targetStatus:
            targetMode === 'manual'
              ? 'Manual edits create a new authoritative revision.'
              : state.targetStatus,
          error: null,
        })
      }
      onMidiFile={(file) => {
        patch({ busy: true, error: null, targetStatus: 'Parsing MIDI in a same-origin worker…' })
        void parseMidiFile(file)
          .then((midi) => {
            const midiTracks = midi.tracks
              .filter((track) => track.noteCount > 0)
              .map((track) => ({
                id: String(track.index),
                name: track.name,
                noteCount: track.noteCount,
              }))
            if (midiTracks.length === 0)
              throw new Error('No note tracks were found in this MIDI file.')
            const preferred = [...midiTracks].sort((a, b) => b.noteCount - a.noteCount)[0]
            if (!preferred) throw new Error('Choose a MIDI track containing notes.')
            const notes = notesForTrack(midi, preferred.id)
            patch({
              busy: false,
              midi,
              midiTracks,
              selectedMidiTrackId: preferred.id,
              notes,
              targetPitchPoints: [],
              targetStatus: `${notes.length} notes loaded from ${preferred.name}. Select another melody track if needed.`,
            })
          })
          .catch((error: unknown) =>
            patch({
              busy: false,
              error: asMessage(error),
              targetStatus: 'MIDI import failed safely.',
            }),
          )
      }}
      onMidiTrackChange={selectMidiTrack}
      onIsolatedVocalFile={(file) => {
        if (
          state.notes.length > 0 &&
          !window.confirm(
            'Create a new analyzed draft? Existing manual notes remain in the saved revision until you save this draft.',
          )
        )
          return
        patch({ busy: true, error: null, targetStatus: 'Checking isolated-source memory budget…' })
        void applyAnalyzedSource(file, 'upload').catch((error: unknown) =>
          patch({
            busy: false,
            error: asMessage(error),
            targetStatus: 'Analysis stopped without changing the saved revision.',
          }),
        )
      }}
      onStartRecordedMelody={startRecordedMelody}
      onStopRecordedMelody={() => {
        const capture = recordedCaptureRef.current
        if (!capture) return
        setRecordedMelody((value) => ({ ...value, phase: 'finalizing' }))
        patch({ targetStatus: 'Finalizing the recording before local analysis…' })
        void capture.stop().catch((error: unknown) => {
          const message = captureFailureMessage(error)
          setRecordedMelody((value) => ({
            ...value,
            phase: 'error',
            errorMessage: message,
          }))
          patch({ busy: false, error: message, targetStatus: 'Recording could not be finalized.' })
        })
      }}
      onRecordMelodyAgain={startRecordedMelody}
      onAnalysisDebugExpectedNoteCountChange={changeAnalysisDebugExpectedNoteCount}
      onAnalysisDebugIssueDescriptionChange={changeAnalysisDebugIssueDescription}
      onAnalysisDebugRouteCategoryChange={changeAnalysisDebugRouteCategory}
      onSendAnalysisDebug={sendAnalysisDebug}
      onSaveAnalysisDebugPackage={saveAnalysisDebugPackage}
      useRecordedSourceAsReference={useRecordedSourceAsReference}
      onUseRecordedSourceAsReferenceChange={(useAsReference) => {
        setUseRecordedSourceAsReference(useAsReference)
        useRecordedSourceAsReferenceRef.current = useAsReference
        const current = stateRef.current
        if (
          useAsReference &&
          current.targetSourceFile &&
          current.targetSourceAssetId &&
          current.targetSourceDurationSeconds > 0
        ) {
          patch({
            referenceAssetId: current.targetSourceAssetId,
            referenceName: current.targetSourceName,
            referenceMimeType: current.targetSourceMimeType,
            referenceDurationSeconds: current.targetSourceDurationSeconds,
            referenceFile: current.targetSourceFile,
            error: null,
          })
        } else if (
          !useAsReference &&
          current.targetSourceAssetId !== null &&
          current.referenceAssetId === current.targetSourceAssetId
        ) {
          patch({
            referenceAssetId: null,
            referenceName: null,
            referenceMimeType: null,
            referenceDurationSeconds: 0,
            referenceFile: null,
          })
        }
      }}
      onTranspositionChange={(transpositionSemitones) =>
        patch({ transpositionSemitones, error: null })
      }
      onAlignmentChange={(alignmentSeconds) => patch({ alignmentSeconds, error: null })}
      onNoteChange={(note: EditableTargetNote) =>
        patch({
          notes: state.notes.map((candidate) =>
            candidate.id === note.id
              ? { ...candidate, ...note, lyric: note.lyric ?? '', scorable: true }
              : candidate,
          ),
          targetMode: state.targetMode === 'isolated-vocal' ? 'isolated-vocal' : state.targetMode,
          targetStatus: 'Edited notes will be authoritative in the next revision.',
          error: null,
        })
      }
      onAddNote={() => {
        const id = crypto.randomUUID()
        setState((current) => {
          const previous = current.notes.at(-1)
          const startSeconds = previous?.endSeconds ?? 0
          return {
            ...current,
            targetMode: current.targetMode === 'isolated-vocal' ? 'isolated-vocal' : 'manual',
            notes: [
              ...current.notes,
              {
                id,
                startSeconds,
                endSeconds: startSeconds + 1,
                midiNote: previous?.midiNote ?? 60,
                lyric: '',
                scorable: true,
              },
            ],
            targetStatus:
              current.targetMode === 'isolated-vocal'
                ? 'Edited notes will be authoritative in the next analyzed revision.'
                : 'Manual notes are authoritative after save.',
            error: null,
          }
        })
      }}
      onAddKeyboardNote={(input) => {
        const id = crypto.randomUUID()
        setState((current) => {
          const midiNote = input.displayedMidiNote - current.transpositionSemitones
          if (!Number.isInteger(midiNote) || midiNote < 0 || midiNote > 127) {
            return {
              ...current,
              error: 'That piano key falls outside MIDI 0–127 at the current transpose.',
            }
          }
          const durationSeconds =
            Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
              ? Math.min(60, input.durationSeconds)
              : 1
          const gapSeconds =
            Number.isFinite(input.gapSeconds) && input.gapSeconds >= 0
              ? Math.min(60, input.gapSeconds)
              : 0
          const latestEndSeconds = current.notes.reduce(
            (latest, note) =>
              Number.isFinite(note.endSeconds) ? Math.max(latest, note.endSeconds) : latest,
            0,
          )
          const startSeconds =
            current.notes.length === 0
              ? 0
              : Math.round((latestEndSeconds + gapSeconds) * 1000) / 1000
          const endSeconds = Math.round((startSeconds + durationSeconds) * 1000) / 1000
          return {
            ...current,
            targetMode: 'manual',
            targetPitchPoints: [],
            notes: [
              ...current.notes,
              {
                id,
                startSeconds,
                endSeconds,
                midiNote,
                lyric: '',
                scorable: true,
              },
            ],
            targetStatus: 'Piano-entered notes are authoritative after save.',
            error: null,
          }
        })
      }}
      onRemoveNote={(id) =>
        setState((current) => ({
          ...current,
          notes: current.notes.filter((note) => note.id !== id),
          targetStatus: 'Edited notes will be authoritative in the next revision.',
          error: null,
        }))
      }
      onSave={() => {
        patch({ busy: true, error: null })
        void (async () => {
          const stagedAssetIds = new Set<string>()
          try {
            const targetSourceAssetId =
              state.targetMode === 'isolated-vocal' ? state.targetSourceAssetId : null
            let referenceAssetId = state.referenceAssetId

            if (
              state.targetMode === 'isolated-vocal' &&
              state.referenceFile !== null &&
              state.targetSourceFile !== null &&
              state.referenceFile === state.targetSourceFile &&
              targetSourceAssetId !== null &&
              state.referenceAssetId === targetSourceAssetId
            ) {
              await storeBinary(
                state.targetSourceFile,
                state.id,
                targetSourceAssetId,
                state.targetSourceMimeType ?? undefined,
              )
              stagedAssetIds.add(targetSourceAssetId)
              referenceAssetId = targetSourceAssetId
            } else {
              if (state.referenceFile) {
                referenceAssetId = await storeBinary(state.referenceFile, state.id)
                stagedAssetIds.add(referenceAssetId)
              }
              if (
                state.targetMode === 'isolated-vocal' &&
                state.targetSourceFile &&
                targetSourceAssetId
              ) {
                await storeBinary(
                  state.targetSourceFile,
                  state.id,
                  targetSourceAssetId,
                  state.targetSourceMimeType ?? undefined,
                )
                stagedAssetIds.add(targetSourceAssetId)
              }
            }
            const now = new Date().toISOString()
            const project = appProjectSchema.parse({
              id: state.id,
              schemaVersion: 1,
              title: state.title.trim(),
              createdAt: state.createdAt,
              updatedAt: now,
              referenceName: state.referenceName,
              referenceAssetId,
              referenceMimeType: state.referenceMimeType,
              referenceDurationSeconds: state.referenceDurationSeconds,
              isSyntheticDemo: false,
              targetMode: state.targetMode,
              targetStatus:
                state.targetMode === 'isolated-vocal'
                  ? 'Analyzed estimate with manual corrections'
                  : 'Authoritative target revision',
              targetSourceAssetId,
              targetSourceName:
                state.targetMode === 'isolated-vocal' ? state.targetSourceName : null,
              targetSourceMimeType:
                state.targetMode === 'isolated-vocal' ? state.targetSourceMimeType : null,
              targetRevision: state.targetRevision + 1,
              transpositionSemitones: state.transpositionSemitones,
              alignmentSeconds: state.alignmentSeconds,
              timingOffsetSeconds: state.existing?.timingOffsetSeconds ?? 0,
              notes: normalizedScoring(state.notes),
              targetPitchPoints: state.targetPitchPoints,
              loops: state.existing?.loops ?? [],
              takes: state.existing?.takes ?? [],
              lastBackupAt: state.existing?.lastBackupAt ?? null,
            })
            await putProject(project)

            if (state.existing) {
              const replacementIds = binaryAssetIds(project)
              const superseded = unsharedBinaryAssetIds(state.existing, projects).filter(
                (id) => !replacementIds.has(id),
              )
              const failedDeletes = await deleteBinaryAssets(superseded)
              if (failedDeletes > 0) {
                setMessage(
                  'The project was saved, but replaced audio could not be fully removed from local storage.',
                )
              }
            }

            await requestPersistentStorageAfterExplicitSave().catch(() => false)
            void navigate(`/practice/${project.id}`)
          } catch (error) {
            await deleteBinaryAssets([...stagedAssetIds]).catch(() => undefined)
            throw error
          }
        })().catch((error: unknown) => {
          patch({ busy: false, error: asMessage(error) })
          setMessage(asMessage(error))
        })
      }}
    />
  )
}

function PracticeRoute() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const project = useAppStore(
    (state) => state.projects.find((candidate) => candidate.id === projectId) ?? null,
  )
  const addTake = useAppStore((state) => state.addTake)
  const updateLoop = useAppStore((state) => state.updateLoop)
  const setMessage = useAppStore((state) => state.setMessage)
  const storageState = useAppStore((state) => state.storageState)
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(
    () => project?.loops[0]?.id ?? null,
  )
  const [guideToneEnabled, setGuideToneEnabled] = useState(true)
  const repeatPlan = useRef<{
    startSeconds: number
    endSeconds: number
    remaining: number
    total: number
    guideToneEnabled: boolean
    promptBackup: boolean
  } | null>(null)
  const [pendingRepeat, setPendingRepeat] = useState(false)
  const onTakeSaved = useCallback(
    (take: Parameters<typeof addTake>[1]) => {
      if (!project) return
      void addTake(project.id, take)
        .then(() => {
          const plan = repeatPlan.current
          if (plan && plan.remaining > 1 && take.partialReason === null) {
            repeatPlan.current = { ...plan, remaining: plan.remaining - 1 }
            setMessage(
              `Take ${plan.total - plan.remaining + 1} of ${plan.total} is saved locally. The next separate take will begin after its countdown.`,
            )
            setPendingRepeat(true)
            return
          }
          repeatPlan.current = null
          setPendingRepeat(false)
          if (
            take.partialReason === null &&
            (plan?.promptBackup === true || project.takes.length === 0)
          ) {
            setMessage(
              'Your first take is saved locally. Return to Projects and choose Back up now so iOS storage pressure or app removal cannot erase your only copy.',
            )
          }
          return navigate(`/review/${project.id}/${take.id}`)
        })
        .catch((error: unknown) => setMessage(asMessage(error)))
    },
    [addTake, navigate, project, setMessage],
  )
  const controller = usePracticeController(project ?? createDemoProject(), onTakeSaved)
  useEffect(() => {
    const plan = repeatPlan.current
    if (!pendingRepeat || plan === null || controller.phase !== 'ready') return
    setPendingRepeat(false)
    controller.start(plan.startSeconds, plan.endSeconds, plan.guideToneEnabled)
  }, [controller, pendingRepeat])
  if (!project) return <Navigate to="/" replace />

  const selectedLoop = project.loops.find((loop) => loop.id === selectedLoopId) ?? null
  const start = selectedLoop?.startSeconds ?? 0
  const end = selectedLoop?.endSeconds ?? project.referenceDurationSeconds
  const currentPitch = currentPitchLabel(controller.points)
  const target = project.notes.find(
    (note) =>
      controller.currentSeconds >= note.startSeconds + project.alignmentSeconds &&
      controller.currentSeconds < note.endSeconds + project.alignmentSeconds,
  )
  const actualMidi = controller.points.at(-1)?.midiNote ?? null
  const targetMidi = target ? target.midiNote + project.transpositionSemitones : null
  const cents =
    actualMidi === null || targetMidi === null ? null : centsBetweenMidi(actualMidi, targetMidi)

  return (
    <PracticeScreen
      model={{
        projectTitle: project.title,
        phase: controller.phase,
        currentSeconds: controller.currentSeconds,
        durationSeconds: project.referenceDurationSeconds,
        countdownSeconds: controller.countdownSeconds,
        currentNote: currentPitch.note,
        frequencyHz: currentPitch.frequencyHz,
        cents,
        confidence: currentPitch.confidence,
        level: controller.level,
        scene: projectScene(project, controller.points, controller.currentSeconds),
        loops: project.loops,
        sections: project.loops,
        selectedLoopId,
        supportedPlaybackRates: controller.supportedPlaybackRates,
        playbackRate: controller.playbackRate,
        microphoneInputs: controller.microphoneInputs,
        selectedMicrophoneId: controller.selectedMicrophoneId,
        appliedSettings: controller.appliedSettings,
        failureMessage: controller.failureMessage,
        noticeMessage: controller.noticeMessage,
        storageHealth:
          storageState === 'ready'
            ? 'OPFS and IndexedDB passed their probes. Keep a current backup.'
            : storageState === 'limited'
              ? 'OPFS is unavailable. Bounded IndexedDB chunks are active; keep a current backup.'
              : 'Storage is not ready. Recording is disabled.',
        guideToneEnabled,
        captureProfile: controller.captureProfile,
        recordingAvailable: storageState === 'ready' || storageState === 'limited',
      }}
      onBack={() => {
        repeatPlan.current = null
        setPendingRepeat(false)
        void controller.stop().finally(() => navigate('/'))
      }}
      onStart={() => {
        if (storageState !== 'ready' && storageState !== 'limited') {
          setMessage('Recording is disabled until the IndexedDB storage probe succeeds.')
          return
        }
        const existingPlan = controller.phase === 'retry' ? repeatPlan.current : null
        const repetitions = selectedLoop?.enabled ? selectedLoop.repetitions : 1
        const plan = existingPlan ?? {
          startSeconds: start,
          endSeconds: end,
          remaining: repetitions,
          total: repetitions,
          guideToneEnabled,
          promptBackup: project.takes.length === 0,
        }
        repeatPlan.current = plan
        controller.start(plan.startSeconds, plan.endSeconds, plan.guideToneEnabled)
      }}
      onPause={controller.pause}
      onStop={() => {
        repeatPlan.current = null
        setPendingRepeat(false)
        void controller.stop()
      }}
      onSeek={controller.seek}
      onSelectLoop={setSelectedLoopId}
      onLoopChange={(loop: PracticeLoopView) => {
        void updateLoop(project.id, loop).catch((error: unknown) => setMessage(asMessage(error)))
      }}
      onAddLoop={() => {
        const loop = {
          id: crypto.randomUUID(),
          name: `Section ${project.loops.length + 1}`,
          startSeconds: Math.max(0, controller.currentSeconds - 2),
          endSeconds: Math.min(project.referenceDurationSeconds, controller.currentSeconds + 2),
          repetitions: 2,
          enabled: true,
        }
        void updateLoop(project.id, loop)
          .then(() => setSelectedLoopId(loop.id))
          .catch((error: unknown) => setMessage(asMessage(error)))
      }}
      onSelectSection={(id) => setSelectedLoopId(id)}
      onPlaybackRateChange={controller.setPlaybackRate}
      onMicrophoneChange={controller.setSelectedMicrophoneId}
      onGuideToneChange={setGuideToneEnabled}
      onCaptureProfileChange={controller.setCaptureProfile}
    />
  )
}

function ReviewRoute() {
  const { projectId, takeId } = useParams()
  const navigate = useNavigate()
  const project = useAppStore(
    (state) => state.projects.find((candidate) => candidate.id === projectId) ?? null,
  )
  const updateTimingOffset = useAppStore((state) => state.updateTimingOffset)
  const setMessage = useAppStore((state) => state.setMessage)
  const take = project?.takes.find((candidate) => candidate.id === takeId) ?? null
  const controller = useReviewController(
    project ?? createDemoProject(),
    take ??
      createDemoProject().takes[0] ?? {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        label: 'Missing',
        projectStartSeconds: 0,
        durationSeconds: 0,
        audioAssetId: null,
        audioMimeType: null,
        partialReason: null,
        points: [],
      },
  )
  if (!project || !take) return <Navigate to="/" replace />
  const report = takeMetrics(project, take)
  const scene = reviewScene(
    project,
    take,
    controller.currentSeconds,
    controller.pitchMode,
    controller.zoomLevel,
  )
  return (
    <ReviewScreen
      model={{
        projectTitle: project.title,
        takeLabel: take.label,
        playbackPhase: controller.playbackPhase,
        currentSeconds: controller.currentSeconds,
        durationSeconds: take.durationSeconds,
        scene,
        metrics: metricDisplays(report.overall),
        sectionMetrics: report.sections.map((section) => ({
          id: section.sectionId,
          name: section.sectionName,
          metrics: metricDisplays(section.metrics),
        })),
        selectedPoint: inspectedPoint(project, take, controller.currentSeconds),
        timingOffsetSeconds: project.timingOffsetSeconds,
        partialReason: take.partialReason,
        export: controller.export,
        traceDisplay: controller.traceDisplay,
        pitchMode: controller.pitchMode,
        zoomLevel: controller.zoomLevel,
        loopPlayback: controller.loopPlayback,
      }}
      onBack={() => navigate(`/practice/${project.id}`)}
      onPlay={controller.play}
      onPause={controller.pause}
      onStop={controller.stop}
      onSeek={controller.seek}
      onTimingOffsetChange={(seconds) => {
        void updateTimingOffset(project.id, seconds).catch((error: unknown) =>
          setMessage(asMessage(error)),
        )
      }}
      onPrepareExport={controller.prepareExport}
      onShareExport={controller.shareExport}
      onIncludeReferenceChange={controller.setIncludeReference}
      onIncludeWavChange={controller.setIncludeWav}
      onTraceDisplayChange={controller.setTraceDisplay}
      onPitchModeChange={controller.setPitchMode}
      onZoomIn={controller.zoomIn}
      onZoomOut={controller.zoomOut}
      onLoopPlaybackChange={controller.setLoopPlayback}
      onSaveRecording={() => controller.downloadIndividual('recording')}
      onSavePitchCsv={() => controller.downloadIndividual('pitchCsv')}
      onSaveTargetCsv={() => controller.downloadIndividual('targetCsv')}
      onSaveChartPng={() => controller.downloadIndividual('chartPng')}
      onSaveSessionJson={() => controller.downloadIndividual('sessionJson')}
      onSaveReportHtml={() => controller.downloadIndividual('reportHtml')}
      onSaveManifestJson={() => controller.downloadIndividual('manifestJson')}
      onSaveReadme={() => controller.downloadIndividual('readme')}
    />
  )
}

function AppRoutes() {
  const hydrate = useAppStore((state) => state.hydrate)
  const hydrated = useAppStore((state) => state.hydrated)
  const setStorageState = useAppStore((state) => state.setStorageState)
  const setMessage = useAppStore((state) => state.setMessage)
  const startupStarted = useRef(false)
  useEffect(() => {
    if (startupStarted.current) return
    startupStarted.current = true
    void (async () => {
      await hydrate()
      await pruneExportScratch().catch(() => undefined)
      const result = await probeStorage()
      if (!result.indexedDb) {
        setStorageState('failed', result.errors.join(' '))
        return
      }
      setStorageState(
        result.opfs ? 'ready' : 'limited',
        result.opfs ? null : 'OPFS is unavailable; bounded IndexedDB storage will be used.',
      )
      const database = getDatabase()
      const binaryStore = await getBinaryStore()
      const recovery = await recoverBinaryState(database, binaryStore)
      const recoveredAssets = [...recovery.committedRecordings]
      for (const recoverable of recovery.recoverable) {
        recoveredAssets.push(await finalizeRecoveredRecording(database, binaryStore, recoverable))
      }

      let recoveredCount = 0
      for (const asset of recoveredAssets) {
        const project = useAppStore
          .getState()
          .projects.find((candidate) => candidate.id === asset.projectId)
        if (
          project === undefined ||
          project.takes.some((take) => take.audioAssetId === asset.logicalAssetId)
        ) {
          continue
        }

        const recording = await binaryStore.read(asset.logicalAssetId)
        if (recording === null) continue
        const decodedDuration = await audioDurationSeconds(recording).catch(() => 0.02)
        const durationSeconds = Math.max(0.02, Math.min(900, decodedDuration))
        const payload =
          typeof asset.payload === 'object' &&
          asset.payload !== null &&
          !Array.isArray(asset.payload)
            ? asset.payload
            : {}
        const partial = payload['partial'] === true
        const interruptionReason =
          typeof payload['interruptionReason'] === 'string'
            ? payload['interruptionReason'].replaceAll('-', ' ')
            : 'an interrupted save'
        await useAppStore.getState().addTake(asset.projectId, {
          id: crypto.randomUUID(),
          createdAt: asset.createdAt,
          label: `Take ${project.takes.length + 1} (recovered)`,
          projectStartSeconds: 0,
          durationSeconds,
          audioAssetId: asset.logicalAssetId,
          audioMimeType: asset.mimeType,
          partialReason: partial
            ? `Recovered after ${interruptionReason}; pitch samples were unavailable.`
            : 'Recovered after an interrupted save; pitch samples were unavailable.',
          points: [],
        })
        recoveredCount += 1
      }
      if (recoveredCount > 0) {
        setMessage(
          `${recoveredCount} interrupted take${recoveredCount === 1 ? ' was' : 's were'} recovered as partial local recordings.`,
        )
      }
    })().catch((error: unknown) => {
      setStorageState('failed', asMessage(error))
    })
  }, [hydrate, setMessage, setStorageState])
  if (!hydrated)
    return (
      <main className="boot-screen">
        <div className="brand-mark" aria-hidden="true">
          S
        </div>
        <h1>SingScope</h1>
        <p>Opening your private practice studio…</p>
      </main>
    )
  return (
    <>
      <Routes>
        <Route path="/" element={<DashboardRoute />} />
        <Route path="/setup/:projectId" element={<SetupRoute />} />
        <Route path="/practice/:projectId" element={<PracticeRoute />} />
        <Route path="/review/:projectId/:takeId" element={<ReviewRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <AppStatus />
    </>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}
