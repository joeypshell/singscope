export type PitchEstimateReason =
  'silence' | 'low-confidence' | 'out-of-range' | 'invalid-frame' | null

export interface PitchDetectorConfig {
  readonly internalSampleRateHz: number
  readonly frameDurationSeconds: number
  readonly hopDurationSeconds: number
  readonly minimumFrequencyHz: number
  readonly maximumFrequencyHz: number
  readonly yinThreshold: number
  readonly confidenceThreshold: number
  readonly minimumRms: number
  readonly noiseGateMultiplier: number
  readonly noiseFloorAdaptation: number
}

/** Detector output has no timestamp; callers align frames with AudioContext time. */
export interface PitchEstimate {
  /** The best YIN candidate, retained even when confidence is below threshold. */
  readonly candidateHz: number | null
  /** Accepted voiced frequency, or null for an analysis gap. */
  readonly frequencyHz: number | null
  readonly confidence: number | null
  readonly periodSamples: number | null
  readonly rms: number
  readonly peak: number
  readonly reason: PitchEstimateReason
}

export interface PitchDetector {
  readonly version: string
  readonly config: PitchDetectorConfig
  detect(frame: Float32Array, sampleRateHz: number): PitchEstimate
  reset(): void
}

export interface PitchFrameAnalysis {
  readonly frameStartSample: number
  readonly frameCenterSample: number
  readonly frameStartSeconds: number
  readonly frameCenterSeconds: number
  readonly estimate: PitchEstimate
}
