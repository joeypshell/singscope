import { describe, expect, it, vi } from 'vitest'
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

describe('ReferencePlayer', () => {
  it('starts playback inside activation and uses context time for alignment', async () => {
    const context = new FakeContext()
    const element = document.createElement('audio')
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

    const activation = player.activateFromGesture({ loopStartSeconds: 5, countdownSeconds: 3 })
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
})

describe('microphone and recording helpers', () => {
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
    await recorder.interrupt('app-backgrounded')
    expect(append).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ partialReason: 'app-backgrounded', mimeType: 'audio/mp4' }),
    )
  })
})
