import { describe, expect, it, vi } from 'vitest'
import { pitchCandidateGapReason } from './capture-pipeline'
import { createMicrophoneConstraints } from './microphone'
import { ForegroundRecorder, selectRecorderMimeType } from './recorder'
import { ReferencePlayer } from './reference-player'
import type { ClockLike, RecorderChunkSink } from './types'

class FakeAudioParam {
  value = 1
  readonly setValueAtTime = vi.fn()
  readonly cancelScheduledValues = vi.fn()
  readonly linearRampToValueAtTime = vi.fn()
}

class FakeContext extends EventTarget {
  currentTime = 10
  state: AudioContextState = 'suspended'
  destination = {} as AudioDestinationNode
  readonly gain = new FakeAudioParam()
  readonly resume = vi.fn(() => {
    this.state = 'running'
    return Promise.resolve()
  })
  readonly createGain = vi.fn(() => ({
    gain: this.gain,
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
  }))
  readonly createMediaElementSource = vi.fn(() => ({ connect: vi.fn().mockReturnThis() }))
}

function createPlayerFixture(): {
  readonly context: FakeContext
  readonly element: HTMLAudioElement
  readonly player: ReferencePlayer
  readonly play: ReturnType<typeof vi.fn>
  readonly setPaused: (value: boolean) => void
} {
  const context = new FakeContext()
  const element = document.createElement('audio')
  Object.defineProperty(element, 'readyState', { configurable: true, get: () => 4 })
  let paused = true
  Object.defineProperty(element, 'paused', { get: () => paused })
  const play = vi.fn(() => {
    paused = false
    return Promise.resolve()
  })
  element.play = play
  element.pause = vi.fn(() => {
    paused = true
  })
  return {
    context,
    element,
    player: new ReferencePlayer({
      context: context as unknown as AudioContext,
      element,
    }),
    play,
    setPaused: (value) => {
      paused = value
    },
  }
}

