import type {
  PlaybackRate,
  ReferencePlayback,
  ReferencePlayerSnapshot,
  StartPlaybackOptions,
  TimelineAnchor,
  WakeLockAdapter,
} from './types'
import { ManagedWakeLock } from './managed-wake-lock'

interface SynthesizedReferencePlayerDependencies {
  readonly context: AudioContext
  readonly buffer: AudioBuffer
  readonly wakeLock?: WakeLockAdapter | undefined
}

type SnapshotListener = (snapshot: ReferencePlayerSnapshot) => void

function finiteSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function activationMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Safari blocked playback. Tap to retry.'
  }
  return error instanceof Error ? error.message : 'Playback could not start. Tap to retry.'
}

/**
 * AudioContext-native transport for hand-entered melodies. The AudioBuffer is
 * populated directly from local PCM, avoiding WebKit's Blob-WAV media decoder.
 */
export class SynthesizedReferencePlayer implements ReferencePlayback {
  private readonly context: AudioContext
  private readonly buffer: AudioBuffer
  private readonly gain: GainNode
  private readonly wakeLock: ManagedWakeLock
  private readonly listeners = new Set<SnapshotListener>()
  private readonly onContextStateChange: () => void
  private source: AudioBufferSourceNode | null = null
  private primeSource: AudioBufferSourceNode | null = null
  private primeGain: GainNode | null = null
  private anchor: TimelineAnchor | null = null
  private countdownEndsAt: number | null = null
  private loopEndSeconds = 0
  private activationGeneration = 0
  private snapshot: ReferencePlayerSnapshot = {
    phase: 'idle',
    projectTimeSeconds: null,
    playbackRate: 1,
    countdownRemainingSeconds: 0,
    failure: null,
    message: null,
  }

  constructor(dependencies: SynthesizedReferencePlayerDependencies) {
    this.context = dependencies.context
    this.buffer = dependencies.buffer
    this.wakeLock = new ManagedWakeLock(dependencies.wakeLock)
    this.gain = this.context.createGain()
    this.gain.gain.value = 1
    this.gain.connect(this.context.destination)
    this.onContextStateChange = () => {
      if (
        (this.snapshot.phase === 'playing' || this.snapshot.phase === 'countdown') &&
        this.context.state !== 'running'
      ) {
        this.invalidate(
          'context-interrupted',
          'Audio was interrupted. The take stopped and will not resume automatically.',
        )
      }
    }
    this.context.addEventListener('statechange', this.onContextStateChange)
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): ReferencePlayerSnapshot {
    return { ...this.snapshot, projectTimeSeconds: this.currentProjectTime() }
  }

  getAvailablePlaybackRates(): readonly PlaybackRate[] {
    return [1]
  }

  probeSlowPlaybackRates(): Promise<readonly PlaybackRate[]> {
    return Promise.resolve([1])
  }

  async activateFromGesture(options: StartPlaybackOptions): Promise<void> {
    const generation = ++this.activationGeneration
    const loopStartSeconds = finiteSeconds(options.loopStartSeconds)
    const loopEndSeconds = Math.max(loopStartSeconds, finiteSeconds(options.loopEndSeconds))
    if ((options.playbackRate ?? 1) !== 1) {
      throw new RangeError('Synthesized references require 1× playback.')
    }
    if (loopEndSeconds > this.buffer.duration + 0.001) {
      throw new RangeError('The synthesized reference is shorter than the selected loop.')
    }
    this.stopSource()
    this.stopPrime()
    this.loopEndSeconds = loopEndSeconds
    this.anchorAt(loopStartSeconds, false)
    this.patch({
      phase: 'activating',
      playbackRate: 1,
      countdownRemainingSeconds: finiteSeconds(options.countdownSeconds),
      failure: null,
      message: null,
    })

    // Both operations happen before the first await to preserve the Start gesture.
    const resumePromise = this.context.resume()
    this.primeSource = this.context.createBufferSource()
    this.primeSource.buffer = this.buffer
    const muted = this.context.createGain()
    muted.gain.value = 0
    this.primeGain = muted
    this.primeSource.connect(muted).connect(this.context.destination)
    const prime = this.primeSource
    prime.onended = () => {
      if (this.primeSource === prime) this.primeSource = null
      if (this.primeGain === muted) this.primeGain = null
      try {
        prime.disconnect()
        muted.disconnect()
      } catch {
        // Safari can release a completed source before onended runs.
      }
    }
    prime.start(0, 0, Math.min(0.005, this.buffer.duration))
    const wakeLockPromise = this.wakeLock.request()
    try {
      await resumePromise
      if (generation !== this.activationGeneration || this.snapshot.phase === 'paused') {
        throw new DOMException('Playback activation was cancelled.', 'AbortError')
      }
      await wakeLockPromise
      if (generation !== this.activationGeneration) {
        throw new DOMException('Playback activation was cancelled.', 'AbortError')
      }
      const countdownSeconds = finiteSeconds(options.countdownSeconds)
      this.countdownEndsAt = this.context.currentTime + countdownSeconds
      this.anchorAt(loopStartSeconds, false)
      this.patch({ phase: 'countdown', countdownRemainingSeconds: countdownSeconds })
      if (countdownSeconds === 0) this.beginAudible(loopStartSeconds)
    } catch (error) {
      if (generation !== this.activationGeneration) {
        throw new DOMException('Playback activation was cancelled.', 'AbortError')
      }
      this.invalidate('activation-rejected', activationMessage(error))
      throw error
    }
  }

