export const MEBIBYTE = 1024 * 1024

export const IPHONE_LIMITS = Object.freeze({
  backingAudioBytes: 64 * MEBIBYTE,
  backingAudioSeconds: 20 * 60,
  isolatedVocalBytes: 32 * MEBIBYTE,
  isolatedVocalSeconds: 8 * 60,
  takeBytes: 48 * MEBIBYTE,
  takeSeconds: 15 * 60,
  midiBytes: 5 * MEBIBYTE,
  midiTracks: 64,
  midiEvents: 100_000,
  projectBinaryBytes: 128 * MEBIBYTE,
  projectPitchPoints: 500_000,
  sharePackageBytes: 64 * MEBIBYTE,
  savedPackageBytes: 160 * MEBIBYTE,
  expandedPackageBytes: 192 * MEBIBYTE,
  wavBytes: 32 * MEBIBYTE,
  wavEstimatedPeakMemoryBytes: 96 * MEBIBYTE,
  canvasPixels: 4_000_000,
  exportChartWidth: 1600,
  exportChartHeight: 900,
})

export function assertWithinBytes(actual: number, maximum: number, label: string): void {
  if (!Number.isInteger(actual) || actual < 0) throw new Error(`${label} size was invalid.`)
  if (actual > maximum) {
    throw new Error(`${label} exceeds the ${formatMiB(maximum)} MiB iPhone limit.`)
  }
}

export function formatMiB(bytes: number): string {
  return (bytes / MEBIBYTE).toFixed(bytes % MEBIBYTE === 0 ? 0 : 1)
}

export interface WavEligibility {
  eligible: boolean
  reason: string | null
}

export function checkWavEligibility(
  estimatedBytes: number,
  estimatedPeakMemoryBytes: number,
): WavEligibility {
  if (estimatedBytes > IPHONE_LIMITS.wavBytes) {
    return { eligible: false, reason: 'WAV was omitted because it would exceed 32 MiB.' }
  }
  if (estimatedPeakMemoryBytes >= IPHONE_LIMITS.wavEstimatedPeakMemoryBytes) {
    return {
      eligible: false,
      reason: 'WAV was omitted because estimated peak memory would reach 96 MiB.',
    }
  }
  return { eligible: true, reason: null }
}
