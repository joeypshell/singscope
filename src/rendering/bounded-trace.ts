import type { PitchChartPoint } from './pitch-chart'

export class BoundedPitchTrace {
  private readonly maxPoints: number
  private readonly maxSeconds: number
  private points: PitchChartPoint[] = []

  constructor(maxSeconds = 90, maxPoints = 6000) {
    this.maxSeconds = Math.max(1, maxSeconds)
    this.maxPoints = Math.max(2, maxPoints)
  }

  append(point: PitchChartPoint): void {
    if (!Number.isFinite(point.timeSeconds)) return
    this.points.push(point)
    const cutoff = point.timeSeconds - this.maxSeconds
    let removeCount = 0
    while (
      removeCount < this.points.length &&
      ((this.points[removeCount]?.timeSeconds ?? Number.POSITIVE_INFINITY) < cutoff ||
        this.points.length - removeCount > this.maxPoints)
    ) {
      removeCount += 1
    }
    if (removeCount > 0) this.points.splice(0, removeCount)
  }

  snapshot(): readonly PitchChartPoint[] {
    return this.points.slice()
  }

  clear(): void {
    this.points = []
  }
}

export function createLevelOfDetail(
  points: readonly PitchChartPoint[],
  startSeconds: number,
  endSeconds: number,
  pixelWidth: number,
): readonly PitchChartPoint[] {
  if (points.length <= pixelWidth * 2 || pixelWidth <= 0) return points.slice()
  const duration = Math.max(0.001, endSeconds - startSeconds)
  const bins: PitchChartPoint[][] = Array.from({ length: pixelWidth }, () => [])
  for (const point of points) {
    if (point.timeSeconds < startSeconds || point.timeSeconds > endSeconds) continue
    const index = Math.min(
      pixelWidth - 1,
      Math.max(0, Math.floor(((point.timeSeconds - startSeconds) / duration) * pixelWidth)),
    )
    bins[index]?.push(point)
  }
  return bins.flatMap((bin) => {
    if (bin.length <= 2) return bin
    const voiced = bin.filter(
      (point): point is PitchChartPoint & { frequencyHz: number } => point.frequencyHz !== null,
    )
    if (voiced.length === 0) {
      const midpoint = bin[Math.floor(bin.length / 2)]
      return midpoint ? [midpoint] : []
    }
    let minimum = voiced[0] as PitchChartPoint & { frequencyHz: number }
    let maximum = minimum
    for (const point of voiced.slice(1)) {
      if (point.frequencyHz < minimum.frequencyHz) minimum = point
      if (point.frequencyHz > maximum.frequencyHz) maximum = point
    }
    return minimum.timeSeconds <= maximum.timeSeconds ? [minimum, maximum] : [maximum, minimum]
  })
}
