import { useCallback, useEffect, useRef, useState } from 'react'
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router'

import {
  analyzeMonophonicAudioBuffer,
  createAnalyzedTargetDraftInput,
  decideMonophonicAnalysisStrategy,
} from './audio/dsp'
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
import type { AppProject, AppTargetNote, AppTargetPitchPoint } from './app/types'
import { currentPitchLabel, usePracticeController } from './app/use-practice-controller'
import { useReviewController } from './app/use-review-controller'
import { inspectedPoint, metricDisplays, projectScene, takeMetrics } from './app/view-models'

const ONBOARDING_KEY = 'singscope:onboarding:v1'

function installedDisplayMode(): boolean {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean }
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    standaloneNavigator.standalone === true
  )
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
  readonly targetSourceFile: File | null
  readonly targetPitchPoints: readonly AppTargetPitchPoint[]
  readonly notes: readonly AppTargetNote[]
  readonly transpositionSemitones: number
  readonly alignmentSeconds: number
  readonly midi: ParsedMidi | null
  readonly midiTracks: readonly MidiTrackView[]
  readonly selectedMidiTrackId: string | null
  readonly targetRevision: number
  readonly existing: AppProject | null
  readonly busy: boolean
  readonly error: string | null
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
    targetSourceFile: null,
    targetPitchPoints: project?.targetPitchPoints ?? [],
    notes: project?.notes ?? [],
    transpositionSemitones: project?.transpositionSemitones ?? 0,
    alignmentSeconds: project?.alignmentSeconds ?? 0,
    midi: null,
    midiTracks: [],
    selectedMidiTrackId: null,
    targetRevision: project?.targetRevision ?? 0,
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

function setupValidation(state: SetupState): string | null {
  if (!state.title.trim()) return 'Enter a project title.'
  if (!state.referenceName || state.referenceDurationSeconds <= 0)
    return 'Choose a valid backing audio file.'
  if (
    state.targetMode === 'isolated-vocal' &&
    !state.targetSourceAssetId &&
    !state.targetSourceFile
  ) {
    return 'Choose an isolated monophonic vocal source before saving this target.'
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
  const patch = (value: Partial<SetupState>) => setState((current) => ({ ...current, ...value }))
  const validation = setupValidation(state)

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
        targetStatus: state.busy ? 'Working locally…' : state.targetStatus,
        notes: state.notes,
        transpositionSemitones: state.transpositionSemitones,
        alignmentSeconds: state.alignmentSeconds,
        validationMessage: state.error ?? validation,
        canSave: !state.busy && validation === null,
        midiTracks: state.midiTracks,
        selectedMidiTrackId: state.selectedMidiTrackId,
      }}
      onBack={() => navigate('/')}
      onTitleChange={(title) => patch({ title, error: null })}
      onReferenceFile={(file) => {
        patch({ busy: true, error: null })
        void validateAudioFile(file, 'backing')
          .then((duration) =>
            patch({
              busy: false,
              referenceFile: file,
              referenceName: file.name.slice(0, 255),
              referenceMimeType: file.type || 'application/octet-stream',
              referenceDurationSeconds: duration,
            }),
          )
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
        void (async () => {
          const duration = await validateAudioFile(file, 'isolated')
          const provisional = decideMonophonicAnalysisStrategy({
            encodedByteLength: file.size,
            durationSeconds: duration,
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
            const buffer = await context.decodeAudioData(await file.arrayBuffer())
            const admission = decideMonophonicAnalysisStrategy({
              encodedByteLength: file.size,
              durationSeconds: buffer.duration,
              sampleRateHz: buffer.sampleRate,
              channelCount: buffer.numberOfChannels,
            })
            if (admission.strategy !== 'offline-buffer')
              throw new Error(
                'Decoded audio exceeds the whole-file memory budget; use a shorter monophonic source.',
              )
            const analysis = await analyzeMonophonicAudioBuffer(buffer, { admission })
            const sourceAssetId = crypto.randomUUID()
            const draft = createAnalyzedTargetDraftInput(analysis, {
              sourceAssetId,
              previousRevision: state.existing
                ? {
                    id: state.existing.id,
                    revision: state.existing.targetRevision,
                    alignmentSeconds: state.existing.alignmentSeconds,
                    transposeSemitones: state.existing.transpositionSemitones,
                  }
                : null,
            })
            patch({
              busy: false,
              targetMode: 'isolated-vocal',
              targetSourceAssetId: sourceAssetId,
              targetSourceName: file.name.slice(0, 255),
              targetSourceMimeType: file.type || 'application/octet-stream',
              targetSourceFile: file,
              targetRevision: draft.revision - 1,
              notes: draft.notes.map((note) => ({
                id: crypto.randomUUID(),
                startSeconds: note.startSeconds,
                endSeconds: note.endSeconds,
                midiNote: note.midiNote,
                lyric: '',
                scorable: note.scorable,
              })),
              targetPitchPoints: draft.pitchPoints,
              targetStatus: `${draft.notes.length} estimated notes in a new draft. Review and correct them before saving.`,
            })
          } finally {
            await context.close()
          }
        })().catch((error: unknown) =>
          patch({
            busy: false,
            error: asMessage(error),
            targetStatus: 'Analysis stopped without changing the saved revision.',
          }),
        )
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
      onAddNote={() =>
        patch({
          targetMode: 'manual',
          notes: [
            ...state.notes,
            {
              id: crypto.randomUUID(),
              startSeconds: state.notes.at(-1)?.endSeconds ?? 0,
              endSeconds: (state.notes.at(-1)?.endSeconds ?? 0) + 1,
              midiNote: state.notes.at(-1)?.midiNote ?? 60,
              lyric: '',
              scorable: true,
            },
          ],
          targetStatus: 'Manual notes are authoritative after save.',
        })
      }
      onRemoveNote={(id) => patch({ notes: state.notes.filter((note) => note.id !== id) })}
      onSave={() => {
        patch({ busy: true, error: null })
        void (async () => {
          const stagedAssetIds: string[] = []
          try {
            let referenceAssetId = state.referenceAssetId
            if (state.referenceFile) {
              referenceAssetId = await storeBinary(state.referenceFile, state.id)
              stagedAssetIds.push(referenceAssetId)
            }
            const targetSourceAssetId =
              state.targetMode === 'isolated-vocal' ? state.targetSourceAssetId : null
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
              stagedAssetIds.push(targetSourceAssetId)
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
            await deleteBinaryAssets(stagedAssetIds).catch(() => undefined)
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
        durationSeconds: 0,
        audioAssetId: null,
        audioMimeType: null,
        partialReason: null,
        points: [],
      },
  )
  if (!project || !take) return <Navigate to="/" replace />
  const report = takeMetrics(project, take)
  const scene = projectScene(
    project,
    take.points,
    controller.currentSeconds,
    true,
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
