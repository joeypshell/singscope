export const MELODY_REFERENCE_SAMPLE_RATE_HZ = 8_000
export const MELODY_REFERENCE_MAX_DURATION_SECONDS = 20 * 60
export const MELODY_REFERENCE_TAIL_SECONDS = 0.25
export const MELODY_REFERENCE_MIN_FREQUENCY_HZ = 80
export const MELODY_REFERENCE_MAX_FREQUENCY_HZ = 1_200

const WAV_HEADER_BYTES = 44
const PCM_BYTES_PER_SAMPLE = 2
const ATTACK_SECONDS = 0.015
const RELEASE_SECONDS = 0.06
const PEAK_AMPLITUDE = 0.4
const SINE_TABLE_SIZE = 2_048
const SINE_TABLE = Float32Array.from({ length: SINE_TABLE_SIZE }, (_, index) =>
  Math.sin((2 * Math.PI * index) / SINE_TABLE_SIZE),
)

export interface MelodyReferenceNote {
  readonly midiNote: number
  readonly startSeconds: number
  readonly endSeconds: number
}

export interface MelodyReferenceRenderInput {
  readonly notes: readonly MelodyReferenceNote[]
  readonly transpositionSemitones: number
  readonly alignmentSeconds: number
  readonly timelineDurationSeconds: number
}

export interface MelodyReferenceWorkerRequest {
  readonly type: 'render-melody-reference'
  readonly input: MelodyReferenceRenderInput
}

export type MelodyReferenceWorkerResponse =
  | { readonly type: 'melody-reference-rendered'; readonly bytes: ArrayBuffer }
  | { readonly type: 'melody-reference-error'; readonly message: string }

