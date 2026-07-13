import { assertNonNegativeSeconds, isFiniteNumber } from './guards'
import type { LoopRegion } from './types'

export interface LoopPass {
  readonly iteration: number
  readonly projectStartSeconds: number
  readonly projectEndSeconds: number
  readonly relativeStartSeconds: number
  readonly relativeEndSeconds: number
  readonly startsNewTake: boolean
}

export function loopDurationSeconds(loop: Pick<LoopRegion, 'startSeconds' | 'endSeconds'>): number {
  return loop.endSeconds - loop.startSeconds
}

export function isValidLoopRegion(
  loop: Pick<LoopRegion, 'startSeconds' | 'endSeconds' | 'repeatCount'>,
): boolean {
  return (
    isFiniteNumber(loop.startSeconds) &&
    loop.startSeconds >= 0 &&
    isFiniteNumber(loop.endSeconds) &&
    loop.endSeconds > loop.startSeconds &&
    (loop.repeatCount === null || (Number.isSafeInteger(loop.repeatCount) && loop.repeatCount >= 1))
  )
}

export function containsLoopTime(
  loop: Pick<LoopRegion, 'startSeconds' | 'endSeconds'>,
  projectTimeSeconds: number,
): boolean {
  return (
    isFiniteNumber(projectTimeSeconds) &&
    projectTimeSeconds >= loop.startSeconds &&
    projectTimeSeconds < loop.endSeconds
  )
}

/** Wraps a transport position without changing time before the loop begins. */
export function wrapLoopTime(
  loop: Pick<LoopRegion, 'startSeconds' | 'endSeconds'>,
  projectTimeSeconds: number,
): number | null {
  if (
    !isValidLoopRegion({ ...loop, repeatCount: 1 }) ||
    !isFiniteNumber(projectTimeSeconds) ||
    projectTimeSeconds < 0
  ) {
    return null
  }
  if (projectTimeSeconds < loop.startSeconds) return projectTimeSeconds
  const duration = loopDurationSeconds(loop)
  return loop.startSeconds + ((projectTimeSeconds - loop.startSeconds) % duration)
}

export function createLoopPasses(
  loop: Pick<LoopRegion, 'startSeconds' | 'endSeconds'>,
  count: number,
  separateTakes: boolean,
): readonly LoopPass[] {
  if (!isValidLoopRegion({ ...loop, repeatCount: 1 })) throw new RangeError('Invalid loop region')
  if (!Number.isSafeInteger(count) || count < 1)
    throw new RangeError('count must be a positive integer')
  const duration = loopDurationSeconds(loop)
  return Array.from({ length: count }, (_, index) => ({
    iteration: index + 1,
    projectStartSeconds: loop.startSeconds,
    projectEndSeconds: loop.endSeconds,
    relativeStartSeconds: index * duration,
    relativeEndSeconds: (index + 1) * duration,
    startsNewTake: separateTakes || index === 0,
  }))
}

export function clampToLoop(
  loop: Pick<LoopRegion, 'startSeconds' | 'endSeconds'>,
  projectTimeSeconds: number,
): number {
  assertNonNegativeSeconds(projectTimeSeconds, 'projectTimeSeconds')
  if (!isValidLoopRegion({ ...loop, repeatCount: 1 })) throw new RangeError('Invalid loop region')
  return Math.min(loop.endSeconds, Math.max(loop.startSeconds, projectTimeSeconds))
}
