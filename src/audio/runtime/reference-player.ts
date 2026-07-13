import type {
  PlaybackFailure,
  PlaybackRate,
  ReferencePlayerSnapshot,
  SlowPlaybackProbe,
  StartPlaybackOptions,
  TimelineAnchor,
  WakeLockAdapter,
  WakeLockHandle,
} from './types'

type SnapshotListener = (snapshot: ReferencePlayerSnapshot) => void

interface ReferencePlayerDependencies {
  readonly context: AudioContext
  readonly element: HTMLAudioElement
  readonly wakeLock?: WakeLockAdapter | undefined
  readonly slowPlaybackProbe?: SlowPlaybackProbe | undefined
}

const REQUIRED_RATE: PlaybackRate = 1
const OPTIONAL_RATES = [0.5, 0.75, 0.9] as const

function finiteSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function mediaErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Safari blocked playback. Tap to retry.'
  }
  return error instanceof Error ? error.message : 'Playback could not start. Tap to retry.'
}

export class ReferencePlayer {
  readonly element: HTMLAudioElement

  private readonly context: AudioContext
  private readonly gain: GainNode
  private readonly slowPlaybackProbe: SlowPlaybackProbe | undefined
  private readonly wakeLockAdapter: WakeLockAdapter | undefined
  private wakeLock: WakeLockHandle | null = null
  private anchor: TimelineAnchor | null = null
  private countdownEndsAt: number | null = null
  private pendingAudibleStartSeconds: number | null = null
  private listeners = new Set<SnapshotListener>()
  private enabledRates = new Set<PlaybackRate>([REQUIRED_RATE])
  private readonly cleanupCallbacks: (() => void)[] = []
  private snapshot: ReferencePlayerSnapshot = {
    phase: 'idle',
    projectTimeSeconds: null,
    playbackRate: REQUIRED_RATE,
    countdownRemainingSeconds: 0,
    failure: null,
    message: null,
  }

  constructor(dependencies: ReferencePlayerDependencies) {
    this.context = dependencies.context
    this.element = dependencies.element
    this.wakeLockAdapter = dependencies.wakeLock
    this.slowPlaybackProbe = dependencies.slowPlaybackProbe

    const source = this.context.createMediaElementSource(this.element)
    this.gain = this.context.createGain()
    source.connect(this.gain).connect(this.context.destination)
    this.element.preload = 'metadata'
    this.element.setAttribute('playsinline', '')
    this.element.crossOrigin = 'anonymous'
    this.bindMediaEvents()
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
    return [0.5, 0.75, 0.9, 1].filter((rate): rate is PlaybackRate =>
      this.enabledRates.has(rate as PlaybackRate),
    )
  }

  async probeSlowPlaybackRates(): Promise<readonly PlaybackRate[]> {
    if (!this.slowPlaybackProbe || !this.supportsPitchPreservation()) {
      return this.getAvailablePlaybackRates()
    }

    for (const rate of OPTIONAL_RATES) {
      if (await this.slowPlaybackProbe.verify(rate, this.element)) {
        this.enabledRates.add(rate)
      }
    }
    return this.getAvailablePlaybackRates()
  }

  /** Must be called synchronously from the Start/Retry pointer or click handler. */
  async activateFromGesture(options: StartPlaybackOptions): Promise<void> {
    const loopStartSeconds = finiteSeconds(options.loopStartSeconds)
    const rate = options.playbackRate ?? REQUIRED_RATE
    if (!this.enabledRates.has(rate)) {
      throw new RangeError(`Playback rate ${rate} has not passed the device capability check.`)
    }

    this.patch({
      phase: 'activating',
      playbackRate: rate,
      failure: null,
      message: null,
      countdownRemainingSeconds: finiteSeconds(options.countdownSeconds),
    })
    this.gain.gain.cancelScheduledValues(this.context.currentTime)
    this.gain.gain.setValueAtTime(0, this.context.currentTime)
    this.element.playbackRate = rate
    this.element.currentTime = loopStartSeconds
    this.pendingAudibleStartSeconds = loopStartSeconds

    // These calls intentionally happen before the first await so iOS sees the user activation.
    const resumePromise = this.context.resume()
    const playPromise = this.element.play()
    const wakeLockPromise = this.wakeLockAdapter?.request()

    try {
      await Promise.all([resumePromise, playPromise])
      if (wakeLockPromise) {
        this.wakeLock = await wakeLockPromise.catch(() => null)
      }
      const countdown = finiteSeconds(options.countdownSeconds)
      this.anchorAt(loopStartSeconds, false)
      this.countdownEndsAt = this.context.currentTime + countdown
      this.patch({
        phase: countdown > 0 ? 'countdown' : 'playing',
        countdownRemainingSeconds: countdown,
      })
      if (countdown === 0) {
        this.beginAudible(loopStartSeconds)
      }
    } catch (error) {
      this.invalidate('activation-rejected', mediaErrorMessage(error))
      throw error
    }
  }

