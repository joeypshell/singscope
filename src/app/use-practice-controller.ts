import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  beginBrowserAudioCapture,
  createGeneratedPcmAudioBuffer,
  ForegroundRecorder,
  PcmCapturePipeline,
  prepareBrowserAudioPlayback,
  ReferencePlayer,
  renderMelodyReferenceInWorker,
  SynthesizedReferencePlayer,
  createBrowserWakeLockAdapter,
  pitchCandidateGapReason,
  requestMicrophone,
  selectRecorderMimeType,
  stopMediaStream,
  type CaptureProfile,
  type CaptureSettings,
  type AudioCaptureSession,
  type PlaybackFailure,
  type PlaybackRate,
  type ReferencePlayback,
  type RecordingInterruption,
} from '../audio/runtime'
import { melodyReferenceDurationSeconds } from '../audio/dsp'
import { frequencyToMidi, midiNoteName } from '../domain'
import { DETECTOR_VERSION } from '../domain/versions'
import { getDatabase, RecordingAssetWriter, type InterruptionReason } from '../persistence'
import { createMockPitchTrace } from './demo'
import { getBinaryStore, referenceAudioUrl } from './files'
import type { AppPitchPoint, AppProject, AppTake } from './types'

export type PracticePhase =
  'idle' | 'ready' | 'countdown' | 'recording' | 'paused' | 'retry' | 'finalizing'

interface ControllerState {
  readonly phase: PracticePhase
  readonly currentSeconds: number
  readonly countdownSeconds: number
  readonly points: readonly AppPitchPoint[]
  readonly failureMessage: string | null
  readonly noticeMessage: string | null
  readonly level: number
  readonly appliedSettings: readonly string[]
  readonly microphoneInputs: readonly { deviceId: string; label: string }[]
  readonly selectedMicrophoneId: string | null
  readonly supportedPlaybackRates: readonly PlaybackRate[]
  readonly playbackRate: PlaybackRate
  readonly captureProfile: CaptureProfile
}

interface ActiveRuntime {
  readonly context: AudioContext
  readonly element: HTMLAudioElement | null
  readonly player: ReferencePlayback
  readonly referenceMediaUrl: { readonly url: string; readonly revoke: () => void } | null
  audioCaptureSession: AudioCaptureSession | null
  stream: MediaStream | null
  pipeline: PcmCapturePipeline | null
  recorder: ForegroundRecorder | null
  writer: RecordingAssetWriter | null
  assetId: string | null
  recordingMimeType: string | null
  recordingStartSeconds: number
  recordingStartContextTime: number | null
  recordingStopProjectSeconds: number | null
  lastValidContextSeconds: number | null
  lastValidProjectSeconds: number | null
  playbackRate: PlaybackRate
  captureProfile: CaptureProfile
  captureSettings: CaptureSettings | null
  recorderChunkCount: number
  recorderSmallestChunkBytes: number | null
  recorderLargestChunkBytes: number | null
  attemptId: number
  allowPostSaveNavigation: boolean
}

interface PreparedSynthesizedReference {
  readonly bytes: ArrayBuffer
}

function usesSynthesizedReference(project: AppProject): boolean {
  return (
    !project.isSyntheticDemo &&
    project.targetMode === 'manual' &&
    project.referenceAssetId === null &&
    project.notes.length > 0
  )
}

function releaseAudioCapture(active: ActiveRuntime): void {
  active.audioCaptureSession?.release()
  active.audioCaptureSession = null
}

function rememberProjectTime(
  active: ActiveRuntime,
  projectTimeSeconds: number,
  contextTimeSeconds: number,
): void {
  if (!Number.isFinite(projectTimeSeconds) || !Number.isFinite(contextTimeSeconds)) return
  active.lastValidProjectSeconds = Math.max(0, projectTimeSeconds)
  active.lastValidContextSeconds = Math.max(0, contextTimeSeconds)
}

function fallbackProjectTime(
  active: ActiveRuntime,
  contextTimeSeconds = active.context.currentTime,
): number {
  const mapped = active.player.currentProjectTime(contextTimeSeconds)
  if (mapped !== null) {
    rememberProjectTime(active, mapped, contextTimeSeconds)
    return mapped
  }
  if (active.lastValidContextSeconds !== null && active.lastValidProjectSeconds !== null) {
    const projected = Math.max(
      0,
      active.lastValidProjectSeconds +
        (contextTimeSeconds - active.lastValidContextSeconds) * active.playbackRate,
    )
    return active.recordingStopProjectSeconds === null
      ? projected
      : Math.min(projected, active.recordingStopProjectSeconds)
  }
  if (active.element && Number.isFinite(active.element.currentTime)) {
    return active.element.currentTime
  }
  return active.recordingStartSeconds
}

function stopStreamAndRefreshAudioRoute(stream: MediaStream): void {
  try {
    stopMediaStream(stream)
  } finally {
    // A late getUserMedia resolution can change WebKit's native route even after
    // its owner was cancelled. Reapply playback or the surviving capture owner.
    prepareBrowserAudioPlayback()
  }
}

function interruptionForWriter(reason: RecordingInterruption | null): InterruptionReason {
  if (reason === null) return 'none'
  if (reason === 'audio-context-interrupted') return 'audio-context-interrupted'
  if (reason === 'microphone-ended') return 'media-track-ended'
  if (reason === 'route-lost') return 'device-route-lost'
  return 'app-backgrounded'
}

