import type {
  ClockLike,
  RecorderChunkSink,
  RecordingInterruption,
  RecordingLimits,
  RecordingSnapshot,
} from './types'

const IOS_FIRST_MIME_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const

export function selectRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean = (mimeType) =>
    MediaRecorder.isTypeSupported(mimeType),
): string | undefined {
  return IOS_FIRST_MIME_TYPES.find((mimeType) => isTypeSupported(mimeType))
}

interface ForegroundRecorderDependencies {
  readonly stream: MediaStream
  readonly clock: ClockLike
  readonly sink: RecorderChunkSink
  readonly limits: RecordingLimits
  readonly mimeType?: string | undefined
  readonly document?: Document | undefined
  readonly window?: Window | undefined
  readonly createRecorder?:
    ((stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder) | undefined
  readonly captureSettings?: RecordingSnapshot['settings'] | undefined
  readonly mediaDevices?: MediaDevices | undefined
}

type RecordingListener = (snapshot: RecordingSnapshot) => void

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Recording failed.'
}

export class ForegroundRecorder {
  private readonly clock: ClockLike
  private readonly documentValue: Document | undefined
  private readonly limits: RecordingLimits
  private readonly mediaDevices: MediaDevices | undefined
  private readonly recorder: MediaRecorder
  private readonly sink: RecorderChunkSink
  private readonly stream: MediaStream
  private readonly windowValue: Window | undefined
  private readonly listeners = new Set<RecordingListener>()
  private readonly cleanupCallbacks: (() => void)[] = []
  private pendingWrites: Promise<void> = Promise.resolve()
  private startContextTime: number | null = null
  private finalizePromise: Promise<void> | null = null
  private sequence = 0
  private snapshot: RecordingSnapshot

