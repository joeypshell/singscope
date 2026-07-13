import { describe, expect, it } from 'vitest'

import { SegmentedAudioTimeline } from './timeline'

describe('SegmentedAudioTimeline', () => {
  it('maps only scored AudioContext intervals and retains explicit stalled gaps', () => {
    const timeline = new SegmentedAudioTimeline()
    timeline.reanchor({ contextTimeSeconds: 10, projectTimeSeconds: 2, playbackRate: 1 })
    expect(timeline.projectTimeAt(10.5)).toBeCloseTo(2.5)

    timeline.markUnscored(11, 'stalled')
    expect(timeline.projectTimeAt(11.5)).toBeNull()

    timeline.reanchor({ contextTimeSeconds: 12, projectTimeSeconds: 2, playbackRate: 1 })
    expect(timeline.projectTimeAt(12.5)).toBeCloseTo(2.5)
    expect(timeline.contextTimesAt(2.5)).toEqual([10.5, 12.5])
    expect(timeline.segments.map((segment) => segment.state)).toEqual([
      'playing',
      'unscored',
      'playing',
    ])
  })

  it('reanchors for rate changes and rejects backwards context time', () => {
    const timeline = new SegmentedAudioTimeline()
    timeline.reanchor({ contextTimeSeconds: 1, projectTimeSeconds: 0, playbackRate: 1 })
    timeline.reanchor({ contextTimeSeconds: 2, projectTimeSeconds: 1, playbackRate: 0.5 })
    expect(timeline.projectTimeAt(3)).toBeCloseTo(1.5)
    expect(() => timeline.markUnscored(1.5, 'drift')).toThrow(/backwards/)
    timeline.finish(4)
    expect(timeline.projectTimeAt(4)).toBeNull()
  })

  it('replaces an immediate anchor without producing a zero-length segment', () => {
    const timeline = new SegmentedAudioTimeline()
    timeline.markUnscored(5, 'not-playing')
    timeline.reanchor({ contextTimeSeconds: 5, projectTimeSeconds: 3, playbackRate: 1 })
    expect(timeline.segments).toHaveLength(1)
    expect(timeline.projectTimeAt(5)).toBe(3)
  })
})