function settingLabels(settings: CaptureSettings | null): readonly string[] {
  if (!settings) return []
  return [
    settings.label ? `Input: ${settings.label}` : null,
    settings.sampleRate
      ? `Sample rate: ${settings.sampleRate.toLocaleString()} Hz`
      : 'Sample rate: browser-managed',
    settings.channelCount ? `Channels: ${settings.channelCount}` : null,
    settings.echoCancellation === null
      ? null
      : `Echo cancellation: ${settings.echoCancellation ? 'on' : 'off'}`,
    settings.noiseSuppression === null
      ? null
      : `Noise suppression: ${settings.noiseSuppression ? 'on' : 'off'}`,
    settings.autoGainControl === null
      ? null
      : `Auto gain: ${settings.autoGainControl ? 'on' : 'off'}`,
  ].filter((label): label is string => label !== null)
}

export interface PracticeController extends ControllerState {
  readonly start: (
    loopStartSeconds: number,
    loopEndSeconds: number,
    guideToneEnabled?: boolean,
  ) => void
  readonly pause: () => void
  readonly stop: (options?: { readonly navigateAfterSave?: boolean }) => Promise<void>
  readonly seek: (seconds: number) => void
  readonly setPlaybackRate: (rate: PlaybackRate) => void
  readonly setSelectedMicrophoneId: (deviceId: string) => void
  readonly setCaptureProfile: (profile: CaptureProfile) => void
}