  constructor(dependencies: ForegroundRecorderDependencies) {
    this.stream = dependencies.stream
    this.clock = dependencies.clock
    this.sink = dependencies.sink
    this.limits = dependencies.limits
    this.mediaDevices =
      dependencies.mediaDevices ??
      (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices)
    this.documentValue =
      dependencies.document ?? (typeof document === 'undefined' ? undefined : document)
    this.windowValue = dependencies.window ?? (typeof window === 'undefined' ? undefined : window)
    const options = dependencies.mimeType ? { mimeType: dependencies.mimeType } : undefined
    const createRecorder =
      dependencies.createRecorder ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions))
    this.recorder = createRecorder(this.stream, options)
    this.snapshot = {
      phase: 'ready',
      mimeType:
        this.recorder.mimeType.length > 0
          ? this.recorder.mimeType
          : (dependencies.mimeType ?? null),
      byteLength: 0,
      durationSeconds: 0,
      settings: dependencies.captureSettings ?? null,
      partialReason: null,
      error: null,
    }
    this.bindEvents()
  }

  subscribe(listener: RecordingListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): RecordingSnapshot {
    return { ...this.snapshot, durationSeconds: this.duration() }
  }

  /** Start directly in the user gesture that authorizes recording. */
  startFromGesture(): void {
    if (this.snapshot.phase !== 'ready')
      throw new DOMException('Recorder is not ready.', 'InvalidStateError')
    if (this.clock.state !== 'running') {
      throw new DOMException('AudioContext must be running before recording.', 'InvalidStateError')
    }
    this.startContextTime = this.clock.currentTime
    this.recorder.start(1000)
    this.patch({ phase: 'recording', error: null })
  }

  stop(): Promise<void> {
    return this.finalize(null)
  }

  interrupt(reason: RecordingInterruption): Promise<void> {
    return this.finalize(reason)
  }

  dispose(): void {
    for (const cleanup of this.cleanupCallbacks.splice(0)) cleanup()
    this.listeners.clear()
  }

  private bindEvents(): void {
    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size === 0) return
      const sequence = this.sequence++
      this.snapshot = {
        ...this.snapshot,
        byteLength: this.snapshot.byteLength + event.data.size,
        durationSeconds: this.duration(),
      }
      this.pendingWrites = this.pendingWrites.then(() => this.sink.append(event.data, sequence))
      this.emit()
      if (this.snapshot.byteLength >= this.limits.maxBytes) void this.interrupt('size-limit')
      if (this.duration() >= this.limits.maxDurationSeconds) void this.interrupt('duration-limit')
    })

    this.recorder.addEventListener('error', (event) => {
      const candidate = event as Event & { error?: DOMException }
      void this.fail(candidate.error ?? new Error('MediaRecorder error.'))
    })

    const onVisibility = () => {
      if (this.snapshot.phase === 'recording' && this.documentValue?.visibilityState === 'hidden') {
        void this.interrupt('page-hidden')
      }
    }
    const onPageHide = () => {
      if (this.snapshot.phase === 'recording') void this.interrupt('page-unloaded')
    }
    this.documentValue?.addEventListener('visibilitychange', onVisibility)
    this.windowValue?.addEventListener('pagehide', onPageHide)
    this.cleanupCallbacks.push(() =>
      this.documentValue?.removeEventListener('visibilitychange', onVisibility),
    )
    this.cleanupCallbacks.push(() => this.windowValue?.removeEventListener('pagehide', onPageHide))

    const onDeviceChange = () => {
      if (this.snapshot.phase === 'recording') void this.interrupt('route-lost')
    }
    this.mediaDevices?.addEventListener('devicechange', onDeviceChange)
    this.cleanupCallbacks.push(() =>
      this.mediaDevices?.removeEventListener('devicechange', onDeviceChange),
    )

    for (const track of this.stream.getAudioTracks()) {
      const onEnded = () => {
        if (this.snapshot.phase === 'recording') void this.interrupt('microphone-ended')
      }
      track.addEventListener('ended', onEnded)
      this.cleanupCallbacks.push(() => track.removeEventListener('ended', onEnded))
    }

    const contextEventTarget = this.clock as ClockLike & EventTarget
    if ('addEventListener' in contextEventTarget) {
      const onStateChange = () => {
        if (this.snapshot.phase === 'recording' && this.clock.state !== 'running') {
          void this.interrupt('audio-context-interrupted')
        }
      }
      contextEventTarget.addEventListener('statechange', onStateChange)
      this.cleanupCallbacks.push(() =>
        contextEventTarget.removeEventListener('statechange', onStateChange),
      )
    }
  }

  private finalize(reason: RecordingInterruption | null): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise
    if (this.snapshot.phase === 'complete') return Promise.resolve()
    if (this.snapshot.phase !== 'recording') {
      return Promise.reject(new DOMException('Recorder is not recording.', 'InvalidStateError'))
    }

    this.patch({ phase: 'finalizing', partialReason: reason })
    this.finalizePromise = new Promise<void>((resolve) => {
      this.recorder.addEventListener(
        'stop',
        () => {
          void this.commitAfterWrites(reason).then(resolve)
        },
        { once: true },
      )
      if (this.recorder.state !== 'inactive') this.recorder.stop()
      else void this.commitAfterWrites(reason).then(resolve)
    })
    return this.finalizePromise
  }

  private async commitAfterWrites(reason: RecordingInterruption | null): Promise<void> {
    try {
      await this.pendingWrites
      await this.sink.commit({
        mimeType:
          this.recorder.mimeType.length > 0
            ? this.recorder.mimeType
            : (this.snapshot.mimeType ?? 'application/octet-stream'),
        byteLength: this.snapshot.byteLength,
        durationSeconds: this.duration(),
        partialReason: reason,
      })
      this.patch({ phase: 'complete', durationSeconds: this.duration(), partialReason: reason })
    } catch (error) {
      await this.fail(error)
    } finally {
      this.dispose()
    }
  }

  private async fail(error: unknown): Promise<void> {
    this.patch({ phase: 'error', error: errorText(error) })
    await this.sink.abort(error).catch(() => undefined)
  }

  private duration(): number {
    if (this.startContextTime === null) return 0
    return Math.max(0, this.clock.currentTime - this.startContextTime)
  }

  private patch(patch: Partial<RecordingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
