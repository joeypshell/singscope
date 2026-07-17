import { describe, expect, it, vi } from 'vitest'

import { MelodyPreviewPlayer } from './melody-preview'

class FakeAudioParam {
  value = 1
  readonly setValueAtTime = vi.fn()
  readonly linearRampToValueAtTime = vi.fn()
}

class FakeGainNode {
  readonly gain = new FakeAudioParam()
  readonly connect = vi.fn(<T>(destination: T) => destination)
  readonly disconnect = vi.fn()
}

class FakeOscillatorNode {
  type: OscillatorType = 'sine'
  readonly frequency = { value: 0 }
  onended: (() => void) | null = null
  readonly connect = vi.fn(<T>(destination: T) => destination)
  readonly disconnect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()

  finish(): void {
    this.onended?.()
  }
}

class FakeAudioContext {
  currentTime = 10
  state: AudioContextState = 'suspended'
  readonly destination = {} as AudioDestinationNode
  readonly gains: FakeGainNode[] = []
  readonly oscillators: FakeOscillatorNode[] = []
  readonly resume = vi.fn(() => {
    this.state = 'running'
    return Promise.resolve()
  })
  readonly close = vi.fn(() => {
    this.state = 'closed'
    return Promise.resolve()
  })
  readonly createGain = vi.fn(() => {
    const gain = new FakeGainNode()
    this.gains.push(gain)
    return gain
  })
  readonly createOscillator = vi.fn(() => {
    const oscillator = new FakeOscillatorNode()
    this.oscillators.push(oscillator)
    return oscillator
  })
}

function fixture(): {
  readonly context: FakeAudioContext
  readonly createAudioContext: ReturnType<typeof vi.fn<() => AudioContext>>
  readonly player: MelodyPreviewPlayer
} {
  const context = new FakeAudioContext()
  const createAudioContext = vi.fn(() => context as unknown as AudioContext)
  return {
    context,
    createAudioContext,
    player: new MelodyPreviewPlayer(createAudioContext),
  }
}

describe('MelodyPreviewPlayer', () => {
  it('resumes Safari audio synchronously and auditions A4 at 440 Hz', async () => {
    const { context, createAudioContext, player } = fixture()

    const activation = player.audition(69)

    expect(createAudioContext).toHaveBeenCalledOnce()
    expect(context.resume).toHaveBeenCalledOnce()
    expect(context.oscillators).toHaveLength(1)
    expect(context.oscillators[0]?.frequency.value).toBe(440)
    expect(context.oscillators[0]?.type).toBe('triangle')
    expect(context.oscillators[0]?.start).toHaveBeenCalledWith(10.025)
    expect(context.oscillators[0]?.stop).toHaveBeenCalledWith(10.495)

    await expect(activation).resolves.toBeUndefined()
  })

  it('anchors a sorted sequence and its gaps to AudioContext.currentTime', async () => {
    const { context, player } = fixture()
    context.currentTime = 42
    const onEnded = vi.fn()

    const result = player.play(
      [
        { displayedMidiNote: 71, startSeconds: 6, endSeconds: 6.25 },
        { displayedMidiNote: 69, startSeconds: 5, endSeconds: 5.5 },
      ],
      onEnded,
    )

    expect(context.resume).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ noteCount: 2, durationSeconds: 1.25, truncated: false })
    expect(context.oscillators).toHaveLength(2)
    expect(context.oscillators[0]?.frequency.value).toBe(440)
    expect(context.oscillators[0]?.start).toHaveBeenCalledWith(42.025)
    expect(context.oscillators[0]?.stop).toHaveBeenCalledWith(42.545)
    expect(context.oscillators[1]?.frequency.value).toBeCloseTo(493.883, 3)
    expect(context.oscillators[1]?.start).toHaveBeenCalledWith(43.025)
    expect(context.oscillators[1]?.stop).toHaveBeenCalledWith(43.295)

    context.oscillators[0]?.finish()
    expect(onEnded).not.toHaveBeenCalled()
    context.oscillators[1]?.finish()
    expect(onEnded).toHaveBeenCalledOnce()
    await expect(result.activation).resolves.toBeUndefined()
  })

  it('cancels scheduled completion when sequence playback is stopped', () => {
    const { context, player } = fixture()
    const onEnded = vi.fn()
    player.play([{ displayedMidiNote: 60, startSeconds: 0, endSeconds: 1 }], onEnded)
    const oscillator = context.oscillators[0]

    context.currentTime = 10.4
    player.stopSequence()

    expect(oscillator?.stop).toHaveBeenLastCalledWith(10.4)
    expect(oscillator?.disconnect).toHaveBeenCalledOnce()
    oscillator?.finish()
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('stops active audio, disconnects the graph, and closes its context', async () => {
    const { context, player } = fixture()
    await player.audition(72)
    const oscillator = context.oscillators[0]
    const masterGain = context.gains[0]

    await player.close()

    expect(oscillator?.stop).toHaveBeenLastCalledWith(10)
    expect(oscillator?.disconnect).toHaveBeenCalledOnce()
    expect(masterGain?.disconnect).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('rejects invalid auditions without creating a context and bounds long previews', async () => {
    const { context, createAudioContext, player } = fixture()

    await expect(player.audition(128)).rejects.toThrow(RangeError)
    expect(createAudioContext).not.toHaveBeenCalled()

    const result = player.play(
      [{ displayedMidiNote: 60, startSeconds: 0, endSeconds: 200 }],
      vi.fn(),
    )
    expect(result).toMatchObject({ noteCount: 1, durationSeconds: 120, truncated: true })
    expect(context.oscillators[0]?.stop.mock.calls[0]?.[0]).toBeCloseTo(130.045)
  })
})
