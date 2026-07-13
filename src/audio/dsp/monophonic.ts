import type { TargetPitchPoint, TargetSet } from '../../domain/types'
import { frequencyToMidi } from '../../domain/pitch'
import type {
  PitchDetector,
  PitchEstimate,
  PitchEstimateReason,
  PitchFrameAnalysis,
} from './contracts'
import { resampleLinear } from './resample'
import { YinPitchDetector } from './yin'

const MEBIBYTE = 1024 * 1024

export interface MonophonicAnalysisLimits {
  readonly maximumEncodedBytes: number
  readonly maximumDurationSeconds: number
  readonly wholeFilePeakMemoryBudgetBytes: number
  readonly maximumChannelCount: number
}

export const DEFAULT_MONOPHONIC_ANALYSIS_LIMITS: MonophonicAnalysisLimits = Object.freeze({
  maximumEncodedBytes: 32 * MEBIBYTE,
  maximumDurationSeconds: 8 * 60,
  wholeFilePeakMemoryBudgetBytes: 64 * MEBIBYTE,
  maximumChannelCount: 8,
})

export interface MonophonicSourceEstimate {
  readonly encodedByteLength: number
  readonly durationSeconds: number
  readonly sampleRateHz: number
  readonly channelCount: number
}

export type MonophonicAnalysisStrategy = 'offline-buffer' | 'foreground-media-pass' | 'reject'

export type MonophonicAnalysisRejection =
  'invalid-metadata' | 'encoded-file-too-large' | 'duration-too-long' | 'too-many-channels' | null

export interface MonophonicAnalysisDecision {
  readonly strategy: MonophonicAnalysisStrategy
  readonly rejection: MonophonicAnalysisRejection
  readonly estimatedDecodedBytes: number | null
  readonly estimatedPeakBytes: number | null
  readonly memoryBudgetBytes: number
}

/** Estimates the browser's interleaved decoded PCM allocation, without assuming file compression. */
export function estimateDecodedPcmBytes(
  durationSeconds: number,
  sampleRateHz: number,
  channelCount: number,
): number | null {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0 ||
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz <= 0 ||
    !Number.isSafeInteger(channelCount) ||
    channelCount < 1
  ) {
    return null
  }
  const bytes = Math.ceil(
    durationSeconds * sampleRateHz * channelCount * Float32Array.BYTES_PER_ELEMENT,
  )
  return Number.isSafeInteger(bytes) ? bytes : null
}

/**
 * Accounts for the encoded input, decoded channels, mono mix, and normalized
 * 24 kHz analysis copy being live at the same time during whole-file analysis.
 */
export function estimateWholeFileAnalysisPeakBytes(
  source: MonophonicSourceEstimate,
): number | null {
  const decoded = estimateDecodedPcmBytes(
    source.durationSeconds,
    source.sampleRateHz,
    source.channelCount,
  )
  const mono = estimateDecodedPcmBytes(source.durationSeconds, source.sampleRateHz, 1)
  const normalized = estimateDecodedPcmBytes(source.durationSeconds, 24_000, 1)
  if (decoded === null || mono === null || normalized === null) return null
  const total = source.encodedByteLength + decoded + mono + normalized
  return Number.isSafeInteger(total) ? total : null
}

export function decideMonophonicAnalysisStrategy(
  source: MonophonicSourceEstimate,
  limits: MonophonicAnalysisLimits = DEFAULT_MONOPHONIC_ANALYSIS_LIMITS,
): MonophonicAnalysisDecision {
  const estimatedDecodedBytes = estimateDecodedPcmBytes(
    source.durationSeconds,
    source.sampleRateHz,
    source.channelCount,
  )
  const estimatedPeakBytes = estimateWholeFileAnalysisPeakBytes(source)
  const base = {
    estimatedDecodedBytes,
    estimatedPeakBytes,
    memoryBudgetBytes: limits.wholeFilePeakMemoryBudgetBytes,
  }
  if (
    !Number.isSafeInteger(source.encodedByteLength) ||
    source.encodedByteLength < 0 ||
    estimatedPeakBytes === null
  ) {
    return { ...base, strategy: 'reject', rejection: 'invalid-metadata' }
  }
  if (source.encodedByteLength > limits.maximumEncodedBytes) {
    return { ...base, strategy: 'reject', rejection: 'encoded-file-too-large' }
  }
  if (source.durationSeconds > limits.maximumDurationSeconds) {
    return { ...base, strategy: 'reject', rejection: 'duration-too-long' }
  }
  if (source.channelCount > limits.maximumChannelCount) {
    return { ...base, strategy: 'reject', rejection: 'too-many-channels' }
  }
  return estimatedPeakBytes <= limits.wholeFilePeakMemoryBudgetBytes
    ? { ...base, strategy: 'offline-buffer', rejection: null }
    : { ...base, strategy: 'foreground-media-pass', rejection: null }
}