describe('ReferencePlayer', () => {
  it('starts playback inside activation and uses context time for alignment', async () => {
    const context = new FakeContext()
    const element = document.createElement('audio')
    Object.defineProperty(element, 'readyState', { configurable: true, get: () => 4 })
    let paused = true
    Object.defineProperty(element, 'paused', { get: () => paused })
    const play = vi.fn(() => {
      paused = false
      return Promise.resolve()
    })
    element.play = play
    element.pause = vi.fn(() => {
      paused = true
    })
    const player = new ReferencePlayer({
      context: context as unknown as AudioContext,
      element,
    })

    const activation = player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 12,
      countdownSeconds: 3,
    })
    expect(context.resume).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledOnce()
    await activation
    expect(player.getSnapshot().phase).toBe('countdown')

    context.currentTime = 13
    expect(player.updateCountdown()).toBe(0)
    expect(player.beginAudible(5)).toBe(true)
    context.currentTime = 14
    expect(player.currentProjectTime()).toBeCloseTo(6)
  })

  it('requires a capability probe before enabling slow rates', async () => {
    const context = new FakeContext()
    const element = document.createElement('audio')
    Object.defineProperty(element, 'preservesPitch', { value: true, writable: true })
    const player = new ReferencePlayer({
      context: context as unknown as AudioContext,
      element,
      slowPlaybackProbe: { verify: (rate) => Promise.resolve(rate === 0.9) },
    })
    expect(await player.probeSlowPlaybackRates()).toEqual([0.9, 1])
    expect(() => player.setPlaybackRate(0.75)).toThrow(RangeError)
  })

  it('freezes a countdown through transient buffering and resumes on canplay', async () => {
    const { context, element, player } = createPlayerFixture()
    await player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 12,
      countdownSeconds: 3,
    })
    context.currentTime = 11
    expect(player.updateCountdown()).toBeCloseTo(2)

    element.dispatchEvent(new Event('waiting'))
    expect(player.getSnapshot()).toMatchObject({
      phase: 'countdown',
      failure: null,
      countdownRemainingSeconds: 2,
    })
    expect(player.currentProjectTime()).toBeNull()

    context.currentTime = 31
    expect(player.updateCountdown()).toBeCloseTo(2)
    element.dispatchEvent(new Event('canplay'))
    expect(player.getSnapshot().message).toBeNull()
    context.currentTime = 32
    expect(player.updateCountdown()).toBeCloseTo(1)
  })

  it('keeps countdown and activation unscored after Safari seek events', async () => {
    const { element, player } = createPlayerFixture()
    await player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 12,
      countdownSeconds: 3,
    })
    element.dispatchEvent(new Event('seeked'))
    expect(player.getSnapshot().phase).toBe('countdown')
    expect(player.currentProjectTime()).toBeNull()
  })

  it('does not let a late activation resolution resurrect cancelled playback', async () => {
    const fixture = createPlayerFixture()
    let resolvePlay: () => void = () => undefined
    fixture.element.play = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePlay = resolve
        }),
    )
    const activation = fixture.player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 2,
      countdownSeconds: 3,
    })
    fixture.player.pause()
    resolvePlay()
    await expect(activation).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.player.getSnapshot().phase).toBe('paused')
  })

  it('does not let a stale rejected activation invalidate a newer retry', async () => {
    const fixture = createPlayerFixture()
    let rejectFirstPlay: (reason: unknown) => void = () => undefined
    fixture.element.play = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPlay = reject
        }),
    )
    const first = fixture.player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 2,
      countdownSeconds: 3,
    })
    fixture.player.pause()
    fixture.element.play = vi.fn(() => {
      fixture.setPaused(false)
      return Promise.resolve()
    })
    await fixture.player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 2,
      countdownSeconds: 3,
    })

    rejectFirstPlay(new DOMException('old rejection', 'NotAllowedError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.player.getSnapshot()).toMatchObject({ phase: 'countdown', failure: null })
  })

  it('waits for the loop-start seek to settle before reporting audible playback', async () => {
    const { context, element, player } = createPlayerFixture()
    let seeking = false
    let readyState = 4
    Object.defineProperty(element, 'seeking', { configurable: true, get: () => seeking })
    Object.defineProperty(element, 'readyState', { configurable: true, get: () => readyState })
    await player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 12,
      countdownSeconds: 3,
    })
    context.currentTime = 13
    expect(player.updateCountdown()).toBe(0)
    seeking = true
    readyState = 1
    expect(player.beginAudible(5)).toBe(false)
    expect(player.getSnapshot().phase).toBe('countdown')
    element.dispatchEvent(new Event('waiting'))
    seeking = false
    readyState = 3
    element.dispatchEvent(new Event('canplay'))
    element.dispatchEvent(new Event('seeked'))
    expect(player.beginAudible(5)).toBe(true)
    expect(player.getSnapshot()).toMatchObject({ phase: 'playing', failure: null })
  })

  it('marks a playing interval invalid while buffering and reanchors on playing', async () => {
    const { context, element, player } = createPlayerFixture()
    await player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 12,
      countdownSeconds: 0,
    })
    context.currentTime = 11
    element.currentTime = 6
    element.dispatchEvent(new Event('waiting'))
    expect(player.getSnapshot().phase).toBe('playing')
    expect(player.currentProjectTime()).toBeNull()

    element.currentTime = 6.25
    element.dispatchEvent(new Event('playing'))
    expect(player.getSnapshot()).toMatchObject({ phase: 'playing', failure: null, message: null })
    expect(player.currentProjectTime()).toBeCloseTo(6.25)
    expect(context.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 11.025)
  })

  it('enters retry only after buffering remains stalled beyond the watchdog', async () => {
    vi.useFakeTimers()
    try {
      const { element, player } = createPlayerFixture()
      await player.activateFromGesture({
        loopStartSeconds: 5,
        loopEndSeconds: 12,
        countdownSeconds: 0,
      })
      element.dispatchEvent(new Event('waiting'))
      vi.advanceTimersByTime(3_999)
      expect(player.getSnapshot().phase).toBe('playing')
      element.dispatchEvent(new Event('stalled'))
      vi.advanceTimersByTime(1)
      expect(player.getSnapshot()).toMatchObject({
        phase: 'retry',
        failure: 'media-stalled',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a standalone stalled event when Safari still has future data', async () => {
    vi.useFakeTimers()
    try {
      const { element, player } = createPlayerFixture()
      Object.defineProperty(element, 'readyState', { configurable: true, get: () => 3 })
      await player.activateFromGesture({
        loopStartSeconds: 0,
        loopEndSeconds: 2,
        countdownSeconds: 0,
      })
      element.dispatchEvent(new Event('stalled'))
      vi.advanceTimersByTime(4_001)
      expect(player.getSnapshot()).toMatchObject({ phase: 'playing', failure: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts an ended event at the loop boundary but rejects an early end', async () => {
    const expected = createPlayerFixture()
    await expected.player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 8,
      countdownSeconds: 0,
    })
    expected.element.currentTime = 8
    expected.element.dispatchEvent(new Event('ended'))
    expect(expected.player.getSnapshot()).toMatchObject({ phase: 'playing', failure: null })
    expect(expected.player.currentProjectTime()).toBeCloseTo(8)

    const early = createPlayerFixture()
    await early.player.activateFromGesture({
      loopStartSeconds: 5,
      loopEndSeconds: 8,
      countdownSeconds: 0,
    })
    early.element.currentTime = 7.5
    early.element.dispatchEvent(new Event('ended'))
    expect(early.player.getSnapshot()).toMatchObject({
      phase: 'retry',
      failure: 'media-ended',
    })
  })

  it('re-primes a short reference that reaches its end during countdown', async () => {
    const { element, player, play } = createPlayerFixture()
    await player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 1,
      countdownSeconds: 3,
    })
    element.currentTime = 1
    element.dispatchEvent(new Event('ended'))
    expect(player.getSnapshot()).toMatchObject({ phase: 'countdown', failure: null })
    expect(element.currentTime).toBe(0)
    expect(play).toHaveBeenCalledTimes(2)
  })

  it('ignores a queued countdown end delivered after the audible rewind', async () => {
    const { context, element, player } = createPlayerFixture()
    await player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 1,
      countdownSeconds: 3,
    })
    context.currentTime = 13
    expect(player.updateCountdown()).toBe(0)
    element.currentTime = 1
    expect(player.beginAudible(0)).toBe(true)
    element.dispatchEvent(new Event('ended'))
    expect(player.getSnapshot()).toMatchObject({ phase: 'playing', failure: null })
  })
})