  /** Called when a context-clock-driven countdown reaches zero. */
  beginAudible(projectTimeSeconds: number): boolean {
    if (this.element.paused || this.context.state !== 'running') {
      this.invalidate('activation-rejected', 'Playback lost activation. Tap to retry.')
      return false
    }

    const projectTime =
      this.snapshot.phase === 'countdown' && this.pendingAudibleStartSeconds !== null
        ? this.pendingAudibleStartSeconds
        : finiteSeconds(projectTimeSeconds)
    this.element.currentTime = projectTime
    this.anchorAt(projectTime, true)
    const now = this.context.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(0, now)
    this.gain.gain.linearRampToValueAtTime(1, now + 0.025)
    this.countdownEndsAt = null
    this.pendingAudibleStartSeconds = null
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
    if (!this.enabledRates.has(rate)) {
      throw new RangeError(`Playback rate ${rate} is not enabled on this device.`)
    }
    const projectTime = this.currentProjectTime() ?? this.element.currentTime
    this.element.playbackRate = rate
    this.anchorAt(projectTime, !this.element.paused)
    this.patch({ playbackRate: rate })
  }

  seek(projectTimeSeconds: number): void {
    const projectTime = finiteSeconds(projectTimeSeconds)
    this.element.currentTime = projectTime
    this.anchorAt(projectTime, !this.element.paused)
  }

  reanchorFromMedia(): void {
    if (!Number.isFinite(this.element.currentTime) || this.element.paused) {
      this.anchorAt(0, false)
      return
    }
    this.anchorAt(this.element.currentTime, true)
  }

  /** Returns true when a discontinuity was found and re-anchored for gap marking. */
  reanchorIfDrifted(toleranceSeconds = 0.08): boolean {
    const projected = this.currentProjectTime()
    if (projected === null || this.element.paused || !Number.isFinite(this.element.currentTime)) {
      return false
    }
    if (Math.abs(projected - this.element.currentTime) <= Math.max(0.01, toleranceSeconds)) {
      return false
    }
    this.anchorAt(this.element.currentTime, true)
    return true
  }

  currentProjectTime(contextTimeSeconds = this.context.currentTime): number | null {
    const anchor = this.anchor
    if (!anchor?.valid || !Number.isFinite(contextTimeSeconds)) return null
    return Math.max(
      0,
      anchor.projectTimeSeconds +
        (contextTimeSeconds - anchor.contextTimeSeconds) * anchor.playbackRate,
    )
  }

  pause(): void {
    const projectTime = this.currentProjectTime() ?? this.element.currentTime
    this.element.pause()
    this.anchorAt(projectTime, false)
    this.patch({ phase: 'paused' })
  }

  async dispose(): Promise<void> {
    this.pause()
    for (const cleanup of this.cleanupCallbacks.splice(0)) cleanup()
    this.listeners.clear()
    if (this.wakeLock && !this.wakeLock.released) await this.wakeLock.release()
    this.wakeLock = null
  }

  private supportsPitchPreservation(): boolean {
    const media = this.element as HTMLAudioElement & { webkitPreservesPitch?: boolean }
    if ('preservesPitch' in media) media.preservesPitch = true
    if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true
    return 'preservesPitch' in media || 'webkitPreservesPitch' in media
  }

  private bindMediaEvents(): void {
    this.element.addEventListener('playing', () => this.reanchorFromMedia())
    this.element.addEventListener('seeked', () => this.reanchorFromMedia())
    this.element.addEventListener('ratechange', () => this.reanchorFromMedia())
    this.element.addEventListener('waiting', () =>
      this.invalidate(
        'media-stalled',
        'Reference audio stalled. This interval will not be scored.',
      ),
    )
    this.element.addEventListener('stalled', () =>
      this.invalidate(
        'media-stalled',
        'Reference audio stalled. This interval will not be scored.',
      ),
    )
    this.element.addEventListener('ended', () => this.invalidate('media-ended', 'Reference ended.'))
    const onContextStateChange = () => {
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
    this.context.addEventListener('statechange', onContextStateChange)
    this.cleanupCallbacks.push(() =>
      this.context.removeEventListener('statechange', onContextStateChange),
    )
  }

  private anchorAt(projectTimeSeconds: number, valid: boolean): void {
    this.anchor = {
      contextTimeSeconds: this.context.currentTime,
      projectTimeSeconds: finiteSeconds(projectTimeSeconds),
      playbackRate: this.element.playbackRate,
      valid,
    }
    this.emit()
  }

  private invalidate(failure: PlaybackFailure, message: string): void {
    const projectTime = this.currentProjectTime() ?? this.element.currentTime
    this.anchorAt(projectTime, false)
    this.gain.gain.cancelScheduledValues(this.context.currentTime)
    this.gain.gain.setValueAtTime(0, this.context.currentTime)
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

export function createBrowserWakeLockAdapter(
  navigatorValue: Navigator,
): WakeLockAdapter | undefined {
  if (!('wakeLock' in navigatorValue)) return undefined
  return {
    async request() {
      return navigatorValue.wakeLock.request('screen')
    },
  }
}