export function usePracticeController(
  project: AppProject,
  onTakeSaved: (take: AppTake, navigateAfterSave: boolean) => Promise<void>,
): PracticeController {
  const [state, setState] = useState<ControllerState>({
    phase: 'idle',
    currentSeconds: 0,
    countdownSeconds: 0,
    points: [],
    failureMessage: null,
    noticeMessage: null,
    level: 0,
    appliedSettings: project.isSyntheticDemo
      ? ['Synthetic input trace · microphone not requested']
      : [],
    microphoneInputs: [],
    selectedMicrophoneId: null,
    supportedPlaybackRates: [1],
    playbackRate: 1,
    captureProfile: 'raw',
  })
  const runtime = useRef<ActiveRuntime | null>(null)
  const mediaUrl = useRef<{ url: string; revoke: () => void } | null>(null)
  const synthesizedReference = useRef<PreparedSynthesizedReference | null>(null)
  const points = useRef<AppPitchPoint[]>([])
  const animationFrame = useRef<number | null>(null)
  const loopEnd = useRef(project.referenceDurationSeconds)
  const finalizing = useRef<Promise<void> | null>(null)
  const recorderStarting = useRef<Promise<void> | null>(null)
  const pendingMicrophone = useRef<ReturnType<typeof requestMicrophone> | null>(null)
  const playbackAborted = useRef(false)
  const playbackFailureFinalizing = useRef(false)
  const attemptGeneration = useRef(0)
  const playbackFailureHandler = useRef<(failure: PlaybackFailure | null) => void>(() => undefined)
  const recordingFailureHandler = useRef<
    (active: ActiveRuntime, attemptId: number, message: string) => void
  >(() => undefined)
  const saved = useRef(false)
  const mounted = useRef(true)
  const projectForReferenceLoading = useRef(project)
  projectForReferenceLoading.current = project

  useEffect(() => {
    const loadingProject = projectForReferenceLoading.current
    mounted.current = true
    let cancelled = false
    const loadingFailed = (error: unknown) => {
      if (!cancelled) {
        setState((current) => ({
          ...current,
          phase: 'retry',
          failureMessage:
            error instanceof Error ? error.message : 'Backing audio could not be loaded.',
        }))
      }
    }

    if (usesSynthesizedReference(loadingProject)) {
      const timelineDurationSeconds = Math.max(
        loadingProject.referenceDurationSeconds,
        melodyReferenceDurationSeconds(loadingProject.notes, loadingProject.alignmentSeconds),
      )
      void renderMelodyReferenceInWorker({
        notes: loadingProject.notes,
        transpositionSemitones: loadingProject.transpositionSemitones,
        alignmentSeconds: loadingProject.alignmentSeconds,
        timelineDurationSeconds,
      })
        .then((bytes) => {
          if (cancelled) return
          synthesizedReference.current = { bytes }
          setState((current) => ({ ...current, phase: 'ready', failureMessage: null }))
        })
        .catch(loadingFailed)
    } else {
      void referenceAudioUrl(loadingProject)
        .then((result) => {
          if (cancelled) {
            result.revoke()
            return
          }
          mediaUrl.current = result
          setState((current) => ({ ...current, phase: 'ready', failureMessage: null }))
        })
        .catch(loadingFailed)
    }

    return () => {
      cancelled = true
      mounted.current = false
      if (animationFrame.current !== null) {
        cancelAnimationFrame(animationFrame.current)
        animationFrame.current = null
      }
      const detachedMediaUrl = mediaUrl.current
      mediaUrl.current = null
      synthesizedReference.current = null
      const active = runtime.current
      const recorderPhase = active?.recorder?.getSnapshot().phase ?? null
      const preservesFinalization =
        active !== null &&
        (recorderPhase === 'recording' ||
          recorderPhase === 'finalizing' ||
          finalizing.current !== null)
      if (preservesFinalization) active.allowPostSaveNavigation = false
      if (!preservesFinalization) {
        attemptGeneration.current += 1
        playbackAborted.current = true
      }
      const disposeUncommittedActive = () => {
        if (!active || runtime.current !== active) return
        runtime.current = null
        active.pipeline?.dispose()
        active.pipeline = null
        const activeStream = active.stream
        active.stream = null
        if (activeStream) stopStreamAndRefreshAudioRoute(activeStream)
        releaseAudioCapture(active)
        active.recorder?.dispose()
        active.recorder = null
        void active.writer?.abort().catch(() => undefined)
        active.writer = null
        active.assetId = null
        active.referenceMediaUrl?.revoke()
        if (detachedMediaUrl && detachedMediaUrl !== active.referenceMediaUrl) {
          detachedMediaUrl.revoke()
        }
        void active.player.dispose().catch(() => undefined)
        void active.context.close().catch(() => undefined)
      }
      if (recorderPhase === 'recording' && active?.recorder) {
        void active.recorder.interrupt('page-unloaded').catch(disposeUncommittedActive)
      } else if (!preservesFinalization) {
        disposeUncommittedActive()
      } else if (detachedMediaUrl && detachedMediaUrl !== active.referenceMediaUrl) {
        detachedMediaUrl.revoke()
      }
      if (!active) detachedMediaUrl?.revoke()
      recorderStarting.current = null
      const pending = pendingMicrophone.current
      pendingMicrophone.current = null
      void pending
        ?.then(({ stream }) => stopStreamAndRefreshAudioRoute(stream))
        .catch(() => undefined)
    }
  }, [
    project.alignmentSeconds,
    project.id,
    project.isSyntheticDemo,
    project.referenceAssetId,
    project.referenceDurationSeconds,
    project.targetMode,
    project.targetRevision,
    project.transpositionSemitones,
  ])

  const ensureRuntime = useCallback((): ActiveRuntime => {
    if (runtime.current) return runtime.current
    const synthesized = usesSynthesizedReference(project)
    const prepared = synthesizedReference.current
    if (synthesized && !prepared) {
      throw new Error('The local melody guide is still loading. Tap to retry.')
    }
    if (!synthesized && !mediaUrl.current) {
      throw new Error('Reference audio is still loading. Tap to retry.')
    }
    // Start creates the capture audio session before calling this function, so
    // Safari chooses the context's hardware format for simultaneous I/O rather
    // than changing it underneath an already-created context.
    const context = new AudioContext({ latencyHint: 'interactive' })
    let element: HTMLAudioElement | null = null
    let player: ReferencePlayback
    try {
      if (synthesized && prepared) {
        player = new SynthesizedReferencePlayer({
          context,
          buffer: createGeneratedPcmAudioBuffer(context, prepared.bytes),
          wakeLock: createBrowserWakeLockAdapter(navigator),
        })
      } else {
        element = new Audio()
        element.loop = false
        player = new ReferencePlayer({
          context,
          element,
          wakeLock: createBrowserWakeLockAdapter(navigator),
        })
        element.src = mediaUrl.current?.url ?? ''
      }
    } catch (error) {
      void context.close().catch(() => undefined)
      throw error
    }
    const value: ActiveRuntime = {
      context,
      element,
      player,
      referenceMediaUrl: synthesized ? null : mediaUrl.current,
      audioCaptureSession: null,
      stream: null,
      pipeline: null,
      recorder: null,
      writer: null,
      assetId: null,
      recordingMimeType: null,
      recordingStartSeconds: 0,
      recordingStartContextTime: null,
      recordingStopProjectSeconds: null,
      lastValidContextSeconds: null,
      lastValidProjectSeconds: null,
      playbackRate: 1,
      captureProfile: 'raw',
      captureSettings: null,
      recorderChunkCount: 0,
      recorderSmallestChunkBytes: null,
      recorderLargestChunkBytes: null,
      attemptId: 0,
      allowPostSaveNavigation: true,
    }
    player.subscribe((snapshot) => {
      if (snapshot.projectTimeSeconds !== null) {
        rememberProjectTime(value, snapshot.projectTimeSeconds, value.context.currentTime)
      }
      if (!mounted.current || !value.allowPostSaveNavigation || runtime.current !== value) return
      if (snapshot.phase === 'retry') playbackFailureHandler.current(snapshot.failure)
      const recorder = value.recorder
      if (snapshot.phase === 'playing' && recorder?.getSnapshot().phase === 'recording') {
        if (snapshot.message !== null && !recorder.pauseForBuffering()) {
          playbackFailureHandler.current('media-stalled')
        } else if (
          snapshot.message === null &&
          recorder.isPausedForBuffering() &&
          !recorder.resumeAfterBuffering()
        ) {
          playbackFailureHandler.current('media-stalled')
        }
      }
      setState((current) => ({
        ...current,
        countdownSeconds: snapshot.countdownRemainingSeconds,
        failureMessage:
          snapshot.phase === 'retry'
            ? current.phase === 'finalizing'
              ? current.failureMessage
              : snapshot.message
            : null,
        noticeMessage: snapshot.phase === 'retry' ? null : snapshot.message,
        phase:
          snapshot.phase === 'retry' && current.phase !== 'finalizing' ? 'retry' : current.phase,
      }))
    })
    runtime.current = value
    return value
  }, [project])

  const finishTake = useCallback(
    async (partialReason: string | null) => {
      if (finalizing.current) return finalizing.current
      finalizing.current = Promise.resolve()
        .then(async () => {
          const active = runtime.current
          if (!active) return
          if (saved.current || active.assetId === null) {
            releaseAudioCapture(active)
            return
          }
          saved.current = true
          if (mounted.current && active.allowPostSaveNavigation && runtime.current === active) {
            setState((current) => ({ ...current, phase: 'finalizing' }))
          }
          const endingSeconds =
            active.recordingStopProjectSeconds ??
            active.player.currentProjectTime() ??
            loopEnd.current
          const pipeline = active.pipeline
          const pipelineDiagnostics = pipeline
            ? await pipeline.drain().catch(() => pipeline.getDiagnostics())
            : null
          pipeline?.dispose()
          if (active.pipeline === pipeline) active.pipeline = null
          if (active.stream) {
            stopStreamAndRefreshAudioRoute(active.stream)
            active.stream = null
          }
          releaseAudioCapture(active)
          active.player.pause()
          const timelineDurationSeconds = Math.max(
            0.02,
            Math.min(loopEnd.current, endingSeconds) - active.recordingStartSeconds,
          )
          const recordedDurationSeconds = active.recorder?.getSnapshot().durationSeconds ?? 0
          const durationSeconds = Math.max(
            0.02,
            Math.min(
              15 * 60,
              recordedDurationSeconds > 0 ? recordedDurationSeconds : timelineDurationSeconds,
            ),
          )
          const take: AppTake = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            label: `Take ${project.takes.length + 1}`,
            projectStartSeconds: active.recordingStartSeconds,
            durationSeconds,
            audioAssetId: active.assetId,
            audioMimeType: active.recordingMimeType,
            partialReason,
            points: [...points.current],
            captureDiagnostics: {
              captureProfile: active.captureProfile,
              settings: active.captureSettings
                ? {
                    sampleRate: active.captureSettings.sampleRate,
                    channelCount: active.captureSettings.channelCount,
                    echoCancellation: active.captureSettings.echoCancellation,
                    noiseSuppression: active.captureSettings.noiseSuppression,
                    autoGainControl: active.captureSettings.autoGainControl,
                  }
                : null,
              playbackContextSampleRate: Number.isFinite(active.context.sampleRate)
                ? active.context.sampleRate
                : null,
              recorderChunkCount: active.recorderChunkCount,
              recorderSmallestChunkBytes: active.recorderSmallestChunkBytes,
              recorderLargestChunkBytes: active.recorderLargestChunkBytes,
              pcmSubmittedBatches: pipelineDiagnostics?.submittedBatches ?? 0,
              pcmProcessedBatches: pipelineDiagnostics?.processedBatches ?? 0,
              pcmDroppedBatches: pipelineDiagnostics?.droppedBatches ?? 0,
              pcmQueueHighWater: pipelineDiagnostics?.highWaterMark ?? 0,
              pcmAbandonedBatches: pipelineDiagnostics?.abandonedBatches ?? 0,
              pcmDrainTimedOut: pipelineDiagnostics?.drainTimedOut ?? false,
            },
          }
          active.recorder?.dispose()
          active.recorder = null
          active.writer = null
          active.assetId = null
          active.recordingMimeType = null
          active.recordingStartContextTime = null
          active.recordingStopProjectSeconds = null
          await active.player.dispose().catch(() => undefined)
          await active.context.close().catch(() => undefined)
          const navigateAfterSave = mounted.current && active.allowPostSaveNavigation
          if (!navigateAfterSave) active.referenceMediaUrl?.revoke()
          try {
            await onTakeSaved(take, navigateAfterSave)
          } finally {
            if (!mounted.current || !active.allowPostSaveNavigation) {
              active.referenceMediaUrl?.revoke()
            }
            if (runtime.current === active) runtime.current = null
          }
          if (navigateAfterSave && mounted.current && active.allowPostSaveNavigation) {
            setState((current) => ({ ...current, phase: 'paused' }))
          }
        })
        .finally(() => {
          finalizing.current = null
        })
      return finalizing.current
    },
    [onTakeSaved, project.takes.length],
  )

  playbackFailureHandler.current = (failure) => {
    if (playbackAborted.current || playbackFailureFinalizing.current) return
    const active = runtime.current
    const failedRecorder = active?.recorder ?? null
    const recorderPhase = failedRecorder?.getSnapshot().phase ?? null
    const preserveTake = recorderPhase === 'recording' || recorderPhase === 'finalizing'
    if (preserveTake) playbackFailureFinalizing.current = true
    else {
      playbackAborted.current = true
      attemptGeneration.current += 1
    }
    setState((current) => ({
      ...current,
      phase: preserveTake ? 'finalizing' : 'retry',
      failureMessage: preserveTake
        ? 'Reference audio paused; saving this take as a recoverable partial.'
        : current.failureMessage,
    }))
    if (animationFrame.current !== null) {
      cancelAnimationFrame(animationFrame.current)
      animationFrame.current = null
    }
    const pending = pendingMicrophone.current
    pendingMicrophone.current = null
    void pending
      ?.then(({ stream }) => stopStreamAndRefreshAudioRoute(stream))
      .catch(() => undefined)
    if (recorderPhase === 'recording' && failedRecorder && active) {
      void (async () => {
        const reason: RecordingInterruption =
          failure === 'context-interrupted'
            ? 'audio-context-interrupted'
            : failure === 'media-ended'
              ? 'reference-ended'
              : failure === 'route-lost'
                ? 'route-lost'
                : 'reference-stalled'
        await failedRecorder.interrupt(reason).catch((error: unknown) => {
          playbackFailureFinalizing.current = false
          recordingFailureHandler.current(
            active,
            active.attemptId,
            error instanceof Error ? error.message : 'The interrupted take could not be saved.',
          )
        })
      })()
    } else if (!preserveTake) {
      active?.pipeline?.dispose()
      if (active) active.pipeline = null
      if (active?.stream) {
        stopStreamAndRefreshAudioRoute(active.stream)
        active.stream = null
      }
      failedRecorder?.dispose()
      if (active?.recorder === failedRecorder) active.recorder = null
      if (active) releaseAudioCapture(active)
      const failedWriter = active?.writer ?? null
      if (active?.writer === failedWriter) active.writer = null
      void failedWriter?.abort().catch(() => undefined)
    }
  }

  recordingFailureHandler.current = (active, attemptId, message) => {
    if (
      playbackAborted.current ||
      active.attemptId !== attemptId ||
      attemptGeneration.current !== attemptId
    ) {
      return
    }
    playbackAborted.current = true
    attemptGeneration.current += 1
    const ownsUi = mounted.current && active.allowPostSaveNavigation && runtime.current === active
    if (animationFrame.current !== null) {
      cancelAnimationFrame(animationFrame.current)
      animationFrame.current = null
    }
    active.player.pause()
    active.pipeline?.dispose()
    active.pipeline = null
    if (active.stream) stopStreamAndRefreshAudioRoute(active.stream)
    active.stream = null
    releaseAudioCapture(active)
    active.recorder?.dispose()
    active.recorder = null
    // ForegroundRecorder owns aborting its sink for native and start failures.
    active.writer = null
    active.assetId = null
    active.recordingMimeType = null
    active.recordingStartContextTime = null
    active.recordingStopProjectSeconds = null
    if (runtime.current === active) runtime.current = null
    void active.player.dispose().catch(() => undefined)
    void active.context.close().catch(() => undefined)
    if (!active.allowPostSaveNavigation) active.referenceMediaUrl?.revoke()
    if (ownsUi) {
      setState((current) => ({
        ...current,
        phase: 'retry',
        failureMessage: message,
        noticeMessage: null,
      }))
    }
  }

  const prepareRecorder = useCallback(
    async (
      active: ActiveRuntime,
      stream: MediaStream,
      settings: CaptureSettings | null,
      attemptId: number,
    ): Promise<boolean> => {
      const mimeType = selectRecorderMimeType() ?? undefined
      const assetId = crypto.randomUUID()
      const store = await getBinaryStore()
      if (attemptGeneration.current !== attemptId) return false
      const writer = new RecordingAssetWriter(
        getDatabase(),
        store,
        project.id,
        assetId,
        mimeType ?? 'audio/mp4',
      )
      await writer.begin()
      if (attemptGeneration.current !== attemptId) {
        await writer.abort()
        return false
      }
      active.attemptId = attemptId
      active.assetId = assetId
      active.recordingMimeType = mimeType ?? 'audio/mp4'
      active.writer = writer
      const recorder = new ForegroundRecorder({
        stream,
        clock: active.context,
        mimeType,
        captureSettings: settings,
        limits: { maxBytes: 48 * 1024 * 1024, maxDurationSeconds: 15 * 60 },
        sink: {
          append: async (chunk) => {
            active.recorderChunkCount += 1
            active.recorderSmallestChunkBytes =
              active.recorderSmallestChunkBytes === null
                ? chunk.size
                : Math.min(active.recorderSmallestChunkBytes, chunk.size)
            active.recorderLargestChunkBytes =
              active.recorderLargestChunkBytes === null
                ? chunk.size
                : Math.max(active.recorderLargestChunkBytes, chunk.size)
            await writer.appendOneSecondChunk(chunk)
          },
          commit: async ({ mimeType: actualMime, partialReason }) => {
            if (active.attemptId === attemptId) active.recordingMimeType = actualMime
            const reason = interruptionForWriter(partialReason)
            if (reason === 'none') await writer.finalize(false, reason)
            else await writer.finalizeInterrupted(reason)
          },
          abort: async () => writer.abort(),
        },
      })
      recorder.subscribe((snapshot) => {
        if (snapshot.phase === 'finalizing') {
          if (animationFrame.current !== null) {
            cancelAnimationFrame(animationFrame.current)
            animationFrame.current = null
          }
          if (mounted.current && active.allowPostSaveNavigation && runtime.current === active) {
            setState((current) => ({ ...current, phase: 'finalizing' }))
          }
          active.recordingStopProjectSeconds ??=
            active.player.currentProjectTime() ?? fallbackProjectTime(active)
          const draining = active.pipeline?.drain()
          if (draining) {
            void draining.then(
              () => active.player.pause(),
              () => active.player.pause(),
            )
          } else {
            active.player.pause()
          }
        }
        if (snapshot.phase === 'complete') void finishTake(snapshot.partialReason)
        if (snapshot.phase === 'error') {
          recordingFailureHandler.current(
            active,
            attemptId,
            snapshot.error ?? 'Recording failed. Tap to retry.',
          )
        }
      })
      active.recorder = recorder
      return true
    },
    [finishTake, project.id],
  )

  const startClock = useCallback(
    (
      active: ActiveRuntime,
      microphonePromise: Promise<Awaited<ReturnType<typeof requestMicrophone>>> | null,
      loopStartSeconds: number,
      attemptId: number,
    ) => {
      const mock = project.isSyntheticDemo ? createMockPitchTrace(project.notes) : null
      let mockIndex = 0
      let audibleStarted = false
      let captureStarted = false
      let captureReady = false
      let captureFailed = false
      let mockDestination: MediaStreamAudioDestinationNode | null = null
      const isCurrentAttempt = () =>
        attemptGeneration.current === attemptId && !playbackAborted.current

      const captureFailure = (error: unknown) => {
        if (!isCurrentAttempt()) return
        captureFailed = true
        playbackAborted.current = true
        attemptGeneration.current += 1
        active.player.pause()
        active.pipeline?.dispose()
        active.pipeline = null
        if (active.stream) {
          stopStreamAndRefreshAudioRoute(active.stream)
          active.stream = null
        }
        releaseAudioCapture(active)
        void active.writer?.abort().catch(() => undefined)
        setState((current) => ({
          ...current,
          phase: 'retry',
          failureMessage:
            error instanceof DOMException && error.name === 'NotAllowedError'
              ? 'Microphone permission was denied. Allow it in Safari settings, then tap to retry.'
              : error instanceof Error
                ? error.message
                : 'Microphone could not start.',
        }))
      }

      const prepareCapture = async () => {
        if (mock) {
          const destination = active.context.createMediaStreamDestination()
          if (!isCurrentAttempt()) {
            stopStreamAndRefreshAudioRoute(destination.stream)
            return
          }
          mockDestination = destination
          active.stream = destination.stream
          captureReady = await prepareRecorder(active, destination.stream, null, attemptId)
          return
        }
        if (!microphonePromise) throw new Error('Microphone capture is unavailable.')
        const { stream, settings, inputs } = await microphonePromise
        if (pendingMicrophone.current === microphonePromise) pendingMicrophone.current = null
        if (!isCurrentAttempt()) {
          stopStreamAndRefreshAudioRoute(stream)
          return
        }
        // getUserMedia can replace Safari's native route; restore the mixed route
        // before connecting capture and making the reference audible.
        active.audioCaptureSession?.reassert()
        // Own the stream before the first AudioWorklet await so project changes or
        // unmount cleanup can always stop it.
        active.stream = stream
        active.captureSettings = settings
        let pipeline: PcmCapturePipeline
        try {
          const source = active.context.createMediaStreamSource(stream)
          pipeline = await PcmCapturePipeline.create(active.context, source, {
            onLevel: (rms, peak) => {
              if (
                !captureStarted ||
                active.recorder?.isPausedForBuffering() ||
                !isCurrentAttempt() ||
                !mounted.current ||
                !active.allowPostSaveNavigation ||
                runtime.current !== active
              ) {
                return
              }
              setState((current) => ({ ...current, level: Math.max(rms * 5, peak) }))
            },
            onGap: (contextTimeSeconds) => {
              if (
                !captureStarted ||
                active.recordingStartContextTime === null ||
                contextTimeSeconds < active.recordingStartContextTime ||
                active.recorder?.isPausedForBuffering() ||
                !isCurrentAttempt()
              ) {
                return
              }
              const timeSeconds = active.player.currentProjectTime(contextTimeSeconds)
              if (timeSeconds !== null) {
                rememberProjectTime(active, timeSeconds, contextTimeSeconds)
              }
              points.current.push({
                timeSeconds: timeSeconds ?? fallbackProjectTime(active, contextTimeSeconds),
                contextTimeSeconds,
                candidateHz: null,
                frequencyHz: null,
                midiNote: null,
                confidence: null,
                rms: 0,
                peak: 0,
                gapReason: timeSeconds === null ? 'timeline-gap' : 'queue-overflow',
                detectorVersion: DETECTOR_VERSION,
              })
            },
            onPitchCandidate: (candidate) => {
              if (
                !captureStarted ||
                active.recordingStartContextTime === null ||
                candidate.contextTimeSeconds < active.recordingStartContextTime ||
                active.recorder?.isPausedForBuffering() ||
                !isCurrentAttempt()
              ) {
                return
              }
              const timeSeconds = active.player.currentProjectTime(candidate.contextTimeSeconds)
              if (timeSeconds !== null) {
                rememberProjectTime(active, timeSeconds, candidate.contextTimeSeconds)
              }
              const frequencyHz =
                timeSeconds !== null && candidate.scorable && !candidate.analysisGap
                  ? candidate.frequencyHz
                  : null
              points.current.push({
                timeSeconds:
                  timeSeconds ?? fallbackProjectTime(active, candidate.contextTimeSeconds),
                contextTimeSeconds: candidate.contextTimeSeconds,
                candidateHz: candidate.frequencyHz,
                frequencyHz,
                midiNote: frequencyHz === null ? null : frequencyToMidi(frequencyHz),
                confidence: candidate.confidence,
                rms: candidate.rms,
                peak: candidate.peak,
                gapReason: pitchCandidateGapReason(
                  candidate,
                  timeSeconds !== null,
                  frequencyHz !== null,
                ),
                detectorVersion: DETECTOR_VERSION,
              })
            },
          })
        } catch (error) {
          if (active.stream === stream) active.stream = null
          stopStreamAndRefreshAudioRoute(stream)
          throw error
        }
        if (!isCurrentAttempt()) {
          pipeline.dispose()
          if (active.stream === stream) active.stream = null
          stopStreamAndRefreshAudioRoute(stream)
          return
        }
        active.pipeline = pipeline
        setState((current) => ({
          ...current,
          microphoneInputs: inputs,
          selectedMicrophoneId: settings.deviceId,
          appliedSettings: settingLabels(settings),
        }))
        captureReady = await prepareRecorder(active, stream, settings, attemptId)
        if (!captureReady) {
          pipeline.dispose()
          if (active.pipeline === pipeline) active.pipeline = null
          if (active.stream === stream) active.stream = null
          stopStreamAndRefreshAudioRoute(stream)
        }
      }

      recorderStarting.current = prepareCapture().catch(captureFailure)

      const tick = () => {
        if (!isCurrentAttempt() || captureFailed) return
        const remaining = active.player.updateCountdown()
        if (remaining > 0) {
          if (mounted.current)
            setState((current) => ({ ...current, phase: 'countdown', countdownSeconds: remaining }))
          animationFrame.current = requestAnimationFrame(tick)
          return
        }
        if (!audibleStarted) {
          if (!captureReady) {
            if (mounted.current) {
              setState((current) => ({ ...current, phase: 'countdown', countdownSeconds: 0 }))
            }
            animationFrame.current = requestAnimationFrame(tick)
            return
          }
          if (!active.player.beginAudible(loopStartSeconds)) {
            if (active.player.getSnapshot().phase !== 'retry') {
              animationFrame.current = requestAnimationFrame(tick)
            }
            return
          }
          const recorder = active.recorder
          if (recorder?.getSnapshot().phase !== 'ready') {
            captureFailure(new Error('Recorder preparation did not complete.'))
            return
          }
          active.recordingStartSeconds = loopStartSeconds
          const recordingStartContextTime = active.context.currentTime
          try {
            recorder.startFromGesture()
          } catch (error) {
            recordingFailureHandler.current(
              active,
              attemptId,
              error instanceof Error ? error.message : 'Recording could not start.',
            )
            return
          }
          active.recordingStartContextTime = recordingStartContextTime
          captureStarted = true
          audibleStarted = true
          setState((current) => ({ ...current, phase: 'recording', countdownSeconds: 0 }))
          if (mock && mockDestination) {
            for (const note of project.notes) {
              const oscillator = active.context.createOscillator()
              const gain = active.context.createGain()
              oscillator.frequency.value = 440 * 2 ** ((note.midiNote - 69) / 12)
              gain.gain.value = 0.18
              oscillator.connect(gain).connect(mockDestination)
              const now = active.context.currentTime
              oscillator.start(now + Math.max(0, note.startSeconds - loopStartSeconds))
              oscillator.stop(now + Math.max(0.05, note.endSeconds - loopStartSeconds))
            }
          }
        }

        if (active.player.reanchorIfDrifted()) {
          points.current.push({
            timeSeconds: active.element ? fallbackProjectTime(active) : state.currentSeconds,
            contextTimeSeconds: active.context.currentTime,
            candidateHz: null,
            frequencyHz: null,
            midiNote: null,
            confidence: null,
            rms: 0,
            peak: 0,
            gapReason: 'timeline-gap',
            detectorVersion: DETECTOR_VERSION,
          })
        }
        const mappedCurrentSeconds = active.player.currentProjectTime()
        if (mappedCurrentSeconds !== null) {
          rememberProjectTime(active, mappedCurrentSeconds, active.context.currentTime)
        }
        const currentSeconds = mappedCurrentSeconds ?? state.currentSeconds
        if (mock) {
          while (
            mockIndex < mock.length &&
            (mock[mockIndex]?.timeSeconds ?? Infinity) <= currentSeconds
          ) {
            const point = mock[mockIndex]
            if (point) points.current.push(point)
            mockIndex += 1
          }
        }
        const latest = points.current.at(-1)
        if (mounted.current) {
          setState((current) => ({
            ...current,
            currentSeconds,
            points: [...points.current],
            level: latest?.rms ? Math.min(1, latest.rms * 5) : current.level,
          }))
        }
        if (currentSeconds >= loopEnd.current) {
          void (async () => {
            if (active.recorder?.getSnapshot().phase === 'recording') await active.recorder.stop()
            else await finishTake(null)
          })()
          return
        }
        animationFrame.current = requestAnimationFrame(tick)
      }
      animationFrame.current = requestAnimationFrame(tick)
    },
    [finishTake, prepareRecorder, project.isSyntheticDemo, project.notes, state.currentSeconds],
  )

  const start = useCallback(
    (loopStartSeconds: number, loopEndSeconds: number, guideToneEnabled = false) => {
      if (finalizing.current) return
      let startingActive: ActiveRuntime | null = null
      let startingAttemptId: number | null = null
      let startingMicrophone: ReturnType<typeof requestMicrophone> | null = null
      let startingActivation: Promise<void> | null = null
      let unownedAudioCaptureSession: AudioCaptureSession | null = null
      const abortStartingAttempt = () => {
        const active = startingActive
        const attemptId = startingAttemptId
        if (!active || attemptId === null || attemptGeneration.current !== attemptId) return
        playbackAborted.current = true
        attemptGeneration.current += 1
        active.player.pause()
        const microphone = startingMicrophone
        if (pendingMicrophone.current === microphone) pendingMicrophone.current = null
        void microphone
          ?.then(({ stream }) => stopStreamAndRefreshAudioRoute(stream))
          .catch(() => undefined)
        void startingActivation?.catch(() => undefined)
        releaseAudioCapture(active)
      }

      try {
        const previous = runtime.current
        const previousRecorderPhase = previous?.recorder?.getSnapshot().phase ?? null
        if (previousRecorderPhase === 'recording' || previousRecorderPhase === 'finalizing') {
          setState((current) => ({ ...current, phase: 'finalizing' }))
          return
        }
        if (previous) {
          runtime.current = null
          previous.pipeline?.dispose()
          previous.pipeline = null
          if (previous.stream) stopStreamAndRefreshAudioRoute(previous.stream)
          previous.stream = null
          releaseAudioCapture(previous)
          previous.recorder?.dispose()
          previous.recorder = null
          if (previous.writer && previousRecorderPhase !== 'complete') {
            void previous.writer.abort().catch(() => undefined)
          }
          previous.writer = null
          previous.assetId = null
          void previous.player.dispose().catch(() => undefined)
          void previous.context.close().catch(() => undefined)
        }
        saved.current = false
        playbackAborted.current = false
        playbackFailureFinalizing.current = false
        points.current = []
        loopEnd.current = loopEndSeconds
        if (project.isSyntheticDemo) prepareBrowserAudioPlayback()
        else unownedAudioCaptureSession = beginBrowserAudioCapture()
        const active = ensureRuntime()
        startingActive = active
        const attemptId = ++attemptGeneration.current
        startingAttemptId = attemptId
        active.recordingStartContextTime = null
        active.recordingStopProjectSeconds = null
        active.lastValidContextSeconds = null
        active.lastValidProjectSeconds = null
        active.playbackRate = state.playbackRate
        active.captureProfile = state.captureProfile
        active.captureSettings = null
        active.recorderChunkCount = 0
        active.recorderSmallestChunkBytes = null
        active.recorderLargestChunkBytes = null
        active.allowPostSaveNavigation = true
        releaseAudioCapture(active)
        active.audioCaptureSession = unownedAudioCaptureSession
        unownedAudioCaptureSession = null
        const microphonePromise = project.isSyntheticDemo
          ? null
          : requestMicrophone({
              profile: state.captureProfile,
              ...(state.selectedMicrophoneId ? { deviceId: state.selectedMicrophoneId } : {}),
            })
        startingMicrophone = microphonePromise
        pendingMicrophone.current = microphonePromise
        // This call intentionally starts synchronously inside the click handler.
        const activation = active.player.activateFromGesture({
          loopStartSeconds,
          loopEndSeconds,
          countdownSeconds: 3,
          playbackRate: state.playbackRate,
        })
        startingActivation = activation
        if (guideToneEnabled) {
          const guideNote = project.notes.find(
            (note) => loopStartSeconds <= note.endSeconds + project.alignmentSeconds,
          )
          if (guideNote) {
            const oscillator = active.context.createOscillator()
            const gain = active.context.createGain()
            const now = active.context.currentTime
            oscillator.frequency.value =
              440 * 2 ** ((guideNote.midiNote + project.transpositionSemitones - 69) / 12)
            gain.gain.setValueAtTime(0, now)
            gain.gain.linearRampToValueAtTime(0.18, now + 0.025)
            gain.gain.setValueAtTime(0.18, now + 0.3)
            gain.gain.linearRampToValueAtTime(0, now + 0.4)
            oscillator.connect(gain).connect(active.context.destination)
            oscillator.start(now)
            oscillator.stop(now + 0.42)
          }
        }
        setState((current) => ({
          ...current,
          phase: 'countdown',
          failureMessage: null,
          noticeMessage: null,
          points: [],
        }))
        void activation
          .then(() => startClock(active, microphonePromise, loopStartSeconds, attemptId))
          .catch((error: unknown) => {
            if (attemptGeneration.current !== attemptId) return
            abortStartingAttempt()
            if (error instanceof DOMException && error.name === 'AbortError') return
            setState((current) => ({
              ...current,
              phase: 'retry',
              failureMessage: error instanceof Error ? error.message : 'Playback could not start.',
            }))
          })
      } catch (error) {
        unownedAudioCaptureSession?.release()
        unownedAudioCaptureSession = null
        abortStartingAttempt()
        setState((current) => ({
          ...current,
          phase: 'retry',
          failureMessage: error instanceof Error ? error.message : 'Practice could not start.',
        }))
      }
    },
    [
      ensureRuntime,
      project.alignmentSeconds,
      project.isSyntheticDemo,
      project.notes,
      project.transpositionSemitones,
      startClock,
      state.captureProfile,
      state.playbackRate,
      state.selectedMicrophoneId,
    ],
  )

  const stop = useCallback(
    async (options?: { readonly navigateAfterSave?: boolean }) => {
      const active = runtime.current
      if (options?.navigateAfterSave === false && active) {
        active.allowPostSaveNavigation = false
      }
      if (finalizing.current) {
        await finalizing.current
        return
      }
      if (animationFrame.current !== null) {
        cancelAnimationFrame(animationFrame.current)
        animationFrame.current = null
      }
      const pending = pendingMicrophone.current
      pendingMicrophone.current = null
      void pending
        ?.then(({ stream }) => stopStreamAndRefreshAudioRoute(stream))
        .catch(() => undefined)
      if (!active) return
      const recorderPhase = active.recorder?.getSnapshot().phase ?? null
      if (recorderPhase === 'recording' || recorderPhase === 'finalizing') {
        setState((current) => ({ ...current, phase: 'finalizing' }))
        try {
          await active.recorder?.stop()
          await finishTake(active.recorder?.getSnapshot().partialReason ?? null)
        } finally {
          attemptGeneration.current += 1
          playbackAborted.current = true
        }
        return
      }

      attemptGeneration.current += 1
      playbackAborted.current = true
      active.player.pause()
      active.pipeline?.dispose()
      active.pipeline = null
      active.recorder?.dispose()
      active.recorder = null
      if (active.stream) stopStreamAndRefreshAudioRoute(active.stream)
      active.stream = null
      await active.writer?.abort().catch(() => undefined)
      active.writer = null
      active.assetId = null
      recorderStarting.current = null
      setState((current) => ({ ...current, phase: 'idle' }))
      releaseAudioCapture(active)
    },
    [finishTake],
  )

  const pause = useCallback(() => {
    void stop()
  }, [stop])

  const seek = useCallback((seconds: number) => {
    if (finalizing.current) return
    runtime.current?.player.seek(seconds)
    setState((current) => ({ ...current, currentSeconds: seconds }))
  }, [])

  const setPlaybackRate = useCallback((playbackRate: PlaybackRate) => {
    const active = runtime.current
    active?.player.setPlaybackRate(playbackRate)
    if (active) active.playbackRate = playbackRate
    setState((current) => ({ ...current, playbackRate }))
  }, [])

  return useMemo(
    () => ({
      ...state,
      start,
      pause,
      stop,
      seek,
      setPlaybackRate,
      setSelectedMicrophoneId: (selectedMicrophoneId: string) =>
        setState((current) => ({ ...current, selectedMicrophoneId })),
      setCaptureProfile: (captureProfile: CaptureProfile) =>
        setState((current) => ({ ...current, captureProfile })),
    }),
    [pause, seek, setPlaybackRate, start, state, stop],
  )
}

export function currentPitchLabel(points: readonly AppPitchPoint[]): {
  note: string | null
  frequencyHz: number | null
  confidence: number | null
} {
  const point = points.at(-1)
  return {
    note:
      point?.midiNote === null || point?.midiNote === undefined
        ? null
        : midiNoteName(point.midiNote),
    frequencyHz: point?.frequencyHz ?? null,
    confidence: point?.confidence ?? null,
  }
}
