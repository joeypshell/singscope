import { beginBrowserAudioCapture, type AudioCaptureSession } from './audio-session'
import { requestMicrophone, stopMediaStream, type MicrophoneRequest } from './microphone'
import { ForegroundRecorder, selectRecorderMimeType } from './recorder'
import type { CaptureSettings, RecordingInterruption, RecordingSnapshot } from './types'

export const RECORDED_SOURCE_LIMITS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDurationSeconds: 60,
})

export type RecordedSourcePhase =
  'idle' | 'requesting' | 'recording' | 'finalizing' | 'complete' | 'discarded' | 'error'

export interface RecordedSourceSnapshot {
  readonly phase: RecordedSourcePhase
  readonly mimeType: string | null
  readonly byteLength: number
  readonly durationSeconds: number
  readonly settings: CaptureSettings | null
  readonly partialReason: RecordingInterruption | null
  readonly error: string | null
}

export interface RecordedSourceResult {
  readonly blob: Blob
  readonly mimeType: string
  readonly durationSeconds: number
  readonly settings: CaptureSettings
  readonly partialReason: RecordingInterruption | null
}

export interface RecordedSourceCaptureDependencies {
  readonly createAudioContext?: (() => AudioContext) | undefined
  readonly requestMicrophone?:
    | ((
        request: MicrophoneRequest,
        mediaDevices?: MediaDevices,
      ) => Promise<{
        readonly stream: MediaStream
        readonly settings: CaptureSettings
      }>)
    | undefined
  readonly selectMimeType?: (() => string | undefined) | undefined
  readonly createMediaRecorder?:
    ((stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder) | undefined
  readonly document?: Document | undefined
  readonly window?: Window | undefined
  readonly mediaDevices?: MediaDevices | undefined
  readonly beginAudioCapture?: (() => AudioCaptureSession) | undefined
}

type RecordedSourceListener = (snapshot: RecordedSourceSnapshot) => void

function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'Microphone recording failed.'
}

function discardedError(): DOMException {
  return new DOMException('The recorded source was discarded.', 'AbortError')
}

/**
 * Captures one short, foreground-only monophonic source entirely in memory.
 * Persistence remains the caller's responsibility after `result` resolves.
 */
export class RecordedSourceCapture {
  readonly result: Promise<RecordedSourceResult>

  private readonly dependencies: RecordedSourceCaptureDependencies
  private readonly listeners = new Set<RecordedSourceListener>()
  private readonly chunks: Blob[] = []
  private resolveResult!: (result: RecordedSourceResult) => void
  private rejectResult!: (error: unknown) => void
  private snapshot: RecordedSourceSnapshot = {
    phase: 'idle',
    mimeType: null,
    byteLength: 0,
    durationSeconds: 0,
    settings: null,
    partialReason: null,
    error: null,
  }
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private recorder: ForegroundRecorder | null = null
  private startPromise: Promise<void> | null = null
  private cleanupPromise: Promise<void> | null = null
  private audioCaptureSession: AudioCaptureSession | null = null
  private expectedSequence = 0
  private capturedBytes = 0
  private discarded = false
  private resultSettled = false

