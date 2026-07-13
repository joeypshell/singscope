import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ForegroundRecorder,
  PcmCapturePipeline,
  ReferencePlayer,
  createBrowserWakeLockAdapter,
  requestMicrophone,
  selectRecorderMimeType,
  stopMediaStream,
  type CaptureProfile,
  type CaptureSettings,
  type PlaybackRate,
  type RecordingInterruption,
} from '../audio/runtime'
import { frequencyToMidi, midiNoteName } from '../domain'
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
  readonly element: HTMLAudioElement
  readonly player: ReferencePlayer
  stream: MediaStream | null
  pipeline: PcmCapturePipeline | null
  recorder: ForegroundRecorder | null
  writer: RecordingAssetWriter | null
  assetId: string | null
  recordingMimeType: string | null
  recordingStartSeconds: number
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
  readonly stop: () => Promise<void>
  readonly seek: (seconds: number) => void
  readonly setPlaybackRate: (rate: PlaybackRate) => void
  readonly setSelectedMicrophoneId: (deviceId: string) => void
  readonly setCaptureProfile: (profile: CaptureProfile) => void
}

export function usePracticeController(
  project: AppProject,
  onTakeSaved: (take: AppTake) => void,
): PracticeController {
  const [state, setState] = useState<ControllerState>({
    phase: 'idle',
    currentSeconds: 0,
    countdownSeconds: 0,
    points: [],
    failureMessage: null,
    level: 0,
    appliedSettings: project.isSyntheticDemo
      ? ['Synthetic input trace · microphone not requested']
      : [],
    microphoneInputs: [],
    selectedMicrophoneId: null,
    supportedPlaybackRates: [1],
    playbackRate: 1,
    captureProfile: 'echo-reduced',
  })
  const runtime = useRef<ActiveRuntime | null>(null)
  const mediaUrl = useRef<{ url: string; revoke: () => void } | null>(null)
  const points = useRef<AppPitchPoint[]>([])
  const animationFrame = useRef<number | null>(null)
  const loopEnd = useRef(project.referenceDurationSeconds)
  const finalizing = useRef<Promise<void> | null>(null)
  const recorderStarting = useRef<Promise<void> | null>(null)
  const saved = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void referenceAudioUrl(project)
      .then((result) => {
        if (!mounted.current) {
          result.revoke()
          return
        }
        mediaUrl.current = result
        setState((current) => ({ ...current, phase: 'ready', failureMessage: null }))
      })
      .catch((error: unknown) => {
        setState((current) => ({
          ...current,
          phase: 'retry',
          failureMessage:
            error instanceof Error ? error.message : 'Backing audio could not be loaded.',
        }))
      })
    return () => {
      mounted.current = false
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current)
      mediaUrl.current?.revoke()
      mediaUrl.current = null
      const active = runtime.current
      if (active?.recorder?.getSnapshot().phase === 'recording')
        void active.recorder.interrupt('page-unloaded')
      active?.pipeline?.dispose()
      if (active?.stream) stopMediaStream(active.stream)
      if (active) {
        void active.player.dispose()
        void active.context.close()
      }
      runtime.current = null
      recorderStarting.current = null
    }
  }, [project])

  const ensureRuntime = useCallback((): ActiveRuntime => {
    if (runtime.current) return runtime.current
    if (!mediaUrl.current) throw new Error('Reference audio is still loading. Tap to retry.')
    const context = new AudioContext({ latencyHint: 'interactive' })
    const element = new Audio(mediaUrl.current.url)
    element.loop = false
    const player = new ReferencePlayer({
      context,
      element,
      wakeLock: createBrowserWakeLockAdapter(navigator),
    })
    const value: ActiveRuntime = {
      context,
      element,
      player,
      stream: null,
      pipeline: null,
      recorder: null,
      writer: null,
      assetId: null,
      recordingMimeType: null,
      recordingStartSeconds: 0,
    }
    player.subscribe((snapshot) => {
      if (!mounted.current) return
      setState((current) => ({
        ...current,
        countdownSeconds: snapshot.countdownRemainingSeconds,
        failureMessage: snapshot.message,
        phase: snapshot.phase === 'retry' ? 'retry' : current.phase,
      }))
    })
    runtime.current = value
    return value
  }, [])

  const finishTake = useCallback(
    async (partialReason: string | null) => {
      if (finalizing.current) return finalizing.current
      finalizing.current = Promise.resolve()
        .then(() => {
          const active = runtime.current
          if (!active || saved.current || active.assetId === null) return
          saved.current = true
          setState((current) => ({ ...current, phase: 'finalizing' }))
          active.pipeline?.dispose()
          active.pipeline = null
          if (active.stream) {
            stopMediaStream(active.stream)
            active.stream = null
          }
          const endingSeconds = active.player.currentProjectTime() ?? loopEnd.current
          active.player.pause()
          const durationSeconds = Math.max(
            0.02,
            Math.min(loopEnd.current, endingSeconds) - active.recordingStartSeconds,
          )
          const take: AppTake = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            label: `Take ${project.takes.length + 1}`,
            durationSeconds,
            audioAssetId: active.assetId,
            audioMimeType: active.recordingMimeType,
            partialReason,
            points: [...points.current],
          }
          onTakeSaved(take)
          if (mounted.current) setState((current) => ({ ...current, phase: 'paused' }))
        })
        .finally(() => {
          finalizing.current = null
        })
      return finalizing.current
    },
    [onTakeSaved, project.takes.length],
  )

  const beginRecorder = useCallback(
    async (active: ActiveRuntime, stream: MediaStream, settings: CaptureSettings | null) => {
      const mimeType = selectRecorderMimeType() ?? undefined
      const assetId = crypto.randomUUID()
      const store = await getBinaryStore()
      const writer = new RecordingAssetWriter(
        getDatabase(),
        store,
        project.id,
        assetId,
        mimeType ?? 'audio/mp4',
      )
      await writer.begin()
      active.assetId = assetId
      active.recordingMimeType = mimeType ?? 'audio/mp4'
      active.writer = writer
      active.recordingStartSeconds = active.player.currentProjectTime() ?? 0
      const recorder = new ForegroundRecorder({
        stream,
        clock: active.context,
        mimeType,
        captureSettings: settings,
        limits: { maxBytes: 48 * 1024 * 1024, maxDurationSeconds: 15 * 60 },
        sink: {
          append: async (chunk) => {
            await writer.appendOneSecondChunk(chunk)
          },
          commit: async ({ mimeType: actualMime, partialReason }) => {
            active.recordingMimeType = actualMime
            const reason = interruptionForWriter(partialReason)
            if (reason === 'none') await writer.finalize(false, reason)
            else await writer.finalizeInterrupted(reason)
          },
          abort: async () => writer.abort(),
        },
      })
      recorder.subscribe((snapshot) => {
        if (snapshot.phase === 'complete') void finishTake(snapshot.partialReason)
        if (snapshot.phase === 'error' && mounted.current) {
          setState((current) => ({ ...current, phase: 'retry', failureMessage: snapshot.error }))
        }
      })
      active.recorder = recorder
      recorder.startFromGesture()
    },
    [finishTake, project.id],
  )

  const startClock = useCallback(
    (
      active: ActiveRuntime,
      microphonePromise: Promise<Awaited<ReturnType<typeof requestMicrophone>>> | null,
    ) => {
      const mock = project.isSyntheticDemo ? createMockPitchTrace(project.notes) : null
      let mockIndex = 0
      let audibleStarted = false
      const tick = () => {
        const remaining = active.player.updateCountdown()
        if (remaining > 0) {
          if (mounted.current)
            setState((current) => ({ ...current, phase: 'countdown', countdownSeconds: remaining }))
          animationFrame.current = requestAnimationFrame(tick)
          return
        }
        if (!audibleStarted) {
          audibleStarted = true
          const startSeconds = active.player.currentProjectTime() ?? 0
          active.player.beginAudible(startSeconds)
          setState((current) => ({ ...current, phase: 'recording', countdownSeconds: 0 }))
          if (mock) {
            const destination = active.context.createMediaStreamDestination()
            for (const note of project.notes) {
              const oscillator = active.context.createOscillator()
              const gain = active.context.createGain()
              oscillator.frequency.value = 440 * 2 ** ((note.midiNote - 69) / 12)
              gain.gain.value = 0.18
              oscillator.connect(gain).connect(destination)
              const now = active.context.currentTime
              oscillator.start(now + Math.max(0, note.startSeconds - startSeconds))
              oscillator.stop(now + Math.max(0.05, note.endSeconds - startSeconds))
            }
            active.stream = destination.stream
            recorderStarting.current = beginRecorder(active, destination.stream, null).catch(
              (error: unknown) => {
                setState((current) => ({
                  ...current,
                  phase: 'retry',
                  failureMessage:
                    error instanceof Error ? error.message : 'Synthetic recording failed.',
                }))
              },
            )
          } else if (microphonePromise) {
            recorderStarting.current = microphonePromise
              .then(async ({ stream, settings, inputs }) => {
                active.stream = stream
                setState((current) => ({
                  ...current,
                  microphoneInputs: inputs,
                  selectedMicrophoneId: settings.deviceId,
                  appliedSettings: settingLabels(settings),
                }))
                const source = active.context.createMediaStreamSource(stream)
                active.pipeline = await PcmCapturePipeline.create(active.context, source, {
                  onLevel: (rms, peak) =>
                    setState((current) => ({ ...current, level: Math.max(rms * 5, peak) })),
                  onGap: (contextTimeSeconds) => {
                    const timeSeconds = active.player.currentProjectTime(contextTimeSeconds)
                    points.current.push({
                      timeSeconds:
                        timeSeconds ??
                        (Number.isFinite(active.element.currentTime)
                          ? active.element.currentTime
                          : 0),
                      contextTimeSeconds,
                      candidateHz: null,
                      frequencyHz: null,
                      midiNote: null,
                      confidence: null,
                      rms: 0,
                      peak: 0,
                      gapReason: timeSeconds === null ? 'timeline-gap' : 'queue-overflow',
                      detectorVersion: 'yin-24k-v1',
                    })
                  },
                  onPitchCandidate: (candidate) => {
                    const timeSeconds = active.player.currentProjectTime(
                      candidate.contextTimeSeconds,
                    )
                    const frequencyHz =
                      timeSeconds !== null && candidate.scorable && !candidate.analysisGap
                        ? candidate.frequencyHz
                        : null
                    points.current.push({
                      timeSeconds:
                        timeSeconds ??
                        (Number.isFinite(active.element.currentTime)
                          ? active.element.currentTime
                          : 0),
                      contextTimeSeconds: candidate.contextTimeSeconds,
                      candidateHz: candidate.frequencyHz,
                      frequencyHz,
                      midiNote: frequencyHz === null ? null : frequencyToMidi(frequencyHz),
                      confidence: candidate.confidence,
                      rms: candidate.rms,
                      peak: candidate.peak,
                      gapReason:
                        timeSeconds === null
                          ? 'timeline-gap'
                          : frequencyHz === null
                            ? candidate.frequencyHz === null
                              ? 'silence'
                              : 'below-confidence'
                            : null,
                      detectorVersion: 'yin-24k-v1',
                    })
                  },
                })
                await beginRecorder(active, stream, settings)
              })
              .catch((error: unknown) => {
                active.player.pause()
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
              })
          }
        }

        if (active.player.reanchorIfDrifted()) {
          points.current.push({
            timeSeconds: Number.isFinite(active.element.currentTime)
              ? active.element.currentTime
              : state.currentSeconds,
            contextTimeSeconds: active.context.currentTime,
            candidateHz: null,
            frequencyHz: null,
            midiNote: null,
            confidence: null,
            rms: 0,
            peak: 0,
            gapReason: 'timeline-gap',
            detectorVersion: 'yin-24k-v1',
          })
        }
        const currentSeconds = active.player.currentProjectTime() ?? state.currentSeconds
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
            await recorderStarting.current
            if (active.recorder?.getSnapshot().phase === 'recording') await active.recorder.stop()
            else await finishTake(null)
          })()
          return
        }
        animationFrame.current = requestAnimationFrame(tick)
      }
      animationFrame.current = requestAnimationFrame(tick)
    },
    [beginRecorder, finishTake, project.isSyntheticDemo, project.notes, state.currentSeconds],
  )

  const start = useCallback(
    (loopStartSeconds: number, loopEndSeconds: number, guideToneEnabled = false) => {
      try {
        saved.current = false
        points.current = []
        loopEnd.current = loopEndSeconds
        const active = ensureRuntime()
        const microphonePromise = project.isSyntheticDemo
          ? null
          : requestMicrophone({
              profile: state.captureProfile,
              ...(state.selectedMicrophoneId ? { deviceId: state.selectedMicrophoneId } : {}),
            })
        // This call intentionally starts synchronously inside the click handler.
        const activation = active.player.activateFromGesture({
          loopStartSeconds,
          countdownSeconds: 3,
          playbackRate: state.playbackRate,
        })
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
            gain.gain.linearRampToValueAtTime(0.12, now + 0.025)
            gain.gain.setValueAtTime(0.12, now + 0.3)
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
          points: [],
        }))
        void activation
          .then(() => startClock(active, microphonePromise))
          .catch((error: unknown) => {
            setState((current) => ({
              ...current,
              phase: 'retry',
              failureMessage: error instanceof Error ? error.message : 'Playback could not start.',
            }))
          })
      } catch (error) {
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

  const stop = useCallback(async () => {
    if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current)
    const active = runtime.current
    if (!active) return
    await recorderStarting.current
    if (active.recorder?.getSnapshot().phase === 'recording') {
      await active.recorder.stop()
      await finishTake(null)
    } else {
      active.player.pause()
      setState((current) => ({ ...current, phase: 'idle' }))
    }
  }, [finishTake])

  const pause = useCallback(() => {
    void stop()
  }, [stop])

  const seek = useCallback((seconds: number) => {
    runtime.current?.player.seek(seconds)
    setState((current) => ({ ...current, currentSeconds: seconds }))
  }, [])

  const setPlaybackRate = useCallback((playbackRate: PlaybackRate) => {
    runtime.current?.player.setPlaybackRate(playbackRate)
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
