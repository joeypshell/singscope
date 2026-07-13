/**
 * Deterministic linear resampling is sufficient for the speech-band YIN input.
 * The AudioWorklet is expected to provide native-rate PCM; this function does not
 * inspect any browser or AudioContext state.
 */
export function resampleLinear(
  input: Float32Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): Float32Array {
  if (!(Number.isFinite(sourceSampleRateHz) && sourceSampleRateHz > 0)) {
    throw new RangeError('sourceSampleRateHz must be positive and finite')
  }
  if (!(Number.isFinite(targetSampleRateHz) && targetSampleRateHz > 0)) {
    throw new RangeError('targetSampleRateHz must be positive and finite')
  }
  if (input.length === 0) return new Float32Array()
  if (sourceSampleRateHz === targetSampleRateHz) return input.slice()

  const outputLength = Math.max(
    1,
    Math.round((input.length * targetSampleRateHz) / sourceSampleRateHz),
  )
  const output = new Float32Array(outputLength)
  const ratio = sourceSampleRateHz / targetSampleRateHz
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const sourcePosition = outputIndex * ratio
    const leftIndex = Math.min(input.length - 1, Math.floor(sourcePosition))
    const rightIndex = Math.min(input.length - 1, leftIndex + 1)
    const mix = sourcePosition - leftIndex
    const left = input[leftIndex] ?? 0
    const right = input[rightIndex] ?? left
    output[outputIndex] = left + (right - left) * mix
  }
  return output
}

export function resampleToLength(input: Float32Array, outputLength: number): Float32Array {
  if (!Number.isSafeInteger(outputLength) || outputLength < 0) {
    throw new RangeError('outputLength must be a non-negative integer')
  }
  if (outputLength === 0 || input.length === 0) return new Float32Array(outputLength)
  if (outputLength === input.length) return input.slice()
  if (outputLength === 1) return Float32Array.of(input[0] ?? 0)

  const output = new Float32Array(outputLength)
  const scale = (input.length - 1) / (outputLength - 1)
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * scale
    const leftIndex = Math.floor(sourcePosition)
    const rightIndex = Math.min(input.length - 1, leftIndex + 1)
    const mix = sourcePosition - leftIndex
    const left = input[leftIndex] ?? 0
    const right = input[rightIndex] ?? left
    output[index] = left + (right - left) * mix
  }
  return output
}
