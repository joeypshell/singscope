import { describe, expect, it, vi } from 'vitest'
import { BoundedPitchTrace, createLevelOfDetail } from './bounded-trace'
import {
  calculateCanvasResolution,
  frequencyToMidi,
  renderPitchChart,
  timeToX,
  xToTime,
} from './pitch-chart'

describe('pitch chart geometry', () => {
  it('caps DPR and total canvas pixels', () => {
    expect(calculateCanvasResolution(1000, 500, 3)).toMatchObject({
      pixelWidth: 2000,
      pixelHeight: 1000,
      dpr: 2,
    })
    const large = calculateCanvasResolution(4000, 2000, 2)
    expect(large.pixelWidth * large.pixelHeight).toBeLessThanOrEqual(4_000_000)
  })

  it('round trips timeline coordinates', () => {
    const viewport = { startSeconds: 10, endSeconds: 20, minMidi: 48, maxMidi: 84 }
    expect(xToTime(timeToX(12.5, viewport, 800), viewport, 800)).toBeCloseTo(12.5)
    expect(frequencyToMidi(440)).toBeCloseTo(69)
  })

  it('draws low-confidence candidates as hollow points across the visible pitch range', () => {
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      setLineDash: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      font: '',
    } as unknown as CanvasRenderingContext2D
    const scene = {
      viewport: { startSeconds: 0, endSeconds: 1, minMidi: 40, maxMidi: 86 },
      targets: [],
      source: [],
      raw: [
        { timeSeconds: 0.25, frequencyHz: 110, confidence: 0.5 },
        { timeSeconds: 0.75, frequencyHz: 1046.5, confidence: 0.9 },
      ],
      smoothed: [],
      gaps: [],
      mode: 'pitch' as const,
    }
    renderPitchChart(context, scene, {
      cssWidth: 320,
      cssHeight: 200,
      pixelWidth: 320,
      pixelHeight: 200,
      dpr: 1,
    })

    const arcs = vi.mocked(context.arc).mock.calls
    expect(arcs).toHaveLength(2)
    expect(arcs[0]?.[2]).toBe(3)
    expect(arcs[1]?.[2]).toBe(2)
    expect(arcs.every((call) => call[1] >= 0 && call[1] <= 200)).toBe(true)
    expect(context.fill).toHaveBeenCalledOnce()
  })
})

describe('bounded traces and LOD', () => {
  it('retains only the configured recent trace', () => {
    const trace = new BoundedPitchTrace(2, 3)
    for (let timeSeconds = 0; timeSeconds < 5; timeSeconds += 1) {
      trace.append({ timeSeconds, frequencyHz: timeSeconds === 3 ? null : 440, confidence: 0.9 })
    }
    expect(trace.snapshot().map((point) => point.timeSeconds)).toEqual([2, 3, 4])
    expect(trace.snapshot()[1]?.frequencyHz).toBeNull()
  })

  it('preserves per-pixel extrema when reducing review data', () => {
    const points = Array.from({ length: 100 }, (_, index) => ({
      timeSeconds: index / 10,
      frequencyHz: 200 + (index % 10) * 10,
      confidence: 1,
    }))
    const reduced = createLevelOfDetail(points, 0, 10, 5)
    expect(reduced.length).toBeLessThanOrEqual(10)
    expect(reduced.some((point) => point.frequencyHz === 290)).toBe(true)
  })
})