export type MonophonicContourGapReason = PitchEstimateReason | 'source-gap'

export interface MonophonicContourPoint {
  readonly timeSeconds: number
  readonly candidateHz: number | null
  readonly frequencyHz: number | null
  readonly midiNote: number | null
  readonly confidence: number | null
  readonly rms: number | null
  readonly peak: number | null
  readonly gapReason: MonophonicContourGapReason
}

export interface CandidateTargetNote {
  readonly candidateKey: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly midiNote: number
  readonly meanConfidence: number
  readonly sourcePointStartIndex: number
  readonly sourcePointEndIndex: number
  readonly preservedGapCount: number
}

export interface CandidateSegmentationOptions {
  readonly confidenceThreshold: number
  readonly pitchToleranceCents: number
  readonly maximumBridgeGapSeconds: number
  readonly minimumNoteDurationSeconds: number
  readonly mergeSamePitchGapSeconds: number
  readonly analysisHopSeconds: number
}

export const DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS: CandidateSegmentationOptions = Object.freeze({
  confidenceThreshold: 0.75,
  pitchToleranceCents: 75,
  maximumBridgeGapSeconds: 0.06,
  minimumNoteDurationSeconds: 0.08,
  mergeSamePitchGapSeconds: 0.08,
  analysisHopSeconds: 0.02,
})

export interface MonophonicAnalysisResult {
  readonly detectorVersion: string
  readonly durationSeconds: number
  readonly contour: readonly MonophonicContourPoint[]
  readonly candidateNotes: readonly CandidateTargetNote[]
}

export interface MonophonicAnalysisOptions {
  readonly detector?: PitchDetector
  readonly segmentation?: Partial<CandidateSegmentationOptions>
}

export interface AudioBufferLike {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  readonly duration: number
  getChannelData(channel: number): Float32Array
}

export class MonophonicAnalysisCancelledError extends Error {
  constructor() {
    super('Monophonic source analysis was cancelled')
    this.name = 'MonophonicAnalysisCancelledError'
  }
}

export interface CancellableOfflineAnalysisOptions extends MonophonicAnalysisOptions {
  /** Must be obtained before decode by calling decideMonophonicAnalysisStrategy. */
  readonly admission: MonophonicAnalysisDecision
  readonly signal?: AbortSignal
  readonly framesPerYield?: number
  readonly yieldControl?: () => Promise<void>
}

/** A media adapter supplies bounded, already-normalized mono chunks in source order. */
export interface NormalizedMonophonicPcmChunk {
  readonly sequence: number
  readonly startSample: number
  readonly sampleCount: number
  readonly samples: Float32Array | null
  readonly gapReason: 'source-gap' | null
}

export interface ForegroundMonophonicMediaPass {
  readonly normalizedSampleRateHz: number
  readonly durationSeconds: number
  chunks(signal: AbortSignal): AsyncIterable<NormalizedMonophonicPcmChunk>
  cancel(reason: string): void | Promise<void>
}

export interface ForegroundMonophonicAnalysisOptions extends MonophonicAnalysisOptions {
  readonly signal: AbortSignal
  readonly maximumChunkDurationSeconds?: number
}

interface MutableSegment {
  points: { index: number; point: MonophonicContourPoint }[]
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new MonophonicAnalysisCancelledError()
}

