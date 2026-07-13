import type {
  CALIBRATION_SCHEMA_VERSION,
  LOOP_SCHEMA_VERSION,
  PITCH_CHUNK_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION,
  REFERENCE_AUDIO_SCHEMA_VERSION,
  TAKE_SCHEMA_VERSION,
  TARGET_SET_SCHEMA_VERSION,
} from './versions'

export type EntityId = string
export type UtcDateString = string
export type Seconds = number

export type AudioAssetKind = 'backing' | 'isolated-vocal' | 'take' | 'prepared-export'
export type TargetKind = 'midi' | 'manual' | 'analyzed'
export type TargetSetStatus = 'draft' | 'active' | 'archived'
export type InterruptionReason =
  | 'app-hidden'
  | 'audio-context-interrupted'
  | 'media-track-ended'
  | 'route-lost'
  | 'device-locked'
  | 'unknown'

export interface CalibrationSettings {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION
  readonly inputLatencySeconds: Seconds
  readonly timingOffsetSeconds: Seconds
  readonly transposeSemitones: number
  readonly confidenceThreshold: number
}

export interface PracticeProject {
  readonly schemaVersion: typeof PROJECT_SCHEMA_VERSION
  readonly id: EntityId
  readonly name: string
  readonly createdAt: UtcDateString
  readonly updatedAt: UtcDateString
  readonly backingAudioId: EntityId | null
  readonly activeTargetSetId: EntityId | null
  readonly calibration: CalibrationSettings
}

export interface ReferenceAudio {
  readonly schemaVersion: typeof REFERENCE_AUDIO_SCHEMA_VERSION
  readonly id: EntityId
  readonly projectId: EntityId
  readonly assetId: EntityId
  readonly kind: Extract<AudioAssetKind, 'backing' | 'isolated-vocal'>
  readonly originalName: string
  readonly mimeType: string
  readonly durationSeconds: Seconds
  readonly byteLength: number
  readonly sha256: string
  readonly createdAt: UtcDateString
}

export interface TargetNote {
  readonly id: EntityId
  readonly startSeconds: Seconds
  readonly endSeconds: Seconds
  readonly midiNote: number
  readonly lyric: string | null
  readonly sourceTrack: number | null
  readonly scorable: boolean
}

export interface TargetPitchPoint {
  readonly timeSeconds: Seconds
  readonly frequencyHz: number | null
  readonly midiNote: number | null
  readonly confidence: number | null
}

/** A target revision is immutable. Edits create a new revision with parentTargetSetId. */
export interface TargetSet {
  readonly schemaVersion: typeof TARGET_SET_SCHEMA_VERSION
  readonly id: EntityId
  readonly projectId: EntityId
  readonly revision: number
  readonly kind: TargetKind
  readonly status: TargetSetStatus
  readonly createdAt: UtcDateString
  readonly sourceAssetId: EntityId | null
  readonly parentTargetSetId: EntityId | null
  readonly alignmentSeconds: Seconds
  readonly transposeSemitones: number
  readonly notes: readonly TargetNote[]
  readonly pitchPoints: readonly TargetPitchPoint[]
}

export interface LoopRegion {
  readonly schemaVersion: typeof LOOP_SCHEMA_VERSION
  readonly id: EntityId
  readonly projectId: EntityId
  readonly name: string
  readonly startSeconds: Seconds
  readonly endSeconds: Seconds
  /** null repeats until the user stops; otherwise includes the first pass. */
  readonly repeatCount: number | null
}

export interface RecordingDescriptor {
  readonly assetId: EntityId
  readonly mimeType: string
  readonly byteLength: number
  readonly sha256: string
  readonly durationSeconds: Seconds
}

export interface PracticeTake {
  readonly schemaVersion: typeof TAKE_SCHEMA_VERSION
  readonly id: EntityId
  readonly projectId: EntityId
  readonly targetSetId: EntityId
  readonly loopId: EntityId | null
  readonly createdAt: UtcDateString
  readonly projectStartSeconds: Seconds
  readonly projectEndSeconds: Seconds
  readonly partial: boolean
  readonly interruptionReason: InterruptionReason | null
  readonly recording: RecordingDescriptor
}

export type PitchGapReason =
  | 'silence'
  | 'below-confidence'
  | 'out-of-range'
  | 'invalid-frame'
  | 'timeline-gap'
  | 'queue-overflow'

/** Raw detector output aligned to the AudioContext/project timeline. */
export interface DetectedPitchPoint {
  readonly timeSeconds: Seconds
  readonly contextTimeSeconds: Seconds
  /** Candidate is retained even when it is below the scoring threshold. */
  readonly candidateHz: number | null
  /** Null means this point was not accepted as voiced. */
  readonly frequencyHz: number | null
  readonly midiNote: number | null
  readonly confidence: number | null
  readonly rms: number
  readonly peak: number
  readonly gapReason: PitchGapReason | null
  readonly detectorVersion: string
}

export interface PitchChunk {
  readonly schemaVersion: typeof PITCH_CHUNK_SCHEMA_VERSION
  readonly id: EntityId
  readonly takeId: EntityId
  readonly sequence: number
  readonly startSeconds: Seconds
  readonly endSeconds: Seconds
  readonly points: readonly DetectedPitchPoint[]
}

export interface PerformanceMetrics {
  readonly formulaVersion: string
  readonly confidenceThreshold: number
  readonly scorablePointCount: number
  readonly confidentPointCount: number
  readonly coverage: number | null
  readonly within25Cents: number | null
  readonly within50Cents: number | null
  readonly within100Cents: number | null
  readonly signedMeanErrorCents: number | null
  readonly meanAbsoluteErrorCents: number | null
  readonly p90AbsoluteErrorCents: number | null
  readonly longestAccurateSpanSeconds: number | null
  readonly accurateNoteCount: number
  readonly scorableNoteCount: number
  readonly noteAccuracy: number | null
  readonly accurateOnsetCount: number
  readonly scorableOnsetCount: number
  readonly onsetAccuracy: number | null
  readonly meanAbsoluteOnsetErrorSeconds: number | null
  readonly sustainedNoteStabilityCents: number | null
}

export interface ExportManifest {
  readonly schemaVersion: number
  readonly projectId: EntityId
  readonly takeIds: readonly EntityId[]
  readonly createdAt: UtcDateString
  readonly files: readonly {
    readonly path: string
    readonly byteLength: number
    readonly sha256: string
  }[]
}
