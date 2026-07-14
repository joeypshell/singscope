import { describe, expect, it } from 'vitest'

import { analyzePcm } from './analyze'
import { resampleLinear } from './resample'
import { YinPitchDetector } from './yin'

function sine(
  sampleRateHz: number,
  frequencyHz: number,
  durationSeconds = 0.064,
  amplitude = 0.5,
): Float32Array {
  const length = Math.round(sampleRateHz * durationSeconds)
  return Float32Array.from(
    { length },
    (_, index) => amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz),
  )
}

function centsError(observedHz: number, expectedHz: number): number {
  return Math.abs(1200 * Math.log2(observedHz / expectedHz))
}

function seededNoise(length: number, amplitude = 0.25): Float32Array {
  let state = 0x1234_5678
  return Float32Array.from({ length }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return ((state / 0xffff_ffff) * 2 - 1) * amplitude
  })
}

describe('YinPitchDetector', () => {
  it.each([44_100, 48_000, 96_000])(
    'keeps clean 80-1000 Hz fixtures within 15 cents at %i Hz input',
    (sampleRateHz) => {
      for (const frequencyHz of [80, 220, 440, 1_000]) {
        const estimate = new YinPitchDetector().detect(
          sine(sampleRateHz, frequencyHz),
          sampleRateHz,
        )
        expect(estimate.reason, `${frequencyHz} Hz reason`).toBeNull()
        expect(estimate.frequencyHz, `${frequencyHz} Hz result`).not.toBeNull()
        expect(
          centsError(estimate.frequencyHz ?? 1, frequencyHz),
          `${frequencyHz} Hz error`,
        ).toBeLessThan(15)
        expect(estimate.confidence).toBeGreaterThanOrEqual(0.75)
      }
    },
  )

  it('represents silence with nulls and rejects deterministic broadband noise', () => {
    const detector = new YinPitchDetector()
    const silence = detector.detect(new Float32Array(1_536), 24_000)
    expect(silence).toMatchObject({
      candidateHz: null,
      frequencyHz: null,
      confidence: null,
      reason: 'silence',
    })

    const noise = detector.detect(seededNoise(1_536), 24_000)
    expect(noise.frequencyHz).toBeNull()
    expect(noise.reason).toBe('low-confidence')
    expect(noise.candidateHz).not.toBeNull()
    expect(Number.isFinite(noise.confidence)).toBe(true)
  })

  it('adapts the gate to quiet frames and resets deterministically', () => {
    const detector = new YinPitchDetector()
    const before = detector.noiseFloorRms
    detector.detect(sine(24_000, 220, 0.064, 0.001), 24_000)
    expect(detector.noiseFloorRms).toBeLessThan(before)
    detector.reset()
    expect(detector.noiseFloorRms).toBeCloseTo(before)
  })

  it('does not learn loud aperiodic note attacks as the ambient noise floor', () => {
    const detector = new YinPitchDetector()
    const before = detector.noiseFloorRms

    for (let index = 0; index < 40; index += 1) {
      expect(detector.detect(seededNoise(1_536), 24_000).reason).toBe('low-confidence')
    }

    expect(detector.noiseFloorRms).toBeCloseTo(before)
    const quietSustain = detector.detect(sine(24_000, 220, 0.064, 0.006), 24_000)
    expect(quietSustain.reason).toBeNull()
    expect(quietSustain.frequencyHz).toBeCloseTo(220, 0)
  })

  it('tracks octave changes without target-assisted correction', () => {
    const detector = new YinPitchDetector()
    const lower = detector.detect(sine(48_000, 220), 48_000)
    const upper = detector.detect(sine(48_000, 440), 48_000)
    expect(lower.frequencyHz).toBeCloseTo(220, 0)
    expect(upper.frequencyHz).toBeCloseTo(440, 0)
    expect((upper.frequencyHz ?? 0) / (lower.frequencyHz ?? 1)).toBeCloseTo(2, 2)
  })
})

describe('sample-rate normalization and frame pipeline', () => {
  it('preserves duration when normalizing native PCM to 24 kHz', () => {
    const input = sine(96_000, 330, 0.5)
    const output = resampleLinear(input, 96_000, 24_000)
    expect(output).toHaveLength(12_000)
  })

  it('uses 64 ms frames and 20 ms hops for a deterministic melody', () => {
    const sampleRateHz = 48_000
    const melody = new Float32Array(sampleRateHz * 3)
    for (let second = 0; second < 3; second += 1) {
      const frequencyHz = [220, 440, 330][second] ?? 220
      for (let index = 0; index < sampleRateHz; index += 1) {
        melody[second * sampleRateHz + index] =
          0.4 * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz)
      }
    }
    const frames = analyzePcm(melody, sampleRateHz)
    expect(frames[0]?.frameCenterSeconds).toBeCloseTo(0.032)
    expect(frames[1]?.frameCenterSeconds).toBeCloseTo(0.052)
    expect(frames).toHaveLength(147)

    for (const [startSeconds, expectedHz] of [
      [0, 220],
      [1, 440],
      [2, 330],
    ] as const) {
      const settled = frames.filter(
        (frame) =>
          frame.frameCenterSeconds > startSeconds + 0.15 &&
          frame.frameCenterSeconds < startSeconds + 0.85 &&
          frame.estimate.frequencyHz !== null,
      )
      const median = [...settled]
        .map((frame) => frame.estimate.frequencyHz ?? 0)
        .sort((left, right) => left - right)[Math.floor(settled.length / 2)]
      expect(median).toBeDefined()
      expect(centsError(median ?? 1, expectedHz)).toBeLessThan(15)
    }
  })

  it('follows a clean glide after settling', () => {
    const sampleRateHz = 48_000
    const durationSeconds = 1
    const glide = Float32Array.from({ length: sampleRateHz }, (_, index) => {
      const time = index / sampleRateHz
      const startHz = 180
      const slopeHzPerSecond = 180 / durationSeconds
      const phaseCycles = startHz * time + (slopeHzPerSecond * time * time) / 2
      return 0.4 * Math.sin(2 * Math.PI * phaseCycles)
    })
    const voiced = analyzePcm(glide, sampleRateHz).filter(
      (frame) => frame.estimate.frequencyHz !== null,
    )
    const early = voiced.find((frame) => frame.frameCenterSeconds >= 0.2)
    const late = voiced.find((frame) => frame.frameCenterSeconds >= 0.8)
    expect(early?.estimate.frequencyHz).toBeLessThan(late?.estimate.frequencyHz ?? 0)
  })
})
