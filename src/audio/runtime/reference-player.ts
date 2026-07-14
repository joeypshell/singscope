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

type BufferablePhase = 'activating' | 'countdown' | 'playing'

const REQUIRED_RATE: PlaybackRate = 1
const OPTIONAL_RATES = [0.5, 0.75, 0.9] as const
const STALL_RETRY_DELAY_MS = 4_000
const BUFFERING_MESSAGE = 'Reference audio is buffering. Timing and scoring are paused.'

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
  private loopStartSeconds = 0
  private loopEndSeconds = 0
  private bufferingPhase: BufferablePhase | null = null
  private bufferedCountdownRemainingSeconds: number | null = null
  private bufferingMediaTimeSeconds: number | null = null
  private stallTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private activationGeneration = 0
  private audibleSeekPending = false
  private audibleSeekSettled = false
  private ignoreNextEndedAfterRewind = false
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
    const activationGeneration = ++this.activationGeneration
    const loopStartSeconds = finiteSeconds(options.loopStartSeconds)
    const loopEndSeconds = Math.max(loopStartSeconds, finiteSeconds(options.loopEndSeconds))
    const rate = options.playbackRate ?? REQUIRED_RATE
    if (!this.enabledRates.has(rate)) {
      throw new RangeError(`Playback rate ${rate} has not passed the device capability check.`)
    }

    this.clearBuffering()
    this.audibleSeekPending = false
    this.audibleSeekSettled = false
    this.ignoreNextEndedAfterRewind = false
    this.loopStartSeconds = loopStartSeconds
    this.loopEndSeconds = loopEndSeconds
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
      if (
        activationGeneration !== this.activationGeneration ||
        this.snapshot.phase === 'paused' ||
        this.snapshot.phase === 'retry'
      ) {
        throw new DOMException('Playback activation was cancelled.', 'AbortError')
      }
      if (wakeLockPromise) {
        this.wakeLock = await wakeLockPromise.catch(() => null)
      }
      if (activationGeneration !== this.activationGeneration) {
        throw new DOMException('Playback activation was cancelled.', 'AbortError')
      }
      const countdown = finiteSeconds(options.countdownSeconds)
      this.anchorAt(loopStartSeconds, false)
      if (this.bufferingPhase !== null) {
        this.bufferingPhase = 'countdown'
        this.bufferedCountdownRemainingSeconds = countdown
        this.countdownEndsAt = null
        this.patch({
          phase: 'countdown',
          countdownRemainingSeconds: countdown,
          failure: null,
          message: BUFFERING_MESSAGE,
        })
        return
      }
      this.countdownEndsAt = this.context.currentTime + countdown
      this.patch({
        phase: 'countdown',
        countdownRemainingSeconds: countdown,
      })
      if (countdown === 0) {
        this.beginAudible(loopStartSeconds)
      }
    } catch (error) {
      if (activationGeneration !== this.activationGeneration) {
        throw new DOMException('Playback activation was cancelled.', 'AbortError')
      }
      this.invalidate('activation-rejected', mediaErrorMessage(error))
      throw error
    }
  }

  /** Called when a context-clock-driven countdown reaches zero. */
  beginAudible(projectTimeSeconds: number): boolean {
    if (this.snapshot.phase !== 'countdown' || this.bufferingPhase !== null) return false
    if (this.element.paused || this.context.state !== 'running') {
      this.invalidate('activation-rejected', 'Playback lost activation. Tap to retry.')
      return false
    }

    const projectTime = this.pendingAudibleStartSeconds ?? finiteSeconds(projectTimeSeconds)
    if (!this.audibleSeekPending) {
      const mediaTimeBeforeRewind = this.element.currentTime
      const loopDuration = Math.max(0, this.loopEndSeconds - this.loopStartSeconds)
      const toleranceSeconds = Math.min(0.2, Math.max(0.04, loopDuration * 0.02))
      this.ignoreNextEndedAfterRewind =
        mediaTimeBeforeRewind >= this.loopEndSeconds - toleranceSeconds &&
        projectTime <= this.loopStartSeconds + toleranceSeconds
      this.audibleSeekPending = true
      this.audibleSeekSettled = false
      this.mute()
      this.anchorAt(projectTime, false)
      this.element.currentTime = projectTime
    }
    // Safari can report the loop-start seek asynchronously. Keep the source muted and
    // leave capture unstarted until the seek has current media data.
    if (this.element.seeking || (this.element.readyState < 2 && !this.audibleSeekSettled)) {
      return false
    }

    this.audibleSeekPending = false
    this.audibleSeekSettled = false
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
    if (this.bufferingPhase === 'countdown') {
      return this.bufferedCountdownRemainingSeconds ?? this.snapshot.countdownRemainingSeconds
    }
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
    this.anchorAt(projectTime, this.bufferingPhase === null && !this.element.paused)
    this.patch({ playbackRate: rate })
  }

  seek(projectTimeSeconds: number): void {
    const projectTime = finiteSeconds(projectTimeSeconds)
    this.element.currentTime = projectTime
    this.anchorAt(projectTime, this.bufferingPhase === null && !this.element.paused)
  }

  reanchorFromMedia(): void {
    if (
      this.bufferingPhase !== null ||
      !Number.isFinite(this.element.currentTime) ||
      this.element.paused
    ) {
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
    this.activationGeneration += 1
    const projectTime = this.currentProjectTime() ?? this.element.currentTime
    this.clearBuffering()
    this.countdownEndsAt = null
    this.pendingAudibleStartSeconds = null
    this.audibleSeekPending = false
    this.audibleSeekSettled = false
    this.ignoreNextEndedAfterRewind = false
    this.element.pause()
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
    const onPlaying = () => {
      if (this.recoverFromBuffering()) return
      if (this.snapshot.phase === 'activating' || this.snapshot.phase === 'countdown') {
        if (this.audibleSeekPending) this.audibleSeekSettled = true
        this.anchorAt(this.element.currentTime, false)
        return
      }
      this.reanchorFromMedia()
    }
    const onCanPlay = () => {
      if (this.audibleSeekPending) this.audibleSeekSettled = true
      this.recoverFromBuffering()
    }
    const onSeeked = () => {
      if (this.snapshot.phase === 'countdown' && this.audibleSeekPending) {
        this.audibleSeekSettled = true
        this.anchorAt(this.pendingAudibleStartSeconds ?? this.loopStartSeconds, false)
        return
      }
      if (this.bufferingPhase === null && this.snapshot.phase === 'playing') {
        this.reanchorFromMedia()
      }
    }
    const onRateChange = () => {
      if (this.bufferingPhase === null && this.snapshot.phase === 'playing') {
        this.reanchorFromMedia()
      }
    }
    const onWaiting = () => this.beginBuffering()
    const onStalled = () => {
      if (this.element.readyState < 3) this.beginBuffering()
    }
    const onTimeUpdate = () => {
      if (
        this.bufferingPhase !== null &&
        this.bufferingMediaTimeSeconds !== null &&
        this.element.currentTime > this.bufferingMediaTimeSeconds + 0.01
      ) {
        this.recoverFromBuffering()
      }
    }
    const onEnded = () => this.handleEnded()
    this.element.addEventListener('playing', onPlaying)
    this.element.addEventListener('canplay', onCanPlay)
    this.element.addEventListener('seeked', onSeeked)
    this.element.addEventListener('ratechange', onRateChange)
    this.element.addEventListener('waiting', onWaiting)
    this.element.addEventListener('stalled', onStalled)
    this.element.addEventListener('timeupdate', onTimeUpdate)
    this.element.addEventListener('ended', onEnded)
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
    this.cleanupCallbacks.push(() => {
      this.element.removeEventListener('playing', onPlaying)
      this.element.removeEventListener('canplay', onCanPlay)
      this.element.removeEventListener('seeked', onSeeked)
      this.element.removeEventListener('ratechange', onRateChange)
      this.element.removeEventListener('waiting', onWaiting)
      this.element.removeEventListener('stalled', onStalled)
      this.element.removeEventListener('timeupdate', onTimeUpdate)
      this.element.removeEventListener('ended', onEnded)
      this.context.removeEventListener('statechange', onContextStateChange)
    })
  }

  private beginBuffering(): void {
    if (
      this.snapshot.phase !== 'activating' &&
      this.snapshot.phase !== 'countdown' &&
      this.snapshot.phase !== 'playing'
    ) {
      return
    }
    if (this.bufferingPhase !== null) return

    this.bufferingPhase = this.snapshot.phase
    this.bufferingMediaTimeSeconds = this.element.currentTime
    if (this.snapshot.phase === 'countdown') {
      this.bufferedCountdownRemainingSeconds =
        this.countdownEndsAt === null
          ? this.snapshot.countdownRemainingSeconds
          : Math.max(0, this.countdownEndsAt - this.context.currentTime)
      this.countdownEndsAt = null
    }
    const projectTime = this.currentProjectTime() ?? this.element.currentTime
    this.anchorAt(projectTime, false)
    this.mute()
    this.patch({
      countdownRemainingSeconds:
        this.bufferedCountdownRemainingSeconds ?? this.snapshot.countdownRemainingSeconds,
      failure: null,
      message: BUFFERING_MESSAGE,
    })
    this.stallTimer = globalThis.setTimeout(() => {
      this.stallTimer = null
      if (this.bufferingPhase === null) return
      this.invalidate(
        'media-stalled',
        'Reference audio did not recover from buffering. Tap to retry.',
      )
    }, STALL_RETRY_DELAY_MS)
  }

  private recoverFromBuffering(): boolean {
    const phase = this.bufferingPhase
    if (phase === null) return false
    if (this.element.paused) return true

    const countdownRemaining = this.bufferedCountdownRemainingSeconds
    this.clearBuffering()
    if (phase === 'activating') {
      this.patch({ failure: null, message: null })
      return true
    }
    if (phase === 'countdown') {
      const remaining = countdownRemaining ?? this.snapshot.countdownRemainingSeconds
      this.countdownEndsAt = this.context.currentTime + remaining
      this.anchorAt(this.pendingAudibleStartSeconds ?? this.loopStartSeconds, false)
      this.patch({
        phase: 'countdown',
        countdownRemainingSeconds: remaining,
        failure: null,
        message: null,
      })
      return true
    }

    this.reanchorFromMedia()
    this.rampGainUp()
    this.patch({ phase: 'playing', failure: null, message: null })
    return true
  }

  private handleEnded(): void {
    if (
      this.snapshot.phase !== 'activating' &&
      this.snapshot.phase !== 'countdown' &&
      this.snapshot.phase !== 'playing'
    ) {
      return
    }
    const currentTime = this.element.currentTime
    const loopDuration = Math.max(0, this.loopEndSeconds - this.loopStartSeconds)
    const toleranceSeconds = Math.min(0.2, Math.max(0.04, loopDuration * 0.02))
    if (
      this.ignoreNextEndedAfterRewind &&
      !this.element.ended &&
      currentTime <= this.loopStartSeconds + toleranceSeconds
    ) {
      this.ignoreNextEndedAfterRewind = false
      return
    }
    this.ignoreNextEndedAfterRewind = false
    if (!Number.isFinite(currentTime) || currentTime < this.loopEndSeconds - toleranceSeconds) {
      this.invalidate(
        'media-ended',
        'Reference audio ended before the selected loop finished. Tap to retry.',
      )
      return
    }

    this.clearBuffering()
    this.audibleSeekPending = false
    this.audibleSeekSettled = false
    this.mute()
    if (this.snapshot.phase === 'activating' || this.snapshot.phase === 'countdown') {
      this.element.currentTime = this.loopStartSeconds
      this.anchorAt(this.loopStartSeconds, false)
      void this.element.play().catch((error: unknown) => {
        this.invalidate('activation-rejected', mediaErrorMessage(error))
      })
      return
    }

    // Keep the terminal project position valid for one controller frame so it can
    // finalize the take instead of interpreting a normal media end as a failure.
    this.anchorAt(this.loopEndSeconds, true)
    this.patch({ failure: null, message: null })
  }

  private rampGainUp(): void {
    const now = this.context.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(0, now)
    this.gain.gain.linearRampToValueAtTime(1, now + 0.025)
  }

  private mute(): void {
    this.gain.gain.cancelScheduledValues(this.context.currentTime)
    this.gain.gain.setValueAtTime(0, this.context.currentTime)
  }

  private clearBuffering(): void {
    if (this.stallTimer !== null) globalThis.clearTimeout(this.stallTimer)
    this.stallTimer = null
    this.bufferingPhase = null
    this.bufferedCountdownRemainingSeconds = null
    this.bufferingMediaTimeSeconds = null
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
    this.activationGeneration += 1
    const projectTime = this.currentProjectTime() ?? this.element.currentTime
    this.clearBuffering()
    this.countdownEndsAt = null
    this.pendingAudibleStartSeconds = null
    this.audibleSeekPending = false
    this.audibleSeekSettled = false
    this.ignoreNextEndedAfterRewind = false
    this.anchorAt(projectTime, false)
    this.mute()
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
