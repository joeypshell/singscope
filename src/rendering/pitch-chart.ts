export interface PitchChartPoint {
  readonly timeSeconds: number
  readonly frequencyHz: number | null
  readonly confidence: number
}

export interface TargetPitchSegment {
  readonly startSeconds: number
  readonly endSeconds: number
  readonly frequencyHz: number
  readonly label?: string | undefined
}

export interface AnalysisGap {
  readonly startSeconds: number
  readonly endSeconds: number
}

export interface PitchViewport {
  readonly startSeconds: number
  readonly endSeconds: number
  readonly minMidi: number
  readonly maxMidi: number
}

export interface PitchChartScene {
  readonly viewport: PitchViewport
  readonly targets: readonly TargetPitchSegment[]
  /** Accepted contour from an analyzed source. This is evidence, not an editable target. */
  readonly source: readonly PitchChartPoint[]
  readonly raw: readonly PitchChartPoint[]
  readonly smoothed: readonly PitchChartPoint[]
  readonly gaps: readonly AnalysisGap[]
  readonly playheadSeconds?: number | null
  readonly mode?: 'pitch' | 'cents'
}

export interface CanvasResolution {
  readonly cssWidth: number
  readonly cssHeight: number
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly dpr: number
}

const MAX_CANVAS_PIXELS = 4_000_000
const MAX_DPR = 2

export function frequencyToMidi(frequencyHz: number): number {
  return 69 + 12 * Math.log2(frequencyHz / 440)
}

export function calculateCanvasResolution(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): CanvasResolution {
  const width = Math.max(1, Math.floor(cssWidth))
  const height = Math.max(1, Math.floor(cssHeight))
  const requestedDpr = Math.max(1, Math.min(MAX_DPR, devicePixelRatio || 1))
  const maxDprForPixels = Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
  // Very large CSS canvases may require sub-1 backing resolution to keep iOS memory bounded.
  const dpr = Math.max(0.1, Math.min(requestedDpr, maxDprForPixels))
  return {
    cssWidth: width,
    cssHeight: height,
    pixelWidth: Math.max(1, Math.floor(width * dpr)),
    pixelHeight: Math.max(1, Math.floor(height * dpr)),
    dpr,
  }
}

export function timeToX(timeSeconds: number, viewport: PitchViewport, width: number): number {
  const duration = Math.max(0.001, viewport.endSeconds - viewport.startSeconds)
  return ((timeSeconds - viewport.startSeconds) / duration) * width
}

export function frequencyToY(frequencyHz: number, viewport: PitchViewport, height: number): number {
  const midi = frequencyToMidi(frequencyHz)
  const span = Math.max(1, viewport.maxMidi - viewport.minMidi)
  return height - ((midi - viewport.minMidi) / span) * height
}

export function xToTime(x: number, viewport: PitchViewport, width: number): number {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)))
  return viewport.startSeconds + ratio * (viewport.endSeconds - viewport.startSeconds)
}

function visible(timeSeconds: number, viewport: PitchViewport): boolean {
  return timeSeconds >= viewport.startSeconds && timeSeconds <= viewport.endSeconds
}