describe('microphone and recording helpers', () => {
  it('preserves detector rejection reasons instead of labeling every missed note as silence', () => {
    const candidate = {
      type: 'pitch-candidate' as const,
      contextTimeSeconds: 1,
      frequencyHz: null,
      confidence: 0.4,
      rms: 0.1,
      peak: 0.2,
      analysisGap: false,
      scorable: false,
      reason: 'out-of-range' as const,
    }

    expect(pitchCandidateGapReason(candidate, true, false)).toBe('out-of-range')
    expect(pitchCandidateGapReason({ ...candidate, reason: 'low-confidence' }, true, false)).toBe(
      'below-confidence',
    )
    expect(pitchCandidateGapReason(candidate, false, false)).toBe('timeline-gap')
  })

  it('requests ideal raw capture settings without claiming they were applied', () => {
    expect(createMicrophoneConstraints({ profile: 'raw', deviceId: 'mic-2' })).toEqual({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
        deviceId: { exact: 'mic-2' },
      },
      video: false,
    })
  })

  it('prioritizes Safari MP4/AAC recording', () => {
    expect(selectRecorderMimeType((mime) => mime === 'audio/mp4')).toBe('audio/mp4')
    expect(selectRecorderMimeType(() => false)).toBeUndefined()
  })

  it('commits an interrupted take after all one-second chunks', async () => {
    class FakeRecorder extends EventTarget {
      state: RecordingState = 'inactive'
      mimeType = 'audio/mp4'
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.dispatchEvent(new Event('stop'))
      })
      pause = vi.fn(() => {
        this.state = 'paused'
        this.dispatchEvent(new Event('pause'))
      })
      resume = vi.fn(() => {
        this.state = 'recording'
        this.dispatchEvent(new Event('resume'))
      })
    }
    const mediaRecorder = new FakeRecorder()
    const track = new EventTarget()
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream
    const mutableClock = Object.assign(new EventTarget(), {
      currentTime: 20,
      state: 'running' as const,
      resume: () => Promise.resolve(),
    })
    const clock: ClockLike = mutableClock
    const append = vi.fn(() => Promise.resolve())
    const commit = vi.fn(() => Promise.resolve())
    const sink: RecorderChunkSink = {
      append,
      commit,
      abort: vi.fn(() => Promise.resolve()),
    }
    const recorder = new ForegroundRecorder({
      stream,
      clock,
      sink,
      limits: { maxBytes: 1024, maxDurationSeconds: 900 },
      createRecorder: () => mediaRecorder as unknown as MediaRecorder,
    })
    recorder.startFromGesture()
    mutableClock.currentTime = 21
    const chunkEvent = new Event('dataavailable') as BlobEvent
    Object.defineProperty(chunkEvent, 'data', { value: new Blob(['audio']) })
    mediaRecorder.dispatchEvent(chunkEvent)
    expect(recorder.pauseForBuffering()).toBe(true)
    mutableClock.currentTime = 24
    expect(recorder.resumeAfterBuffering()).toBe(true)
    mutableClock.currentTime = 25
    const interruption = recorder.interrupt('app-backgrounded')
    mutableClock.currentTime = 99
    await interruption
    expect(append).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        partialReason: 'app-backgrounded',
        mimeType: 'audio/mp4',
        durationSeconds: 2,
      }),
    )
    expect(recorder.getSnapshot().durationSeconds).toBe(2)
  })

  it('aborts and freezes a recorder whose native start throws', async () => {
    class FailingRecorder extends EventTarget {
      state: RecordingState = 'inactive'
      mimeType = 'audio/mp4'
      start = vi.fn(() => {
        throw new DOMException('unsupported', 'NotSupportedError')
      })
      stop = vi.fn()
    }
    const mediaRecorder = new FailingRecorder()
    const track = new EventTarget()
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream
    const clock = Object.assign(new EventTarget(), {
      currentTime: 20,
      state: 'running' as const,
      resume: () => Promise.resolve(),
    })
    const abort = vi.fn(() => Promise.resolve())
    const recorder = new ForegroundRecorder({
      stream,
      clock,
      sink: { append: vi.fn(), commit: vi.fn(), abort },
      limits: { maxBytes: 1024, maxDurationSeconds: 900 },
      createRecorder: () => mediaRecorder as unknown as MediaRecorder,
    })

    expect(() => recorder.startFromGesture()).toThrow('unsupported')
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce())
    expect(recorder.getSnapshot()).toMatchObject({
      phase: 'error',
      durationSeconds: 0,
      error: 'unsupported',
    })
  })

  it('stops and aborts an active recorder after a native error event', async () => {
    class ErrorRecorder extends EventTarget {
      state: RecordingState = 'inactive'
      mimeType = 'audio/mp4'
      start = vi.fn(() => {
        this.state = 'recording'
      })
      stop = vi.fn(() => {
        this.state = 'inactive'
        this.dispatchEvent(new Event('stop'))
      })
    }
    const mediaRecorder = new ErrorRecorder()
    const track = new EventTarget()
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream
    const clock = Object.assign(new EventTarget(), {
      currentTime: 20,
      state: 'running' as const,
      resume: () => Promise.resolve(),
    })
    const abort = vi.fn(() => Promise.resolve())
    const recorder = new ForegroundRecorder({
      stream,
      clock,
      sink: { append: vi.fn(), commit: vi.fn(), abort },
      limits: { maxBytes: 1024, maxDurationSeconds: 900 },
      createRecorder: () => mediaRecorder as unknown as MediaRecorder,
    })
    recorder.startFromGesture()
    clock.currentTime = 21
    const errorEvent = new Event('error') as Event & { error?: DOMException }
    errorEvent.error = new DOMException('encoder failed', 'UnknownError')
    mediaRecorder.dispatchEvent(errorEvent)

    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce())
    expect(mediaRecorder.stop).toHaveBeenCalledOnce()
    expect(recorder.getSnapshot()).toMatchObject({
      phase: 'error',
      durationSeconds: 1,
      error: 'encoder failed',
    })
  })
})
