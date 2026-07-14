import type { PointerEvent } from 'react'
import { formatTime } from './time-format'
import { xToTime, type PitchChartScene } from '../rendering/pitch-chart'
import { usePitchCanvas } from '../rendering/use-pitch-canvas'

export interface PitchChartCanvasProps {
  readonly scene: PitchChartScene
  readonly label: string
  readonly onScrub?: (seconds: number) => void
  readonly height?: number
}

export function PitchChartCanvas({ scene, label, onScrub, height = 320 }: PitchChartCanvasProps) {
  const canvasRef = usePitchCanvas(scene, 30)
  const canvasClassName = `ss-chart__canvas${height >= 400 ? ' ss-chart__canvas--review' : ''}${onScrub ? ' ss-chart__canvas--interactive' : ''}`

  const scrubAtPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!onScrub) return
    const rect = event.currentTarget.getBoundingClientRect()
    onScrub(xToTime(event.clientX - rect.left, scene.viewport, rect.width))
  }

  return (
    <figure className="ss-chart">
      <canvas
        ref={canvasRef}
        className={canvasClassName}
        aria-label={label}
        role="img"
        onPointerDown={(event) => {
          if (!onScrub) return
          event.currentTarget.setPointerCapture(event.pointerId)
          scrubAtPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) scrubAtPointer(event)
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
      >
        {label}
      </canvas>
      <figcaption>
        {scene.targets.length > 0 ? (
          <span>
            <i className="ss-key ss-key--target" /> Editable target
          </span>
        ) : null}
        {scene.source.length > 0 && scene.mode !== 'cents' ? (
          <span>
            <i className="ss-key ss-key--source" /> Analyzed source contour
          </span>
        ) : null}
        {scene.raw.length > 0 ? (
          <span>
            <i className="ss-key ss-key--raw" /> Raw candidates
          </span>
        ) : null}
        {scene.smoothed.length > 0 ? (
          <span>
            <i className="ss-key ss-key--smooth" /> Smoothed accepted pitch
          </span>
        ) : null}
      </figcaption>
      {onScrub ? (
        <input
          aria-label="Chart playhead"
          aria-valuetext={formatTime(scene.playheadSeconds ?? scene.viewport.startSeconds)}
          className="ss-range"
          type="range"
          min={scene.viewport.startSeconds}
          max={scene.viewport.endSeconds}
          step={0.01}
          value={scene.playheadSeconds ?? scene.viewport.startSeconds}
          onChange={(event) => onScrub(event.currentTarget.valueAsNumber)}
        />
      ) : null}
    </figure>
  )
}