function contourPoint(timeSeconds: number, estimate: PitchEstimate): MonophonicContourPoint {
  return {
    timeSeconds,
    candidateHz: estimate.candidateHz,
    frequencyHz: estimate.frequencyHz,
    midiNote: estimate.frequencyHz === null ? null : frequencyToMidi(estimate.frequencyHz),
    confidence: estimate.confidence,
    rms: estimate.rms,
    peak: estimate.peak,
    gapReason: estimate.reason,
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function resolveSegmentationOptions(
  options: Partial<CandidateSegmentationOptions>,
): CandidateSegmentationOptions {
  const resolved = { ...DEFAULT_CANDIDATE_SEGMENTATION_OPTIONS, ...options }
  if (!(resolved.confidenceThreshold >= 0 && resolved.confidenceThreshold <= 1)) {
    throw new RangeError('confidenceThreshold must be between zero and one')
  }
  if (!(resolved.pitchToleranceCents > 0 && resolved.pitchToleranceCents <= 200)) {
    throw new RangeError('pitchToleranceCents must be positive and at most 200')
  }
  if (
    resolved.maximumBridgeGapSeconds < 0 ||
    resolved.minimumNoteDurationSeconds <= 0 ||
    resolved.mergeSamePitchGapSeconds < 0 ||
    resolved.analysisHopSeconds <= 0
  ) {
    throw new RangeError('Segmentation durations are invalid')
  }
  return resolved
}

function finalizeSegment(
  segment: MutableSegment,
  contour: readonly MonophonicContourPoint[],
  options: CandidateSegmentationOptions,
): CandidateTargetNote | null {
  const first = segment.points[0]
  const last = segment.points.at(-1)
  if (first === undefined || last === undefined) return null
  const midiValues = segment.points.flatMap(({ point }) =>
    point.midiNote === null ? [] : [point.midiNote],
  )
  const confidenceValues = segment.points.flatMap(({ point }) =>
    point.confidence === null ? [] : [point.confidence],
  )
  if (midiValues.length === 0 || confidenceValues.length === 0) return null
  const halfHop = options.analysisHopSeconds / 2
  const startSeconds = Math.max(0, first.point.timeSeconds - halfHop)
  const endSeconds = last.point.timeSeconds + halfHop
  if (endSeconds - startSeconds + Number.EPSILON < options.minimumNoteDurationSeconds) return null
  let preservedGapCount = 0
  for (let index = first.index; index <= last.index; index += 1) {
    if (contour[index]?.frequencyHz === null) preservedGapCount += 1
  }
  return {
    candidateKey: '',
    startSeconds,
    endSeconds,
    midiNote: Math.round(median(midiValues)),
    meanConfidence:
      confidenceValues.reduce((sum, confidence) => sum + confidence, 0) / confidenceValues.length,
    sourcePointStartIndex: first.index,
    sourcePointEndIndex: last.index,
    preservedGapCount,
  }
}

function mergeCandidateNotes(
  notes: readonly CandidateTargetNote[],
  options: CandidateSegmentationOptions,
): readonly CandidateTargetNote[] {
  const merged: CandidateTargetNote[] = []
  for (const note of notes) {
    const previous = merged.at(-1)
    if (
      previous?.midiNote === note.midiNote &&
      note.startSeconds - previous.endSeconds <= options.mergeSamePitchGapSeconds
    ) {
      const previousPointCount = previous.sourcePointEndIndex - previous.sourcePointStartIndex + 1
      const notePointCount = note.sourcePointEndIndex - note.sourcePointStartIndex + 1
      merged[merged.length - 1] = {
        candidateKey: '',
        startSeconds: previous.startSeconds,
        endSeconds: note.endSeconds,
        midiNote: note.midiNote,
        meanConfidence:
          (previous.meanConfidence * previousPointCount + note.meanConfidence * notePointCount) /
          (previousPointCount + notePointCount),
        sourcePointStartIndex: previous.sourcePointStartIndex,
        sourcePointEndIndex: note.sourcePointEndIndex,
        preservedGapCount: previous.preservedGapCount + note.preservedGapCount,
      }
    } else {
      merged.push(note)
    }
  }
  return merged.map((note, index) => ({
    ...note,
    candidateKey: `candidate-${String(index + 1).padStart(6, '0')}`,
  }))
}

/** Derives editable candidates; the input contour remains the authoritative analysis record. */
export function segmentMonophonicContour(
  contour: readonly MonophonicContourPoint[],
  inputOptions: Partial<CandidateSegmentationOptions> = {},
): readonly CandidateTargetNote[] {
  const options = resolveSegmentationOptions(inputOptions)
  const segments: MutableSegment[] = []
  let current: MutableSegment | null = null

  for (let index = 0; index < contour.length; index += 1) {
    const point = contour[index]
    if (point === undefined) continue
    const voiced =
      point.frequencyHz !== null &&
      point.midiNote !== null &&
      point.confidence !== null &&
      point.confidence >= options.confidenceThreshold &&
      point.gapReason === null
    if (!voiced) continue

    const previous = current?.points.at(-1)
    const recentMidi = current?.points
      .slice(-5)
      .flatMap(({ point: recent }) => (recent.midiNote === null ? [] : [recent.midiNote]))
    const separatedByGap =
      previous !== undefined &&
      point.timeSeconds - previous.point.timeSeconds - options.analysisHopSeconds >
        options.maximumBridgeGapSeconds + Number.EPSILON
    const separatedByPitch =
      recentMidi !== undefined &&
      recentMidi.length > 0 &&
      Math.abs(point.midiNote - median(recentMidi)) * 100 > options.pitchToleranceCents

    if (current === null || separatedByGap || separatedByPitch) {
      current = { points: [] }
      segments.push(current)
    }
    current.points.push({ index, point })
  }

  const candidates = segments.flatMap((segment) => {
    const candidate = finalizeSegment(segment, contour, options)
    return candidate === null ? [] : [candidate]
  })
  return mergeCandidateNotes(candidates, options)
}

function resultFromContour(
  contour: readonly MonophonicContourPoint[],
  detector: PitchDetector,
  durationSeconds: number,
  segmentation: Partial<CandidateSegmentationOptions>,
): MonophonicAnalysisResult {
  return {
    detectorVersion: detector.version,
    durationSeconds,
    contour,
    candidateNotes: segmentMonophonicContour(contour, {
      confidenceThreshold: detector.config.confidenceThreshold,
      analysisHopSeconds: detector.config.hopDurationSeconds,
      ...segmentation,
    }),
  }
}

export function analyzeMonophonicPcm(
  monoSamples: Float32Array,
  sampleRateHz: number,
  options: MonophonicAnalysisOptions = {},
): MonophonicAnalysisResult {
  const detector = options.detector ?? new YinPitchDetector()
  const normalized = resampleLinear(monoSamples, sampleRateHz, detector.config.internalSampleRateHz)
  const analyses = analyzeNormalizedPcm(normalized, detector)
  const contour = analyses.map((analysis) =>
    contourPoint(analysis.frameCenterSeconds, analysis.estimate),
  )
  return resultFromContour(
    contour,
    detector,
    monoSamples.length / sampleRateHz,
    options.segmentation ?? {},
  )
}

function analyzeNormalizedPcm(
  normalized: Float32Array,
  detector: PitchDetector,
): readonly PitchFrameAnalysis[] {
  const sampleRate = detector.config.internalSampleRateHz
  const frameLength = Math.round(sampleRate * detector.config.frameDurationSeconds)
  const hopLength = Math.round(sampleRate * detector.config.hopDurationSeconds)
  const analyses: PitchFrameAnalysis[] = []
  for (let offset = 0; offset + frameLength <= normalized.length; offset += hopLength) {
    analyses.push({
      frameStartSample: offset,
      frameCenterSample: offset + frameLength / 2,
      frameStartSeconds: offset / sampleRate,
      frameCenterSeconds: (offset + frameLength / 2) / sampleRate,
      estimate: detector.detect(normalized.slice(offset, offset + frameLength), sampleRate),
    })
  }
  return analyses
}

export function mixAudioBufferToMono(buffer: AudioBufferLike): Float32Array {
  if (
    !Number.isSafeInteger(buffer.numberOfChannels) ||
    buffer.numberOfChannels < 1 ||
    !Number.isSafeInteger(buffer.length) ||
    buffer.length < 0
  ) {
    throw new RangeError('Invalid AudioBuffer shape')
  }
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    if (samples.length !== buffer.length)
      throw new RangeError('AudioBuffer channel length mismatch')
    for (let index = 0; index < output.length; index += 1) {
      output[index] = (output[index] ?? 0) + (samples[index] ?? 0) / buffer.numberOfChannels
    }
  }
  return output
}

/** Whole-file path for sources admitted by decideMonophonicAnalysisStrategy. */
export async function analyzeMonophonicAudioBuffer(
  buffer: AudioBufferLike,
  options: CancellableOfflineAnalysisOptions,
): Promise<MonophonicAnalysisResult> {
  if (options.admission.strategy !== 'offline-buffer' || options.admission.rejection !== null) {
    throw new RangeError('Whole-file AudioBuffer analysis was not admitted by the memory budget')
  }
  throwIfCancelled(options.signal)
  const detector = options.detector ?? new YinPitchDetector()
  const mono = mixAudioBufferToMono(buffer)
  throwIfCancelled(options.signal)
  const normalized = resampleLinear(mono, buffer.sampleRate, detector.config.internalSampleRateHz)
  throwIfCancelled(options.signal)

  const sampleRate = detector.config.internalSampleRateHz
  const frameLength = Math.round(sampleRate * detector.config.frameDurationSeconds)
  const hopLength = Math.round(sampleRate * detector.config.hopDurationSeconds)
  const framesPerYield = options.framesPerYield ?? 32
  if (!Number.isSafeInteger(framesPerYield) || framesPerYield < 1) {
    throw new RangeError('framesPerYield must be a positive integer')
  }
  const yieldControl = options.yieldControl ?? (() => Promise.resolve())
  const contour: MonophonicContourPoint[] = []
  let frameCount = 0
  for (let offset = 0; offset + frameLength <= normalized.length; offset += hopLength) {
    throwIfCancelled(options.signal)
    const estimate = detector.detect(normalized.slice(offset, offset + frameLength), sampleRate)
    contour.push(contourPoint((offset + frameLength / 2) / sampleRate, estimate))
    frameCount += 1
    if (frameCount % framesPerYield === 0) await yieldControl()
  }
  throwIfCancelled(options.signal)
  return resultFromContour(contour, detector, buffer.duration, options.segmentation ?? {})
}

function sourceGapPoint(timeSeconds: number): MonophonicContourPoint {
  return {
    timeSeconds,
    candidateHz: null,
    frequencyHz: null,
    midiNote: null,
    confidence: null,
    rms: null,
    peak: null,
    gapReason: 'source-gap',
  }
}

/**
 * Streaming path for a foreground media-element pass. The adapter owns playback
 * and native-rate resampling; this function owns bounded overlap and detection.
 */
export async function analyzeForegroundMonophonicMediaPass(
  pass: ForegroundMonophonicMediaPass,
  options: ForegroundMonophonicAnalysisOptions,
): Promise<MonophonicAnalysisResult> {
  const detector = options.detector ?? new YinPitchDetector()
  const sampleRate = detector.config.internalSampleRateHz
  if (pass.normalizedSampleRateHz !== sampleRate) {
    throw new RangeError(`Foreground chunks must be normalized to ${String(sampleRate)} Hz`)
  }
  const frameLength = Math.round(sampleRate * detector.config.frameDurationSeconds)
  const hopLength = Math.round(sampleRate * detector.config.hopDurationSeconds)
  const maximumChunkDurationSeconds = options.maximumChunkDurationSeconds ?? 2
  if (!(Number.isFinite(maximumChunkDurationSeconds) && maximumChunkDurationSeconds > 0)) {
    throw new RangeError('maximumChunkDurationSeconds must be positive and finite')
  }
  const maximumChunkSamples = Math.ceil(sampleRate * maximumChunkDurationSeconds)
  let pending = new Float32Array()
  let nextFrameStart = 0
  let expectedSample = 0
  let expectedSequence = 0
  const contour: MonophonicContourPoint[] = []

  try {
    for await (const chunk of pass.chunks(options.signal)) {
      throwIfCancelled(options.signal)
      if (
        chunk.sequence !== expectedSequence ||
        chunk.startSample !== expectedSample ||
        !Number.isSafeInteger(chunk.sampleCount) ||
        chunk.sampleCount < 0 ||
        chunk.sampleCount > maximumChunkSamples ||
        (chunk.samples !== null && chunk.samples.length !== chunk.sampleCount) ||
        (chunk.samples === null) !== (chunk.gapReason !== null)
      ) {
        throw new RangeError('Invalid or non-contiguous foreground analysis chunk')
      }
      expectedSequence += 1
      expectedSample += chunk.sampleCount

      if (chunk.samples === null) {
        pending = new Float32Array()
        const gapEndSample = chunk.startSample + chunk.sampleCount
        for (
          let center = Math.max(chunk.startSample, nextFrameStart + frameLength / 2);
          center < gapEndSample;
          center += hopLength
        ) {
          contour.push(sourceGapPoint(center / sampleRate))
        }
        nextFrameStart = gapEndSample
        detector.reset()
        continue
      }

      const combined = new Float32Array(pending.length + chunk.samples.length)
      combined.set(pending)
      combined.set(chunk.samples, pending.length)
      let consumed = 0
      while (consumed + frameLength <= combined.length) {
        const estimate = detector.detect(
          combined.slice(consumed, consumed + frameLength),
          sampleRate,
        )
        contour.push(contourPoint((nextFrameStart + frameLength / 2) / sampleRate, estimate))
        consumed += hopLength
        nextFrameStart += hopLength
      }
      pending = combined.slice(consumed)
    }
    throwIfCancelled(options.signal)
  } catch (error) {
    if (options.signal.aborted) {
      await pass.cancel('user-cancelled')
      throw new MonophonicAnalysisCancelledError()
    }
    throw error
  }

  return resultFromContour(contour, detector, pass.durationSeconds, options.segmentation ?? {})
}

export interface AnalyzedTargetNoteDraft {
  readonly candidateKey: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly midiNote: number
  readonly lyric: null
  readonly sourceTrack: null
  readonly scorable: true
  readonly confidence: number
}

export interface AnalyzedTargetDraftInput {
  readonly revision: number
  readonly kind: 'analyzed'
  readonly status: 'draft'
  readonly sourceAssetId: string
  readonly parentTargetSetId: string | null
  readonly alignmentSeconds: number
  readonly transposeSemitones: number
  readonly notes: readonly AnalyzedTargetNoteDraft[]
  readonly pitchPoints: readonly TargetPitchPoint[]
  readonly detectorVersion: string
  readonly contour: readonly MonophonicContourPoint[]
}

export interface AnalyzedTargetDraftOptions {
  readonly sourceAssetId: string
  readonly previousRevision: Pick<
    TargetSet,
    'id' | 'revision' | 'alignmentSeconds' | 'transposeSemitones'
  > | null
}

/**
 * Returns creation input only. In particular, it does not mutate or reuse the
 * previous revision's note array, so manual edits cannot be overwritten.
 * This accepts an already-isolated monophonic source; it performs no mixed-song
 * source separation and makes no melody-extraction claim.
 */
export function createAnalyzedTargetDraftInput(
  analysis: MonophonicAnalysisResult,
  options: AnalyzedTargetDraftOptions,
): AnalyzedTargetDraftInput {
  return {
    revision: (options.previousRevision?.revision ?? 0) + 1,
    kind: 'analyzed',
    status: 'draft',
    sourceAssetId: options.sourceAssetId,
    parentTargetSetId: options.previousRevision?.id ?? null,
    alignmentSeconds: options.previousRevision?.alignmentSeconds ?? 0,
    transposeSemitones: options.previousRevision?.transposeSemitones ?? 0,
    notes: analysis.candidateNotes.map((note) => ({
      candidateKey: note.candidateKey,
      startSeconds: note.startSeconds,
      endSeconds: note.endSeconds,
      midiNote: note.midiNote,
      lyric: null,
      sourceTrack: null,
      scorable: true,
      confidence: note.meanConfidence,
    })),
    pitchPoints: analysis.contour.map((point) => ({
      timeSeconds: point.timeSeconds,
      frequencyHz: point.frequencyHz,
      midiNote: point.midiNote,
      confidence: point.confidence,
    })),
    detectorVersion: analysis.detectorVersion,
    contour: analysis.contour.map((point) => ({ ...point })),
  }
}
