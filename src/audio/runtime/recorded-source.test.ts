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
  readonly start = vi.fn((timeslice?: number) => {
    void timeslice
    this.state = 'recording'
  })
  readonly stop = vi.fn(() => {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
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
  it('records one-second chunks and returns the actual MIME with canonical duration', async () => {
    const { capture, context, recorder, request, track } = fixture()
    const phases: string[] = []
    capture.subscribe((snapshot) => phases.push(snapshot.phase))

    await capture.start()

    expect(request).toHaveBeenCalledWith({ profile: 'raw' }, undefined)
    expect(context.resume).toHaveBeenCalledOnce()
    expect(recorder.start).toHaveBeenCalledWith(1000)
    expect(capture.getSnapshot()).toMatchObject({
      phase: 'recording',
      settings: SETTINGS,
    })

    context.currentTime = 11.25
    recorder.emitChunk(new Blob(['encoded-audio'], { type: 'audio/mp4' }))
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

  it('finalizes foreground loss as a partial result without auto-resuming', async () => {
    const { capture, context, recorder, track, visibility } = fixture()
    await capture.start()
    context.currentTime = 12
    recorder.emitChunk(new Blob(['partial']))

    visibility.visibilityState = 'hidden'
    visibility.dispatchEvent(new Event('visibilitychange'))
    const result = await capture.result

    expect(result.partialReason).toBe('page-hidden')
    expect(result.durationSeconds).toBe(2)
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(capture.getSnapshot().phase).toBe('complete')
  })

  it('keeps the last complete encoded chunk when the 8 MiB limit is crossed', async () => {
    const { capture, recorder } = fixture()
    await capture.start()
    const retained = new Blob([new Uint8Array(RECORDED_SOURCE_LIMITS.maxBytes - 1024)])
    recorder.emitChunk(retained)
    recorder.emitChunk(new Blob([new Uint8Array(2048)]))

    const result = await capture.result
    expect(result.partialReason).toBe('size-limit')
    expect(result.blob.size).toBe(retained.size)
    expect(result.blob.size).toBeLessThanOrEqual(RECORDED_SOURCE_LIMITS.maxBytes)
  })

  it('uses AudioContext time to stop at the 60-second source limit', async () => {
    const { capture, context, recorder } = fixture()
    await capture.start()
    context.currentTime += RECORDED_SOURCE_LIMITS.maxDurationSeconds
    recorder.emitChunk(new Blob(['last-complete-chunk']))

    const result = await capture.result
    expect(result.partialReason).toBe('duration-limit')
    expect(result.durationSeconds).toBe(RECORDED_SOURCE_LIMITS.maxDurationSeconds)
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
