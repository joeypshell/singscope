import { describe, expect, it, vi } from 'vitest'

import { renderMelodyReferenceWav } from '../dsp/melody-reference'
import { createGeneratedPcmAudioBuffer } from './pcm-wav-buffer'
import { SynthesizedReferencePlayer } from './synthesized-reference-player'

class FakeAudioParam {
  value = 1
  readonly setValueAtTime = vi.fn()
  readonly cancelScheduledValues = vi.fn()
  readonly linearRampToValueAtTime = vi.fn()
}

class FakeNode {
  readonly connect = vi.fn().mockReturnThis()
  readonly disconnect = vi.fn()
}

class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  readonly start = vi.fn()
  readonly stop = vi.fn()
}

class FakeContext extends EventTarget {
  currentTime = 10
  state: AudioContextState = 'suspended'
  destination = {} as AudioDestinationNode
  readonly sources: FakeSource[] = []
  readonly resume = vi.fn(() => {
    this.state = 'running'
    return Promise.resolve()
  })
  readonly createGain = vi.fn(() => Object.assign(new FakeNode(), { gain: new FakeAudioParam() }))
  readonly createBufferSource = vi.fn(() => {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  })
}

function wav(): ArrayBuffer {
  return renderMelodyReferenceWav({
    notes: [{ midiNote: 69, startSeconds: 0, endSeconds: 0.5 }],
    transpositionSemitones: 0,
    alignmentSeconds: 0,
    timelineDurationSeconds: 1,
  })
}

describe('generated PCM AudioBuffer conversion', () => {
  it('copies deterministic little-endian PCM without browser decoding', () => {
    let channel = new Float32Array()
    const context = {
      createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
        channel = new Float32Array(length)
        return {
          duration: length / sampleRate,
          getChannelData: () => channel,
        } as unknown as AudioBuffer
      }),
    } as unknown as BaseAudioContext

    const buffer = createGeneratedPcmAudioBuffer(context, wav())
    expect(buffer.duration).toBeCloseTo(1.25)
    expect(Math.max(...channel.slice(0, 8_000))).toBeGreaterThan(0.35)
    expect(channel.slice(-100).every((sample) => sample === 0)).toBe(true)
  })

  it('rejects corrupt or truncated generated containers', () => {
    const context = { createBuffer: vi.fn() } as unknown as BaseAudioContext
    const corrupt = wav()
    new DataView(corrupt).setUint8(0, 0)
    expect(() => createGeneratedPcmAudioBuffer(context, corrupt)).toThrow(/not supported/)
    expect(() => createGeneratedPcmAudioBuffer(context, wav().slice(0, -2))).toThrow(/inconsistent/)
  })
})

describe('SynthesizedReferencePlayer', () => {
  it('unlocks from the Start gesture and waits until countdown ends to consume media', async () => {
    const context = new FakeContext()
    const buffer = { duration: 1.25 } as AudioBuffer
    const player = new SynthesizedReferencePlayer({
      context: context as unknown as AudioContext,
      buffer,
    })

    const activation = player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 1,
      countdownSeconds: 3,
    })
    expect(context.resume).toHaveBeenCalledOnce()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0]?.start).toHaveBeenCalledWith(0, 0, 0.005)
    await activation
    expect(player.getSnapshot().phase).toBe('countdown')
    expect(player.currentProjectTime()).toBeNull()

    context.currentTime = 13
    expect(player.updateCountdown()).toBe(0)
    expect(player.beginAudible(0)).toBe(true)
    expect(context.sources).toHaveLength(2)
    expect(context.sources[1]?.start).toHaveBeenCalledWith(13, 0, 1)
    context.currentTime = 13.5
    expect(player.currentProjectTime()).toBeCloseTo(0.5)
  })

  it('recreates its one-shot source for a playing seek and stops it on pause', async () => {
    const context = new FakeContext()
    const player = new SynthesizedReferencePlayer({
      context: context as unknown as AudioContext,
      buffer: { duration: 4 } as AudioBuffer,
    })
    await player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 4,
      countdownSeconds: 0,
    })
    const firstAudible = context.sources[1]
    expect(firstAudible?.start).toHaveBeenCalledWith(10, 0, 4)

    context.currentTime = 11
    player.seek(2)
    const secondAudible = context.sources[2]
    expect(firstAudible?.stop).toHaveBeenCalledWith(11)
    expect(secondAudible?.start).toHaveBeenCalledWith(11, 2, 2)
    player.pause()
    expect(secondAudible?.stop).toHaveBeenCalledWith(11)
    expect(player.currentProjectTime()).toBeNull()
  })

  it('fails visibly when the AudioContext is interrupted', async () => {
    const context = new FakeContext()
    const player = new SynthesizedReferencePlayer({
      context: context as unknown as AudioContext,
      buffer: { duration: 2 } as AudioBuffer,
    })
    await player.activateFromGesture({
      loopStartSeconds: 0,
      loopEndSeconds: 1,
      countdownSeconds: 0,
    })
    context.state = 'suspended'
    context.dispatchEvent(new Event('statechange'))
    expect(player.getSnapshot()).toMatchObject({
      phase: 'retry',
      failure: 'context-interrupted',
    })
  })
})
