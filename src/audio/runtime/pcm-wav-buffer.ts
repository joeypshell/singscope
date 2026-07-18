const WAV_HEADER_BYTES = 44
const MAX_AUDIO_BUFFER_BYTES = 48 * 1024 * 1024

function ascii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

/**
 * Copies SingScope's fixed, generated PCM16 WAV into a native AudioBuffer without
 * asking WebKit to decode a Blob URL. This accepts only the format emitted by the
 * local melody renderer and is intentionally not a general WAV importer.
 */
export function createGeneratedPcmAudioBuffer(
  context: BaseAudioContext,
  bytes: ArrayBuffer,
): AudioBuffer {
  if (bytes.byteLength < WAV_HEADER_BYTES || bytes.byteLength > MAX_AUDIO_BUFFER_BYTES) {
    throw new RangeError('The generated melody guide has an invalid size.')
  }
  const view = new DataView(bytes)
  if (
    ascii(view, 0, 4) !== 'RIFF' ||
    ascii(view, 8, 4) !== 'WAVE' ||
    ascii(view, 12, 4) !== 'fmt ' ||
    ascii(view, 36, 4) !== 'data' ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint16(34, true) !== 16
  ) {
    throw new Error('The generated melody guide is not supported mono PCM16 audio.')
  }
  const sampleRate = view.getUint32(24, true)
  const blockAlign = view.getUint16(32, true)
  const dataBytes = view.getUint32(40, true)
  if (
    sampleRate < 8_000 ||
    sampleRate > 96_000 ||
    blockAlign !== 2 ||
    dataBytes === 0 ||
    dataBytes % 2 !== 0 ||
    WAV_HEADER_BYTES + dataBytes !== bytes.byteLength
  ) {
    throw new Error('The generated melody guide has inconsistent PCM metadata.')
  }
  const sampleCount = dataBytes / 2
  if (sampleCount * Float32Array.BYTES_PER_ELEMENT > MAX_AUDIO_BUFFER_BYTES) {
    throw new RangeError('The generated melody guide exceeds the iPhone audio-buffer limit.')
  }

  const buffer = context.createBuffer(1, sampleCount, sampleRate)
  const channel = buffer.getChannelData(0)
  for (let index = 0; index < sampleCount; index += 1) {
    channel[index] = view.getInt16(WAV_HEADER_BYTES + index * 2, true) / 0x8000
  }
  return buffer
}
