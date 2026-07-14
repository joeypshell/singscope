import type { TargetMode } from '../features/setup/ProjectSetupScreen'
import type { TargetPitchGapReason } from '../domain/types'

export interface AppTargetNote {
  readonly id: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly midiNote: number
  readonly lyric: string
  readonly scorable: boolean
}

export interface AppTargetPitchPoint {
  readonly timeSeconds: number
  /** Missing only on analyzed targets saved before raw-contour preservation. */
  readonly candidateHz?: number | null | undefined
  readonly frequencyHz: number | null
  readonly midiNote: number | null
  readonly confidence: number | null
  readonly rms?: number | null | undefined
  readonly peak?: number | null | undefined
  readonly gapReason?: TargetPitchGapReason | null | undefined
}

export interface AppLoop {
  readonly id: string
  readonly name: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly repetitions: number
  readonly enabled: boolean
}

export interface AppPitchPoint {
  readonly timeSeconds: number
  readonly contextTimeSeconds: number
  readonly candidateHz: number | null
  readonly frequencyHz: number | null
  readonly midiNote: number | null
  readonly confidence: number | null
  readonly rms: number
  readonly peak: number
  readonly gapReason: string | null
  readonly detectorVersion: string
}

export interface AppTake {
  readonly id: string
  readonly createdAt: string
  readonly label: string
  /** Project timeline position corresponding to recorded-media time zero. */
  readonly projectStartSeconds: number
  readonly durationSeconds: number
  readonly audioAssetId: string | null
  readonly audioMimeType: string | null
  readonly partialReason: string | null
  readonly points: readonly AppPitchPoint[]
}

export interface AppProject {
  readonly id: string
  readonly schemaVersion: 1
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly referenceName: string | null
  readonly referenceAssetId: string | null
  readonly referenceMimeType: string | null
  readonly referenceDurationSeconds: number
  readonly isSyntheticDemo: boolean
  readonly targetMode: TargetMode
  readonly targetStatus: string
  readonly targetSourceAssetId: string | null
  readonly targetSourceName: string | null
  readonly targetSourceMimeType: string | null
  readonly targetRevision: number
  readonly transpositionSemitones: number
  readonly alignmentSeconds: number
  readonly timingOffsetSeconds: number
  readonly notes: readonly AppTargetNote[]
  readonly targetPitchPoints: readonly AppTargetPitchPoint[]
  readonly loops: readonly AppLoop[]
  readonly takes: readonly AppTake[]
  readonly lastBackupAt: string | null
}

export type DraftProject = Omit<
  AppProject,
  'updatedAt' | 'createdAt' | 'schemaVersion' | 'takes' | 'lastBackupAt'
> & {
  readonly createdAt?: string
}
