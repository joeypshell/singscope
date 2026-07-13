import { midiToFrequency } from '../../domain/pitch'
import type { DetectedPitchPoint } from '../../domain/types'

export interface DisplayPitchPoint {
  readonly timeSeconds: number
  readonly rawFrequencyHz: number | null
  readonly rawMidiNote: number | null
  readonly smoothedFrequencyHz: number | null
  readonly smoothedMidiNote: number | null
  readonly confidence: number | null
  readonly gapReason: string | null
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Causal median-of-three followed by EMA. Raw points are never mutated. */
export class PitchDisplaySmoother {
  readonly #alpha: number
  readonly #recentMidi: number[] = []
  #emaMidi: number | null = null

  constructor(alpha = 0.45) {
    if (!(Number.isFinite(alpha) && alpha > 0 && alpha <= 1)) {
      throw new RangeError('alpha must be greater than zero and at most one')
    }
    this.#alpha = alpha
  }

  reset(): void {
    this.#recentMidi.length = 0
    this.#emaMidi = null
  }

  push(point: DetectedPitchPoint): DisplayPitchPoint {
    if (point.midiNote === null || point.frequencyHz === null || point.gapReason !== null) {
      this.reset()
      return {
        timeSeconds: point.timeSeconds,
        rawFrequencyHz: point.frequencyHz,
        rawMidiNote: point.midiNote,
        smoothedFrequencyHz: null,
        smoothedMidiNote: null,
        confidence: point.confidence,
        gapReason: point.gapReason,
      }
    }

    this.#recentMidi.push(point.midiNote)
    if (this.#recentMidi.length > 3) this.#recentMidi.shift()
    const filtered = median(this.#recentMidi)
    this.#emaMidi =
      this.#emaMidi === null ? filtered : this.#alpha * filtered + (1 - this.#alpha) * this.#emaMidi
    return {
      timeSeconds: point.timeSeconds,
      rawFrequencyHz: point.frequencyHz,
      rawMidiNote: point.midiNote,
      smoothedFrequencyHz: midiToFrequency(this.#emaMidi),
      smoothedMidiNote: this.#emaMidi,
      confidence: point.confidence,
      gapReason: point.gapReason,
    }
  }
}

export function smoothPitchForDisplay(
  points: readonly DetectedPitchPoint[],
  alpha = 0.45,
): readonly DisplayPitchPoint[] {
  const smoother = new PitchDisplaySmoother(alpha)
  return points.map((point) => smoother.push(point))
}
