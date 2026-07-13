import { describe, expect, it } from 'vitest'

import { clampToLoop, createLoopPasses, isValidLoopRegion, wrapLoopTime } from './loops'

describe('loop utilities', () => {
  const loop = { startSeconds: 10, endSeconds: 12 }

  it('wraps exact loop boundaries and schedules separate-take iterations', () => {
    expect(wrapLoopTime(loop, 9)).toBe(9)
    expect(wrapLoopTime(loop, 12)).toBe(10)
    expect(wrapLoopTime(loop, 15)).toBe(11)
    expect(createLoopPasses(loop, 3, true)).toEqual([
      {
        iteration: 1,
        projectStartSeconds: 10,
        projectEndSeconds: 12,
        relativeStartSeconds: 0,
        relativeEndSeconds: 2,
        startsNewTake: true,
      },
      {
        iteration: 2,
        projectStartSeconds: 10,
        projectEndSeconds: 12,
        relativeStartSeconds: 2,
        relativeEndSeconds: 4,
        startsNewTake: true,
      },
      {
        iteration: 3,
        projectStartSeconds: 10,
        projectEndSeconds: 12,
        relativeStartSeconds: 4,
        relativeEndSeconds: 6,
        startsNewTake: true,
      },
    ])
  })

  it('validates and clamps loop positions', () => {
    expect(isValidLoopRegion({ ...loop, repeatCount: null })).toBe(true)
    expect(isValidLoopRegion({ startSeconds: 2, endSeconds: 2, repeatCount: 1 })).toBe(false)
    expect(clampToLoop(loop, 3)).toBe(10)
    expect(clampToLoop(loop, 20)).toBe(12)
    expect(() => createLoopPasses(loop, 0, false)).toThrow(/positive integer/)
  })
})
