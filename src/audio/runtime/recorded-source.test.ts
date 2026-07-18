import { describe, expect, it, vi } from 'vitest'

import {
  RECORDED_SOURCE_LIMITS,
  RecordedSourceCapture,
  type RecordedSourceCaptureDependencies,
} from './recorded-source'
import type { CaptureSettings } from './types'

class FakeAudioContext extends EventTarget {
  currentTime = 10
  state: AudioContextState = 'suspended'
  readonly resume = vi.fn(() => {
    this.state = 'running'
    return Promise.resolve()
  })
  readonly close = vi.fn(() => {
    this.state = 'closed'
    return Promise.resolve()
  })
}

class FakeTrack extends EventTarget {
  readonly stop = vi.fn()
}

class FakeMediaRecorder extends EventTarget {
  state: RecordingState = 'inactive'
  finalChunk: Blob | null = null
  readonly start = vi.fn((timeslice?: number) => {
    void timeslice
    this.state = 'recording'
  })
  readonly stop = vi.fn(() => {
    this.state = 'inactive'
    queueMicrotask(() => {
      if (this.finalChunk) this.emitChunk(this.finalChunk)
      this.dispatchEvent(new Event('stop'))
    })
  })

  constructor(readonly mimeType: string) {
    super()
  }

  emitChunk(blob: Blob): void {
    const event = new Event('dataavailable') as BlobEvent
    Object.defineProperty(event, 'data', { value: blob })
    this.dispatchEvent(event)
  }
}

class FakeVisibility extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

const SETTINGS: CaptureSettings = {
  deviceId: 'mic-1',
  label: 'Built-in microphone',
  sampleRate: 48_000,
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

interface Fixture {
  readonly capture: RecordedSourceCapture
  readonly context: FakeAudioContext
  readonly recorder: FakeMediaRecorder
  readonly track: FakeTrack
  readonly request: ReturnType<typeof vi.fn>
  readonly visibility: FakeVisibility
}

function fixture(
  overrides: Partial<RecordedSourceCaptureDependencies> = {},
  actualMimeType = 'audio/mp4;codecs=mp4a.40.2',
): Fixture {
  const context = new FakeAudioContext()
  const recorder = new FakeMediaRecorder(actualMimeType)
  const track = new FakeTrack()
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream
  const request = vi.fn(() => Promise.resolve({ stream, settings: SETTINGS }))
  const visibility = new FakeVisibility()
  const capture = new RecordedSourceCapture({
    createAudioContext: () => context as unknown as AudioContext,
    requestMicrophone: request,
    selectMimeType: () => 'audio/mp4',
    createMediaRecorder: () => recorder as unknown as MediaRecorder,
    document: visibility as unknown as Document,
    window,
    ...overrides,
  })
  return { capture, context, recorder, track, request, visibility }
}

describe('RecordedSourceCapture', () => {
  it('records one finalized source blob and returns the actual MIME with canonical duration', async () => {
    const { capture, context, recorder, request, track } = fixture()
    const phases: string[] = []
    capture.subscribe((snapshot) => phases.push(snapshot.phase))

    await capture.start()

    expect(request).toHaveBeenCalledWith({ profile: 'raw' }, undefined)
    expect(context.resume).toHaveBeenCalledOnce()
    expect(recorder.start).toHaveBeenCalledWith()
    expect(capture.getSnapshot()).toMatchObject({
      phase: 'recording',
      settings: SETTINGS,
    })

    context.currentTime = 11.25
    recorder.finalChunk = new Blob(['encoded-audio'], { type: 'audio/mp4' })
    const result = await capture.stop()

    expect(result).toEqual(await capture.result)
    expect(result.mimeType).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(result.blob.type).toBe('audio/mp4;codecs=mp4a.40.2')
    expect(await result.blob.text()).toBe('encoded-audio')
    expect(result.durationSeconds).toBeCloseTo(1.25)
    expect(result.settings).toEqual(SETTINGS)
    expect(result.partialReason).toBeNull()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(phases).toContain('finalizing')
    expect(capture.getSnapshot().phase).toBe('complete')
  })

  it('reasserts the iPhone capture route after permission and restores playback on cleanup', async () => {
    const reassert = vi.fn()
    const release = vi.fn()
    const { capture, context, recorder } = fixture({
      beginAudioCapture: () => ({ reassert, release }),
    })
    await capture.start()
    expect(reassert).toHaveBeenCalledOnce()

    context.currentTime = 10.5
    recorder.finalChunk = new Blob(['encoded-audio'], { type: 'audio/mp4' })
    await capture.stop()
    expect(release).toHaveBeenCalledOnce()
  })

  it('finalizes foreground loss as a partial result without auto-resuming', async () => {
    const { capture, context, recorder, track, visibility } = fixture()
    await capture.start()
    context.currentTime = 12
    recorder.finalChunk = new Blob(['partial'])

    visibility.visibilityState = 'hidden'
    visibility.dispatchEvent(new Event('visibilitychange'))
    const result = await capture.result

    expect(result.partialReason).toBe('page-hidden')
    expect(result.durationSeconds).toBe(2)
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(capture.getSnapshot().phase).toBe('complete')
  })

  it('rejects an oversized finalized source instead of returning a corrupt container', async () => {
    const { capture, recorder } = fixture()
    await capture.start()
    recorder.finalChunk = new Blob([new Uint8Array(RECORDED_SOURCE_LIMITS.maxBytes + 1)])

    await expect(capture.stop()).rejects.toThrow('Recorded melody exceeds the 8 MiB limit')
    expect(capture.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Recorded melody exceeds the 8 MiB limit. Record a shorter melody.',
    })
  })

  it('uses a monitor only to sample AudioContext time at the 60-second source limit', async () => {
    vi.useFakeTimers()
    try {
      const { capture, context, recorder } = fixture()
      await capture.start()
      recorder.finalChunk = new Blob(['complete-container'])
      context.currentTime += RECORDED_SOURCE_LIMITS.maxDurationSeconds
      await vi.advanceTimersByTimeAsync(250)

      const result = await capture.result
      expect(result.partialReason).toBe('duration-limit')
      expect(result.durationSeconds).toBe(RECORDED_SOURCE_LIMITS.maxDurationSeconds)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an empty final Safari recording instead of attempting to decode it', async () => {
    const { capture } = fixture()
    await capture.start()

    await expect(capture.stop()).rejects.toThrow(
      'Safari finished the recording without usable audio bytes',
    )
    expect(capture.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Safari finished the recording without usable audio bytes. Record again.',
    })
  })

  it('discards an active capture and releases every host resource', async () => {
    const { capture, context, recorder, track } = fixture()
    await capture.start()
    recorder.emitChunk(new Blob(['unused']))
    const rejectedResult = expect(capture.result).rejects.toMatchObject({ name: 'AbortError' })

    await capture.discard()

    await rejectedResult
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(capture.getSnapshot()).toMatchObject({
      phase: 'discarded',
      byteLength: 0,
      durationSeconds: 0,
    })
  })

  it('reports permission failure and closes the already-created AudioContext', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    const context = new FakeAudioContext()
    const capture = new RecordedSourceCapture({
      createAudioContext: () => context as unknown as AudioContext,
      requestMicrophone: () => Promise.reject(denied),
      selectMimeType: () => 'audio/mp4',
    })
    const rejectedResult = expect(capture.result).rejects.toBe(denied)

    await expect(capture.start()).rejects.toBe(denied)

    await rejectedResult
    expect(context.resume).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(capture.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Permission denied',
    })
  })
})
