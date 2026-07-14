import { clamp } from '../../domain/guards'
import { DETECTOR_VERSION } from '../../domain/versions'
import type { PitchDetector, PitchDetectorConfig, PitchEstimate } from './contracts'
import { resampleToLength } from './resample'

export const DEFAULT_YIN_CONFIG: PitchDetectorConfig = Object.freeze({
  internalSampleRateHz: 24_000,
  frameDurationSeconds: 0.064,
  hopDurationSeconds: 0.02,
  minimumFrequencyHz: 80,
  maximumFrequencyHz: 1_200,
  yinThreshold: 0.15,
  confidenceThreshold: 0.75,
  minimumRms: 0.003,
  noiseGateMultiplier: 3,
  noiseFloorAdaptation: 0.04,
})

function invalidEstimate(
  reason: Exclude<PitchEstimate['reason'], null>,
  rms = 0,
  peak = 0,
): PitchEstimate {
  return {
    candidateHz: null,
    frequencyHz: null,
    confidence: null,
    periodSamples: null,
    rms,
    peak,
    reason,
  }
}

function frameLevel(frame: Float32Array): { centered: Float32Array; rms: number; peak: number } {
  let average = 0
  for (const sample of frame) average += sample
  average /= frame.length

  const centered = new Float32Array(frame.length)
  let squareSum = 0
  let peak = 0
  for (let index = 0; index < frame.length; index += 1) {
    const sample = (frame[index] ?? 0) - average
    centered[index] = sample
    squareSum += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  return { centered, rms: Math.sqrt(squareSum / frame.length), peak }
}

function parabolicTau(values: Float64Array, tau: number): number {
  if (tau <= 0 || tau >= values.length - 1) return tau
  const left = values[tau - 1]
  const middle = values[tau]
  const right = values[tau + 1]
  if (left === undefined || middle === undefined || right === undefined) return tau
  const denominator = 2 * (2 * middle - left - right)
  if (Math.abs(denominator) < Number.EPSILON) return tau
  return tau + (right - left) / denominator
}

export class YinPitchDetector implements PitchDetector {
  readonly version = DETECTOR_VERSION
  readonly config: PitchDetectorConfig
  #noiseFloorRms: number

  constructor(config: Partial<PitchDetectorConfig> = {}) {
    this.config = Object.freeze({ ...DEFAULT_YIN_CONFIG, ...config })
    this.#validateConfig()
    this.#noiseFloorRms = this.config.minimumRms / this.config.noiseGateMultiplier
  }

  get noiseFloorRms(): number {
    return this.#noiseFloorRms
  }

  reset(): void {
    this.#noiseFloorRms = this.config.minimumRms / this.config.noiseGateMultiplier
  }

  detect(frame: Float32Array, sampleRateHz: number): PitchEstimate {
    if (
      frame.length < 32 ||
      !Number.isFinite(sampleRateHz) ||
      sampleRateHz <= 0 ||
      frame.some((sample) => !Number.isFinite(sample))
    ) {
      return invalidEstimate('invalid-frame')
    }

    const expectedInputLength = Math.max(
      1,
      Math.round(sampleRateHz * this.config.frameDurationSeconds),
    )
    const internalLength = Math.round(
      this.config.internalSampleRateHz * this.config.frameDurationSeconds,
    )
    // A worklet batch can differ by one sample because native sample rates do not
    // divide into 64 ms exactly. Larger mismatches indicate a caller contract bug.
    if (Math.abs(frame.length - expectedInputLength) > 1) return invalidEstimate('invalid-frame')
    const normalized = resampleToLength(frame, internalLength)
    const { centered, rms, peak } = frameLevel(normalized)

    const gate = Math.max(
      this.config.minimumRms,
      this.#noiseFloorRms * this.config.noiseGateMultiplier,
    )
    if (rms < gate) {
      // Only a frame already classified by level may update the ambient floor.
      // Aperiodic note attacks and overlapping piano decays are often rejected by
      // YIN confidence despite being loud signal; learning those as "noise" makes
      // the gate ratchet upward and can erase every later note in a phrase.
      this.#updateNoiseFloor(rms)
      return invalidEstimate('silence', rms, peak)
    }

    const minimumTau = Math.max(
      2,
      Math.floor(this.config.internalSampleRateHz / this.config.maximumFrequencyHz),
    )
    const maximumTau = Math.min(
      centered.length - 2,
      Math.ceil(this.config.internalSampleRateHz / this.config.minimumFrequencyHz),
    )
    if (maximumTau <= minimumTau) return invalidEstimate('invalid-frame', rms, peak)

    const difference = new Float64Array(maximumTau + 1)
    const comparisonLength = centered.length - maximumTau
    for (let tau = 1; tau <= maximumTau; tau += 1) {
      let sum = 0
      for (let index = 0; index < comparisonLength; index += 1) {
        const delta = (centered[index] ?? 0) - (centered[index + tau] ?? 0)
        sum += delta * delta
      }
      difference[tau] = sum
    }

    const normalizedDifference = new Float64Array(maximumTau + 1)
    normalizedDifference[0] = 1
    let runningSum = 0
    for (let tau = 1; tau <= maximumTau; tau += 1) {
      runningSum += difference[tau] ?? 0
      normalizedDifference[tau] = runningSum === 0 ? 1 : ((difference[tau] ?? 0) * tau) / runningSum
    }

    let selectedTau: number | null = null
    for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
      if ((normalizedDifference[tau] ?? 1) >= this.config.yinThreshold) continue
      while (
        tau + 1 <= maximumTau &&
        (normalizedDifference[tau + 1] ?? 1) < (normalizedDifference[tau] ?? 1)
      ) {
        tau += 1
      }
      selectedTau = tau
      break
    }

    if (selectedTau === null) {
      let bestValue = Number.POSITIVE_INFINITY
      for (let tau = minimumTau; tau <= maximumTau; tau += 1) {
        const value = normalizedDifference[tau] ?? 1
        if (value < bestValue) {
          bestValue = value
          selectedTau = tau
        }
      }
    }
    if (selectedTau === null) {
      return invalidEstimate('low-confidence', rms, peak)
    }

    const refinedTau = parabolicTau(normalizedDifference, selectedTau)
    const candidateHz = this.config.internalSampleRateHz / refinedTau
    const confidence = clamp(1 - (normalizedDifference[selectedTau] ?? 1), 0, 1)
    const inRange =
      candidateHz >= this.config.minimumFrequencyHz && candidateHz <= this.config.maximumFrequencyHz
    if (!inRange) {
      return {
        candidateHz,
        frequencyHz: null,
        confidence,
        periodSamples: refinedTau,
        rms,
        peak,
        reason: 'out-of-range',
      }
    }
    if (confidence < this.config.confidenceThreshold) {
      return {
        candidateHz,
        frequencyHz: null,
        confidence,
        periodSamples: refinedTau,
        rms,
        peak,
        reason: 'low-confidence',
      }
    }
    return {
      candidateHz,
      frequencyHz: candidateHz,
      confidence,
      periodSamples: refinedTau,
      rms,
      peak,
      reason: null,
    }
  }

  #updateNoiseFloor(rms: number): void {
    const adaptation = this.config.noiseFloorAdaptation
    const boundedRms = Math.min(rms, Math.max(this.config.minimumRms, this.#noiseFloorRms * 4))
    this.#noiseFloorRms = this.#noiseFloorRms * (1 - adaptation) + boundedRms * adaptation
  }

  #validateConfig(): void {
    const config = this.config
    if (!(config.internalSampleRateHz > 0)) throw new RangeError('Invalid internal sample rate')
    if (!(config.frameDurationSeconds > 0 && config.hopDurationSeconds > 0)) {
      throw new RangeError('Frame and hop durations must be positive')
    }
    if (!(config.minimumFrequencyHz > 0 && config.maximumFrequencyHz > config.minimumFrequencyHz)) {
      throw new RangeError('Invalid detector frequency range')
    }
    if (!(config.yinThreshold > 0 && config.yinThreshold < 1)) {
      throw new RangeError('yinThreshold must be between zero and one')
    }
    if (!(config.confidenceThreshold >= 0 && config.confidenceThreshold <= 1)) {
      throw new RangeError('confidenceThreshold must be between zero and one')
    }
    if (!(config.minimumRms >= 0 && config.noiseGateMultiplier > 0)) {
      throw new RangeError('Invalid noise gate configuration')
    }
    if (!(config.noiseFloorAdaptation > 0 && config.noiseFloorAdaptation <= 1)) {
      throw new RangeError('noiseFloorAdaptation must be between zero and one')
    }
  }
}