interface RenderableNote {
  readonly midiNote: number
  readonly startSeconds: number
  readonly endSeconds: number
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function assertFiniteNote(note: MelodyReferenceNote): void {
  if (
    !Number.isInteger(note.midiNote) ||
    note.midiNote < 0 ||
    note.midiNote > 127 ||
    !Number.isFinite(note.startSeconds) ||
    !Number.isFinite(note.endSeconds) ||
    note.startSeconds < 0 ||
    note.endSeconds <= note.startSeconds
  ) {
    throw new RangeError('A synthesized reference note is invalid.')
  }
}

export function melodyReferenceDurationSeconds(
  notes: readonly MelodyReferenceNote[],
  alignmentSeconds: number,
): number {
  if (!Number.isFinite(alignmentSeconds)) {
    throw new RangeError('Melody alignment must be finite.')
  }
  let latestEndSeconds = 0
  for (const note of notes) {
    assertFiniteNote(note)
    latestEndSeconds = Math.max(latestEndSeconds, note.endSeconds + alignmentSeconds)
  }
  return Math.max(0, Math.round(latestEndSeconds * 1000) / 1000)
}

export function melodyReferenceFrequencyHz(
  midiNote: number,
  transpositionSemitones: number,
): number {
  return 440 * 2 ** ((midiNote + transpositionSemitones - 69) / 12)
}

export function isMelodyReferencePitchSupported(
  midiNote: number,
  transpositionSemitones: number,
): boolean {
  const frequencyHz = melodyReferenceFrequencyHz(midiNote, transpositionSemitones)
  return (
    Number.isFinite(frequencyHz) &&
    frequencyHz >= MELODY_REFERENCE_MIN_FREQUENCY_HZ &&
    frequencyHz <= MELODY_REFERENCE_MAX_FREQUENCY_HZ
  )
}

/**
 * Builds a deterministic mono 16-bit PCM WAV for the persistent project timeline.
 * Notes are rendered at their displayed (transposed) pitch. Manual targets are
 * monophonic; if invalid overlapping notes remain, the latest onset wins so work
 * stays bounded even for untrusted imported records.
 */
export function renderMelodyReferenceWav(input: MelodyReferenceRenderInput): ArrayBuffer {
  if (
    !Number.isInteger(input.transpositionSemitones) ||
    input.transpositionSemitones < -48 ||
    input.transpositionSemitones > 48
  ) {
    throw new RangeError('Melody transposition must be a whole number from -48 to 48.')
  }
  if (!Number.isFinite(input.alignmentSeconds)) {
    throw new RangeError('Melody alignment must be finite.')
  }
  if (
    !Number.isFinite(input.timelineDurationSeconds) ||
    input.timelineDurationSeconds <= 0 ||
    input.timelineDurationSeconds > MELODY_REFERENCE_MAX_DURATION_SECONDS
  ) {
    throw new RangeError('The synthesized reference must be between 0 and 20 minutes.')
  }

  const renderedDurationSeconds = Math.min(
    MELODY_REFERENCE_MAX_DURATION_SECONDS,
    input.timelineDurationSeconds + MELODY_REFERENCE_TAIL_SECONDS,
  )
  const sampleCount = Math.max(
    1,
    Math.ceil(renderedDurationSeconds * MELODY_REFERENCE_SAMPLE_RATE_HZ),
  )
  const dataBytes = sampleCount * PCM_BYTES_PER_SAMPLE
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const header = new DataView(buffer)
  writeAscii(header, 0, 'RIFF')
  header.setUint32(4, 36 + dataBytes, true)
  writeAscii(header, 8, 'WAVE')
  writeAscii(header, 12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, MELODY_REFERENCE_SAMPLE_RATE_HZ, true)
  header.setUint32(28, MELODY_REFERENCE_SAMPLE_RATE_HZ * PCM_BYTES_PER_SAMPLE, true)
  header.setUint16(32, PCM_BYTES_PER_SAMPLE, true)
  header.setUint16(34, 16, true)
  writeAscii(header, 36, 'data')
  header.setUint32(40, dataBytes, true)

  const renderable = input.notes
    .map((note): RenderableNote | null => {
      assertFiniteNote(note)
      const midiNote = note.midiNote + input.transpositionSemitones
      if (!Number.isInteger(midiNote) || midiNote < 0 || midiNote > 127) {
        throw new RangeError('Transpose moves a synthesized note outside MIDI 0–127.')
      }
      if (!isMelodyReferencePitchSupported(note.midiNote, input.transpositionSemitones)) {
        throw new RangeError('A synthesized note is outside the supported 80–1,200 Hz range.')
      }
      const startSeconds = note.startSeconds + input.alignmentSeconds
      const endSeconds = note.endSeconds + input.alignmentSeconds
      if (endSeconds <= 0 || startSeconds >= input.timelineDurationSeconds) return null
      return {
        midiNote,
        startSeconds: Math.max(0, startSeconds),
        endSeconds: Math.min(input.timelineDurationSeconds, endSeconds),
      }
    })
    .filter((note): note is RenderableNote => note !== null)
    .sort((left, right) => {
      if (left.startSeconds !== right.startSeconds) return left.startSeconds - right.startSeconds
      return left.endSeconds - right.endSeconds
    })

  const samples = new Int16Array(buffer, WAV_HEADER_BYTES, sampleCount)
  for (let index = 0; index < renderable.length; index += 1) {
    const note = renderable[index]
    if (!note) continue
    const nextStartSeconds = renderable[index + 1]?.startSeconds ?? Number.POSITIVE_INFINITY
    const audibleEndSeconds = Math.min(note.endSeconds, nextStartSeconds)
    if (audibleEndSeconds <= note.startSeconds) continue

    const firstSample = Math.max(0, Math.floor(note.startSeconds * MELODY_REFERENCE_SAMPLE_RATE_HZ))
    const lastSample = Math.min(
      sampleCount,
      Math.ceil(audibleEndSeconds * MELODY_REFERENCE_SAMPLE_RATE_HZ),
    )
    const frequencyHz = melodyReferenceFrequencyHz(note.midiNote, 0)
    const phaseStep = frequencyHz / MELODY_REFERENCE_SAMPLE_RATE_HZ
    let phase =
      (frequencyHz *
        Math.max(0, firstSample / MELODY_REFERENCE_SAMPLE_RATE_HZ - note.startSeconds)) %
      1
    for (let sampleIndex = firstSample; sampleIndex < lastSample; sampleIndex += 1) {
      const timelineSeconds = sampleIndex / MELODY_REFERENCE_SAMPLE_RATE_HZ
      const elapsedSeconds = Math.max(0, timelineSeconds - note.startSeconds)
      const remainingSeconds = Math.max(0, audibleEndSeconds - timelineSeconds)
      const envelope = Math.min(
        1,
        elapsedSeconds / ATTACK_SECONDS,
        remainingSeconds / RELEASE_SECONDS,
      )
      const sine = SINE_TABLE[Math.floor(phase * SINE_TABLE_SIZE)] ?? 0
      samples[sampleIndex] = Math.round(sine * envelope * PEAK_AMPLITUDE * 0x7fff)
      phase += phaseStep
      phase -= Math.floor(phase)
    }
  }

  return buffer
}
