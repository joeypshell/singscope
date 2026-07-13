export type PlaybackRate = 0.5 | 0.75 | 0.9 | 1

export type PlaybackFailure =
  'activation-rejected' | 'media-stalled' | 'media-ended' | 'context-interrupted' | 'route-lost'

export interface TimelineAnchor {
  readonly contextTimeSeconds: number
  readonly projectTimeSeconds: number
  readonly playbackRate: number
  readonly valid: boolean
}

export interface ReferencePlayerSnapshot {
  readonly phase: 'idle' | 'activating' | 'countdown' | 'playing' | 'paused' | 'retry'
  readonly projectTimeSeconds: number | null
  readonly playbackRate: PlaybackRate
  readonly countdownRemainingSeconds: number
  readonly failure: PlaybackFailure | null
  readonly message: string | null
}

export interface StartPlaybackOptions {
  readonly loopStartSeconds: number
  readonly countdownSeconds: number
  readonly playbackRate?: PlaybackRate
}

export interface WakeLockHandle {
  readonly released: boolean
  release(): Promise<void>
}

export interface WakeLockAdapter {
  request(): Promise<WakeLockHandle>
}

export interface SlowPlaybackProbe {
  verify(rate: Exclude<PlaybackRate, 1>, element: HTMLMediaElement): Promise<boolean>
}

export interface ClockLike {
  readonly currentTime: number
  readonly state: AudioContextState
  resume(): Promise<void>
}

export interface RecordingLimits {
  readonly maxBytes: number
  readonly maxDurationSeconds: number
}

export type RecordingInterruption =
  | 'app-backgrounded'
  | 'page-hidden'
  | 'page-unloaded'
  | 'audio-context-interrupted'
  | 'microphone-ended'
  | 'route-lost'
  | 'size-limit'
  | 'duration-limit'

export interface RecorderChunkSink {
  append(chunk: Blob, sequence: number): Promise<void>
  commit(input: {
    readonly mimeType: string
    readonly byteLength: number
    readonly durationSeconds: number
    readonly partialReason: RecordingInterruption | null
  }): Promise<void>
  abort(error: unknown): Promise<void>
}

export interface CaptureSettings {
  readonly deviceId: string | null
  readonly label: string | null
  readonly sampleRate: number | null
  readonly channelCount: number | null
  readonly echoCancellation: boolean | null
  readonly noiseSuppression: boolean | null
  readonly autoGainControl: boolean | null
}

export interface AudioInputOption {
  readonly deviceId: string
  readonly label: string
}

export interface RecordingSnapshot {
  readonly phase:
    'idle' | 'requesting' | 'ready' | 'recording' | 'finalizing' | 'complete' | 'error'
  readonly mimeType: string | null
  readonly byteLength: number
  readonly durationSeconds: number
  readonly settings: CaptureSettings | null
  readonly partialReason: RecordingInterruption | null
  readonly error: string | null
}