  constructor(dependencies: RecordedSourceCaptureDependencies = {}) {
    this.dependencies = dependencies
    this.result = new Promise<RecordedSourceResult>((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    // A caller may only await start()/discard(). Keep a rejected result from
    // becoming an unhandled promise while preserving rejection for consumers.
    void this.result.catch(() => undefined)
  }

  getSnapshot(): RecordedSourceSnapshot {
    const recorderSnapshot = this.recorder?.getSnapshot()
    const durationSeconds =
      this.snapshot.phase === 'recording' || this.snapshot.phase === 'finalizing'
        ? (recorderSnapshot?.durationSeconds ?? this.snapshot.durationSeconds)
        : this.snapshot.durationSeconds
    return { ...this.snapshot, durationSeconds }
  }

  subscribe(listener: RecordedSourceListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.startPromise ??= this.startInternal()
    await this.startPromise
  }

  async stop(): Promise<RecordedSourceResult> {
    if (this.snapshot.phase === 'idle') {
      throw new DOMException('The recorded source has not started.', 'InvalidStateError')
    }
    if (this.snapshot.phase === 'discarded') throw discardedError()
    if (this.snapshot.phase === 'requesting') await this.startPromise

    const recorder = this.recorder
    if (recorder?.getSnapshot().phase === 'recording') {
      this.patch({ phase: 'finalizing' })
      await recorder.stop()
    }
    return this.result
  }

  async discard(): Promise<void> {
    if (this.snapshot.phase === 'discarded') return
    this.discarded = true

    if (this.startPromise) await this.startPromise.catch(() => undefined)
    const recorder = this.recorder
    if (recorder?.getSnapshot().phase === 'recording') {
      this.patch({ phase: 'finalizing' })
      await recorder.stop().catch(() => undefined)
    }

    this.chunks.length = 0
    await this.cleanup()
    this.patch({ phase: 'discarded', byteLength: 0, durationSeconds: 0, error: null })
    this.rejectOnce(discardedError())
  }

  private async startInternal(): Promise<void> {
    if (this.snapshot.phase !== 'idle') {
      throw new DOMException('The recorded source cannot be started again.', 'InvalidStateError')
    }
    this.patch({ phase: 'requesting', error: null })
    this.audioCaptureSession = (this.dependencies.beginAudioCapture ?? beginBrowserAudioCapture)()

    const createAudioContext =
      this.dependencies.createAudioContext ??
      (() => new AudioContext({ latencyHint: 'interactive' }))
    const microphoneRequest = this.dependencies.requestMicrophone ?? requestMicrophone

    try {
      const context = createAudioContext()
      this.context = context

      // Both permission-sensitive operations are invoked before the first await.
      const resumePromise = context.resume()
      const microphonePromise = microphoneRequest(
        { profile: 'raw' },
        this.dependencies.mediaDevices,
      )
      const [resumeResult, microphoneResult] = await Promise.allSettled([
        resumePromise,
        microphonePromise,
      ])

      if (microphoneResult.status === 'fulfilled') {
        this.stream = microphoneResult.value.stream
        this.audioCaptureSession.reassert()
        this.patch({ settings: microphoneResult.value.settings })
      }
      if (resumeResult.status === 'rejected') throw resumeResult.reason
      if (microphoneResult.status === 'rejected') throw microphoneResult.reason
      if (this.discarded) throw discardedError()

      const { settings, stream } = microphoneResult.value
      const mimeType = (this.dependencies.selectMimeType ?? selectRecorderMimeType)()
      const recorder = new ForegroundRecorder({
        stream,
        clock: context,
        limits: RECORDED_SOURCE_LIMITS,
        sink: {
          append: (chunk, sequence) => this.appendChunk(chunk, sequence),
          commit: (input) => this.commit(input, settings),
          abort: (error) => this.fail(error),
        },
        ...(mimeType ? { mimeType } : {}),
        ...(this.dependencies.createMediaRecorder
          ? { createRecorder: this.dependencies.createMediaRecorder }
          : {}),
        ...(this.dependencies.document ? { document: this.dependencies.document } : {}),
        ...(this.dependencies.window ? { window: this.dependencies.window } : {}),
        ...(this.dependencies.mediaDevices ? { mediaDevices: this.dependencies.mediaDevices } : {}),
        captureSettings: settings,
        // Safari's MP4/AAC MediaRecorder output is most reliable for immediate
        // decodeAudioData() use when stop() finalizes one complete container.
        timesliceMs: null,
      })
      this.recorder = recorder
      recorder.subscribe((value) => this.onRecorderSnapshot(value))
      recorder.startFromGesture()
    } catch (error) {
      if (this.discarded || (error instanceof DOMException && error.name === 'AbortError')) {
        await this.cleanup()
        this.patch({ phase: 'discarded', error: null })
        this.rejectOnce(discardedError())
      } else {
        await this.fail(error)
      }
      throw error
    }
  }

  private appendChunk(chunk: Blob, sequence: number): Promise<void> {
    if (sequence !== this.expectedSequence)
      throw new Error('Recording chunks arrived out of order.')
    this.expectedSequence += 1
    if (this.discarded) return Promise.resolve()

    // Never slice an encoded container. A one-shot source recording that is too
    // large must fail clearly instead of returning an empty or truncated file.
    if (this.capturedBytes + chunk.size > RECORDED_SOURCE_LIMITS.maxBytes) {
      throw new Error('Recorded melody exceeds the 8 MiB limit. Record a shorter melody.')
    }
    this.chunks.push(chunk)
    this.capturedBytes += chunk.size
    this.patch({ byteLength: this.capturedBytes })
    return Promise.resolve()
  }

  private async commit(
    input: {
      readonly mimeType: string
      readonly durationSeconds: number
      readonly partialReason: RecordingInterruption | null
    },
    settings: CaptureSettings,
  ): Promise<void> {
    if (this.discarded) return
    const blob = new Blob(this.chunks, { type: input.mimeType })
    if (blob.size === 0) {
      throw new Error('Safari finished the recording without usable audio bytes. Record again.')
    }
    const result: RecordedSourceResult = {
      blob,
      mimeType: input.mimeType,
      durationSeconds: input.durationSeconds,
      settings: { ...settings },
      partialReason: input.partialReason,
    }
    await this.cleanup()
    this.patch({
      phase: 'complete',
      mimeType: result.mimeType,
      byteLength: result.blob.size,
      durationSeconds: result.durationSeconds,
      settings: result.settings,
      partialReason: result.partialReason,
      error: null,
    })
    this.resolveOnce(result)
  }

  private onRecorderSnapshot(value: RecordingSnapshot): void {
    if (this.discarded || this.snapshot.phase === 'complete' || this.snapshot.phase === 'error')
      return
    const phase =
      value.phase === 'recording'
        ? 'recording'
        : value.phase === 'finalizing'
          ? 'finalizing'
          : this.snapshot.phase
    this.patch({
      phase,
      mimeType: value.mimeType,
      durationSeconds: value.durationSeconds,
      settings: value.settings,
      partialReason: value.partialReason,
      error: value.error,
    })
  }

  private async fail(error: unknown): Promise<void> {
    if (this.snapshot.phase === 'error' || this.snapshot.phase === 'discarded') return
    this.recorder?.dispose()
    this.chunks.length = 0
    await this.cleanup()
    this.patch({ phase: 'error', byteLength: 0, error: errorMessage(error) })
    this.rejectOnce(error)
  }

  private cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      const stream = this.stream
      this.stream = null
      if (stream) {
        try {
          stopMediaStream(stream)
        } catch {
          // Continue closing the AudioContext even if a host track throws.
        }
      }

      const context = this.context
      this.context = null
      this.audioCaptureSession?.release()
      this.audioCaptureSession = null
      if (context && context.state !== 'closed') await context.close().catch(() => undefined)
    })()
    return this.cleanupPromise
  }

  private resolveOnce(result: RecordedSourceResult): void {
    if (this.resultSettled) return
    this.resultSettled = true
    this.resolveResult(result)
  }

  private rejectOnce(error: unknown): void {
    if (this.resultSettled) return
    this.resultSettled = true
    this.rejectResult(error)
  }

  private patch(patch: Partial<RecordedSourceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
