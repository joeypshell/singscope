import { assertFinite, assertNonNegativeSeconds } from './guards'

export type TimelineGapReason =
  'stalled' | 'seeking' | 'rate-change' | 'drift' | 'interrupted' | 'not-playing'

export type TransportClockState = 'playing' | 'unscored'

export interface TransportClockSegment {
  readonly sequence: number
  readonly contextStartSeconds: number
  readonly contextEndSeconds: number | null
  readonly projectStartSeconds: number | null
  readonly projectEndSeconds: number | null
  readonly playbackRate: number | null
  readonly state: TransportClockState
  readonly gapReason: TimelineGapReason | null
}

export interface TimelineAnchor {
  readonly contextTimeSeconds: number
  readonly projectTimeSeconds: number
  readonly playbackRate: number
}

export interface AudioTimeline {
  readonly segments: readonly TransportClockSegment[]
  reanchor(anchor: TimelineAnchor): void
  markUnscored(contextTimeSeconds: number, reason: TimelineGapReason): void
  finish(contextTimeSeconds: number): void
  projectTimeAt(contextTimeSeconds: number): number | null
  contextTimesAt(projectTimeSeconds: number): readonly number[]
}

interface MutableTransportClockSegment {
  sequence: number
  contextStartSeconds: number
  contextEndSeconds: number | null
  projectStartSeconds: number | null
  projectEndSeconds: number | null
  playbackRate: number | null
  state: TransportClockState
  gapReason: TimelineGapReason | null
}

function copySegment(segment: MutableTransportClockSegment): TransportClockSegment {
  return { ...segment }
}

/**
 * Maps AudioContext time to project time. It deliberately has no Date/clock API:
 * callers can only provide times from the audio context (or context frame stamps).
 */
export class SegmentedAudioTimeline implements AudioTimeline {
  readonly #segments: MutableTransportClockSegment[] = []

  get segments(): readonly TransportClockSegment[] {
    return this.#segments.map(copySegment)
  }

  reanchor(anchor: TimelineAnchor): void {
    assertNonNegativeSeconds(anchor.contextTimeSeconds, 'contextTimeSeconds')
    assertNonNegativeSeconds(anchor.projectTimeSeconds, 'projectTimeSeconds')
    assertFinite(anchor.playbackRate, 'playbackRate')
    if (anchor.playbackRate <= 0) throw new RangeError('playbackRate must be greater than zero')

    this.#begin({
      contextTimeSeconds: anchor.contextTimeSeconds,
      projectTimeSeconds: anchor.projectTimeSeconds,
      playbackRate: anchor.playbackRate,
      state: 'playing',
      gapReason: null,
    })
  }

  markUnscored(contextTimeSeconds: number, reason: TimelineGapReason): void {
    assertNonNegativeSeconds(contextTimeSeconds, 'contextTimeSeconds')
    this.#begin({
      contextTimeSeconds,
      projectTimeSeconds: null,
      playbackRate: null,
      state: 'unscored',
      gapReason: reason,
    })
  }

  finish(contextTimeSeconds: number): void {
    assertNonNegativeSeconds(contextTimeSeconds, 'contextTimeSeconds')
    this.#closeCurrent(contextTimeSeconds)
  }

  projectTimeAt(contextTimeSeconds: number): number | null {
    if (!Number.isFinite(contextTimeSeconds) || contextTimeSeconds < 0) return null
    for (let index = this.#segments.length - 1; index >= 0; index -= 1) {
      const segment = this.#segments[index]
      if (segment === undefined) continue
      const beforeEnd =
        segment.contextEndSeconds === null || contextTimeSeconds < segment.contextEndSeconds
      if (contextTimeSeconds < segment.contextStartSeconds || !beforeEnd) continue
      if (
        segment.state !== 'playing' ||
        segment.projectStartSeconds === null ||
        segment.playbackRate === null
      ) {
        return null
      }
      return (
        segment.projectStartSeconds +
        (contextTimeSeconds - segment.contextStartSeconds) * segment.playbackRate
      )
    }
    return null
  }

  contextTimesAt(projectTimeSeconds: number): readonly number[] {
    if (!Number.isFinite(projectTimeSeconds) || projectTimeSeconds < 0) return []
    const matches: number[] = []
    for (const segment of this.#segments) {
      if (
        segment.state !== 'playing' ||
        segment.projectStartSeconds === null ||
        segment.playbackRate === null
      ) {
        continue
      }
      const projectEnd = segment.projectEndSeconds
      if (projectTimeSeconds < segment.projectStartSeconds) continue
      if (projectEnd !== null && projectTimeSeconds >= projectEnd) continue
      matches.push(
        segment.contextStartSeconds +
          (projectTimeSeconds - segment.projectStartSeconds) / segment.playbackRate,
      )
    }
    return matches
  }

  #begin(input: {
    readonly contextTimeSeconds: number
    readonly projectTimeSeconds: number | null
    readonly playbackRate: number | null
    readonly state: TransportClockState
    readonly gapReason: TimelineGapReason | null
  }): void {
    const current = this.#segments.at(-1)
    if (input.contextTimeSeconds === current?.contextStartSeconds) {
      this.#segments.pop()
    } else {
      this.#closeCurrent(input.contextTimeSeconds)
    }

    this.#segments.push({
      sequence: this.#segments.length,
      contextStartSeconds: input.contextTimeSeconds,
      contextEndSeconds: null,
      projectStartSeconds: input.projectTimeSeconds,
      projectEndSeconds: null,
      playbackRate: input.playbackRate,
      state: input.state,
      gapReason: input.gapReason,
    })
  }

  #closeCurrent(contextTimeSeconds: number): void {
    const current = this.#segments.at(-1)
    if (current === undefined) return
    if (current.contextEndSeconds !== null) {
      if (contextTimeSeconds < current.contextEndSeconds) {
        throw new RangeError('AudioContext time cannot move backwards')
      }
      return
    }
    if (contextTimeSeconds < current.contextStartSeconds) {
      throw new RangeError('AudioContext time cannot move backwards')
    }
    current.contextEndSeconds = contextTimeSeconds
    if (
      current.state === 'playing' &&
      current.projectStartSeconds !== null &&
      current.playbackRate !== null
    ) {
      current.projectEndSeconds =
        current.projectStartSeconds +
        (contextTimeSeconds - current.contextStartSeconds) * current.playbackRate
    }
  }
}