function targetAt(scene: PitchChartScene, timeSeconds: number): TargetPitchSegment | undefined {
  return scene.targets.find(
    (target) => timeSeconds >= target.startSeconds && timeSeconds < target.endSeconds,
  )
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

function midiLabel(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12
  return `${NOTE_NAMES[pitchClass] ?? '—'}${Math.floor(midi / 12) - 1}`
}

function centsToY(cents: number, height: number): number {
  const clamped = Math.max(-150, Math.min(150, cents))
  return height - ((clamped + 150) / 300) * height
}

function pointToY(
  point: PitchChartPoint & { readonly frequencyHz: number },
  scene: PitchChartScene,
  height: number,
): number | null {
  if (scene.mode !== 'cents') return frequencyToY(point.frequencyHz, scene.viewport, height)
  const target = targetAt(scene, point.timeSeconds)
  if (!target) return null
  return centsToY(1200 * Math.log2(point.frequencyHz / target.frequencyHz), height)
}

function drawGrid(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  width: number,
  height: number,
): void {
  context.strokeStyle = '#d8d8dc'
  context.fillStyle = '#65656d'
  context.lineWidth = 1
  context.font = '12px system-ui'
  const firstSecond = Math.ceil(scene.viewport.startSeconds)
  for (let second = firstSecond; second <= scene.viewport.endSeconds; second += 1) {
    const x = timeToX(second, scene.viewport, width)
    context.beginPath()
    context.moveTo(x, 0)
    context.lineTo(x, height)
    context.stroke()
    if (second % 5 === 0) context.fillText(`${second}s`, x + 3, 14)
  }
  if (scene.mode === 'cents') {
    for (let cents = -100; cents <= 100; cents += 25) {
      const y = centsToY(cents, height)
      context.globalAlpha =
        cents === 0 || Math.abs(cents) === 50 || Math.abs(cents) === 100 ? 0.7 : 0.28
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
      context.fillText(`${cents > 0 ? '+' : ''}${cents}¢`, 3, Math.max(12, y - 3))
    }
  } else {
    for (let midi = Math.ceil(scene.viewport.minMidi); midi <= scene.viewport.maxMidi; midi += 1) {
      const frequency = 440 * 2 ** ((midi - 69) / 12)
      const y = frequencyToY(frequency, scene.viewport, height)
      context.globalAlpha = midi % 12 === 0 ? 0.7 : 0.28
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
      if (midi % 12 === 0 || midi === Math.ceil(scene.viewport.minMidi)) {
        context.globalAlpha = 0.82
        context.fillText(midiLabel(midi), 3, Math.max(13, Math.min(height - 3, y - 3)))
      }
    }
  }
  context.globalAlpha = 1
}

function drawSource(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  width: number,
  height: number,
): void {
  if (scene.mode === 'cents' || scene.source.length === 0) return
  context.save()
  context.strokeStyle = '#6b3fa0'
  context.lineWidth = 2
  context.setLineDash([6, 4])
  context.lineJoin = 'round'
  context.beginPath()
  let drawing = false
  for (const point of scene.source) {
    if (point.frequencyHz === null || !visible(point.timeSeconds, scene.viewport)) {
      drawing = false
      continue
    }
    const x = timeToX(point.timeSeconds, scene.viewport, width)
    const y = frequencyToY(point.frequencyHz, scene.viewport, height)
    if (!drawing) context.moveTo(x, y)
    else context.lineTo(x, y)
    drawing = true
  }
  context.stroke()
  context.restore()
}

function drawGaps(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  width: number,
  height: number,
): void {
  context.save()
  context.strokeStyle = '#777780'
  context.lineWidth = 1
  context.globalAlpha = 0.32
  for (const gap of scene.gaps) {
    if (
      gap.endSeconds < scene.viewport.startSeconds ||
      gap.startSeconds > scene.viewport.endSeconds
    )
      continue
    const startX = timeToX(
      Math.max(gap.startSeconds, scene.viewport.startSeconds),
      scene.viewport,
      width,
    )
    const endX = timeToX(Math.min(gap.endSeconds, scene.viewport.endSeconds), scene.viewport, width)
    context.fillStyle = '#f3f3f5'
    context.fillRect(startX, 0, endX - startX, height)
    for (let x = startX - height; x < endX; x += 9) {
      context.beginPath()
      context.moveTo(x, height)
      context.lineTo(x + height, 0)
      context.stroke()
    }
  }
  context.restore()
}

function drawTargets(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  width: number,
  height: number,
): void {
  context.save()
  context.strokeStyle = '#244e8a'
  context.lineWidth = 7
  context.lineCap = 'round'
  for (const target of scene.targets) {
    if (
      target.endSeconds < scene.viewport.startSeconds ||
      target.startSeconds > scene.viewport.endSeconds
    )
      continue
    const y =
      scene.mode === 'cents'
        ? centsToY(0, height)
        : frequencyToY(target.frequencyHz, scene.viewport, height)
    context.beginPath()
    context.moveTo(timeToX(target.startSeconds, scene.viewport, width), y)
    context.lineTo(timeToX(target.endSeconds, scene.viewport, width), y)
    context.stroke()
  }
  context.restore()
}

function drawRaw(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  width: number,
  height: number,
): void {
  context.save()
  context.strokeStyle = '#be3d2a'
  context.fillStyle = '#be3d2a'
  context.lineWidth = 1.5
  for (const point of scene.raw) {
    if (point.frequencyHz === null || !visible(point.timeSeconds, scene.viewport)) continue
    const x = timeToX(point.timeSeconds, scene.viewport, width)
    const y = pointToY(point as PitchChartPoint & { readonly frequencyHz: number }, scene, height)
    if (y === null) continue
    context.beginPath()
    context.arc(x, y, point.confidence >= 0.75 ? 2 : 3, 0, Math.PI * 2)
    if (point.confidence >= 0.75) context.fill()
    else context.stroke()
  }
  context.restore()
}

function drawSmoothed(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  width: number,
  height: number,
): void {
  context.save()
  context.strokeStyle = '#a72218'
  context.lineWidth = 2.5
  context.lineJoin = 'round'
  context.beginPath()
  let drawing = false
  for (const point of scene.smoothed) {
    if (point.frequencyHz === null || !visible(point.timeSeconds, scene.viewport)) {
      drawing = false
      continue
    }
    const x = timeToX(point.timeSeconds, scene.viewport, width)
    const y = pointToY(point as PitchChartPoint & { readonly frequencyHz: number }, scene, height)
    if (y === null) {
      drawing = false
      continue
    }
    if (!drawing) context.moveTo(x, y)
    else context.lineTo(x, y)
    drawing = true
  }
  context.stroke()
  context.restore()
}

export function renderPitchChart(
  context: CanvasRenderingContext2D,
  scene: PitchChartScene,
  resolution: CanvasResolution,
): void {
  const { cssWidth: width, cssHeight: height, dpr } = resolution
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  drawGrid(context, scene, width, height)
  drawGaps(context, scene, width, height)
  drawSource(context, scene, width, height)
  drawTargets(context, scene, width, height)
  drawRaw(context, scene, width, height)
  drawSmoothed(context, scene, width, height)
  if (scene.playheadSeconds !== null && scene.playheadSeconds !== undefined) {
    const x = timeToX(scene.playheadSeconds, scene.viewport, width)
    context.strokeStyle = '#111114'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(x, 0)
    context.lineTo(x, height)
    context.stroke()
  }
}