  beginAudible(projectTimeSeconds: number): boolean {
    if (this.snapshot.phase !== 'countdown') return false
    if (this.context.state !== 'running') {
      this.invalidate('activation-rejected', 'Playback lost activation. Tap to retry.')
      return false
    }
    const projectTime = finiteSeconds(projectTimeSeconds)
    this.startSource(projectTime)
    this.countdownEndsAt = null
    this.anchorAt(projectTime, true)
    this.patch({ phase: 'playing', countdownRemainingSeconds: 0 })
    return true
  }

  updateCountdown(): number {
    if (this.countdownEndsAt === null) return 0
    const remaining = Math.max(0, this.countdownEndsAt - this.context.currentTime)
    this.patch({ countdownRemainingSeconds: remaining })
    return remaining
  }

  setPlaybackRate(rate: PlaybackRate): void {
    if (rate !== 1) throw new RangeError('Synthesized references require 1× playback.')
  }

  seek(projectTimeSeconds: number): void {
    const projectTime = finiteSeconds(projectTimeSeconds)
    const playing = this.snapshot.phase === 'playing' && this.context.state === 'running'
    this.stopSource()
    if (playing) this.startSource(projectTime)
    this.anchorAt(projectTime, playing)
  }

  reanchorIfDrifted(): boolean {
    return false
  }

  currentProjectTime(contextTimeSeconds = this.context.currentTime): number | null {
    if (!this.anchor?.valid || !Number.isFinite(contextTimeSeconds)) return null
    return Math.max(
      0,
      this.anchor.projectTimeSeconds + (contextTimeSeconds - this.anchor.contextTimeSeconds),
    )
  }

  pause(): void {
    this.activationGeneration += 1
    const projectTime = this.currentProjectTime() ?? this.anchor?.projectTimeSeconds ?? 0
    this.countdownEndsAt = null
    this.stopSource()
    this.stopPrime()
    this.anchorAt(projectTime, false)
    this.patch({
      phase: 'paused',
      countdownRemainingSeconds: 0,
      failure: null,
      message: null,
    })
  }

  async dispose(): Promise<void> {
    this.pause()
    this.context.removeEventListener('statechange', this.onContextStateChange)
    this.listeners.clear()
    try {
      this.gain.disconnect()
    } catch {
      // A closing AudioContext can release its destination before cleanup.
    }
    await this.wakeLock.release()
  }

  private startSource(projectTimeSeconds: number): void {
    this.stopSource()
    const durationSeconds = Math.max(0, this.loopEndSeconds - projectTimeSeconds)
    if (durationSeconds <= 0) return
    const source = this.context.createBufferSource()
    source.buffer = this.buffer
    source.connect(this.gain)
    source.onended = () => {
      if (this.source === source) this.source = null
      try {
        source.disconnect()
      } catch {
        // A naturally completed source can already be disconnected by Safari.
      }
    }
    this.source = source
    source.start(this.context.currentTime, projectTimeSeconds, durationSeconds)
  }

  private stopSource(): void {
    const source = this.source
    this.source = null
    if (!source) return
    source.onended = null
    try {
      source.stop(this.context.currentTime)
    } catch {
      // A one-shot source may already have ended.
    }
    try {
      source.disconnect()
    } catch {
      // Safari can release a completed source eagerly.
    }
  }

  private stopPrime(): void {
    const source = this.primeSource
    const gain = this.primeGain
    this.primeSource = null
    this.primeGain = null
    if (!source) {
      try {
        gain?.disconnect()
      } catch {
        // The muted gain can already be detached with its source.
      }
      return
    }
    source.onended = null
    try {
      source.stop(this.context.currentTime)
      source.disconnect()
      gain?.disconnect()
    } catch {
      // The muted unlock source normally ends before cleanup.
    }
  }

  private anchorAt(projectTimeSeconds: number, valid: boolean): void {
    this.anchor = {
      contextTimeSeconds: this.context.currentTime,
      projectTimeSeconds: finiteSeconds(projectTimeSeconds),
      playbackRate: 1,
      valid,
    }
    this.emit()
  }

  private invalidate(failure: ReferencePlayerSnapshot['failure'], message: string): void {
    this.activationGeneration += 1
    const projectTime = this.currentProjectTime() ?? this.anchor?.projectTimeSeconds ?? 0
    this.countdownEndsAt = null
    this.stopSource()
    this.stopPrime()
    this.anchorAt(projectTime, false)
    this.patch({ phase: 'retry', failure, message, countdownRemainingSeconds: 0 })
  }

  private patch(patch: Partial<ReferencePlayerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
