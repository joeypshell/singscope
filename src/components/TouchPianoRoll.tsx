import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'

import { calculateCanvasResolution } from '../rendering/pitch-chart'
import type { EditableTargetNote } from './TargetNoteEditor'
import { calculateRollViewport, type RollViewport } from './touch-piano-roll-viewport'

export interface TouchPianoRollProps {
  readonly notes: readonly EditableTargetNote[]
  readonly onChange: (note: EditableTargetNote) => void
  readonly transpositionSemitones?: number | undefined
  readonly durationSeconds?: number | undefined
}

interface NoteRect {
  readonly note: EditableTargetNote
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface DragState {
  readonly pointerId: number
  readonly note: EditableTargetNote
  readonly originClientX: number
  readonly canvasWidth: number
  readonly durationSeconds: number
}

function noteRects(
  notes: readonly EditableTargetNote[],
  viewport: RollViewport,
  width: number,
  height: number,
  transpositionSemitones: number,
): readonly NoteRect[] {
  const pitchRows = Math.max(1, viewport.maxMidi - viewport.minMidi + 1)
  const rowHeight = height / pitchRows
  return notes.map((note) => ({
    note,
    x: (note.startSeconds / viewport.durationSeconds) * width,
    y: (viewport.maxMidi - (note.midiNote + transpositionSemitones)) * rowHeight + 1,
    width: Math.max(8, ((note.endSeconds - note.startSeconds) / viewport.durationSeconds) * width),
    height: Math.max(8, rowHeight - 2),
  }))
}

function drawRoll(
  canvas: HTMLCanvasElement,
  notes: readonly EditableTargetNote[],
  viewport: RollViewport,
  selectedId: string | null,
  transpositionSemitones: number,
): void {
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const resolution = calculateCanvasResolution(rect.width, rect.height, window.devicePixelRatio)
  canvas.width = resolution.pixelWidth
  canvas.height = resolution.pixelHeight

  let context: CanvasRenderingContext2D | null = null
  try {
    context = canvas.getContext('2d')
  } catch {
    return
  }
  if (!context) return

  context.setTransform(resolution.dpr, 0, 0, resolution.dpr, 0, 0)
  context.clearRect(0, 0, resolution.cssWidth, resolution.cssHeight)
  context.fillStyle = '#fffdfa'
  context.fillRect(0, 0, resolution.cssWidth, resolution.cssHeight)

  const rows = viewport.maxMidi - viewport.minMidi + 1
  const rowHeight = resolution.cssHeight / rows
  context.lineWidth = 1
  for (let row = 0; row <= rows; row += 1) {
    const midi = viewport.maxMidi - row
    context.strokeStyle = midi % 12 === 0 ? '#857b70' : '#ded8d0'
    context.beginPath()
    context.moveTo(0, row * rowHeight)
    context.lineTo(resolution.cssWidth, row * rowHeight)
    context.stroke()
    if (midi % 12 === 0) {
      context.fillStyle = '#625b53'
      context.font = '11px system-ui'
      context.fillText(`C${Math.floor(midi / 12) - 1}`, 3, Math.max(12, row * rowHeight - 2))
    }
  }

  const timeTickSeconds =
    viewport.durationSeconds <= 12 ? 1 : viewport.durationSeconds <= 90 ? 5 : 30
  for (let second = 0; second <= viewport.durationSeconds; second += timeTickSeconds) {
    const x = (second / viewport.durationSeconds) * resolution.cssWidth
    context.fillStyle = '#625b53'
    context.font = '11px system-ui'
    context.fillText(`${second}s`, Math.min(resolution.cssWidth - 22, x + 3), 13)
  }

  for (const rectToDraw of noteRects(
    notes,
    viewport,
    resolution.cssWidth,
    resolution.cssHeight,
    transpositionSemitones,
  )) {
    const selected = rectToDraw.note.id === selectedId
    context.fillStyle = selected ? '#f1a832' : '#244e8a'
    context.strokeStyle = '#171719'
    context.lineWidth = selected ? 3 : 1.5
    context.fillRect(rectToDraw.x, rectToDraw.y, rectToDraw.width, rectToDraw.height)
    context.strokeRect(rectToDraw.x, rectToDraw.y, rectToDraw.width, rectToDraw.height)
  }
}

export function TouchPianoRoll({
  notes,
  onChange,
  transpositionSemitones = 0,
  durationSeconds,
}: TouchPianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const viewport = useMemo(
    () => calculateRollViewport(notes, transpositionSemitones, durationSeconds),
    [durationSeconds, notes, transpositionSemitones],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas) drawRoll(canvas, notes, viewport, selectedId, transpositionSemitones)
  }, [notes, selectedId, transpositionSemitones, viewport])

  useEffect(() => {
    draw()
    if (typeof ResizeObserver === 'undefined' || !canvasRef.current) return
    const observer = new ResizeObserver(draw)
    observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [draw])

  const noteAtPointer = (event: PointerEvent<HTMLCanvasElement>): NoteRect | null => {
    const canvasRect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - canvasRect.left
    const y = event.clientY - canvasRect.top
    const candidates = noteRects(
      notes,
      viewport,
      canvasRect.width,
      canvasRect.height,
      transpositionSemitones,
    )
    return (
      [...candidates]
        .reverse()
        .find(
          (candidate) =>
            x >= candidate.x &&
            x <= candidate.x + candidate.width &&
            y >= candidate.y &&
            y <= candidate.y + candidate.height,
        ) ?? null
    )
  }

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }

  return (
    <div className="ss-piano-roll-wrap">
      <p id="touch-piano-roll-help">
        Optional touch editor: drag a note left or right to change its timing. Use the authoritative
        fields below for exact values.
      </p>
      <canvas
        ref={canvasRef}
        className="ss-piano-roll"
        role="img"
        aria-label="Touch piano roll for target note timing and pitch after transpose"
        aria-describedby="touch-piano-roll-help"
        onPointerDown={(event) => {
          const hit = noteAtPointer(event)
          if (!hit) return
          const canvasRect = event.currentTarget.getBoundingClientRect()
          event.currentTarget.setPointerCapture(event.pointerId)
          setSelectedId(hit.note.id)
          dragRef.current = {
            pointerId: event.pointerId,
            note: hit.note,
            originClientX: event.clientX,
            canvasWidth: canvasRect.width,
            durationSeconds: viewport.durationSeconds,
          }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag?.pointerId !== event.pointerId || drag.canvasWidth <= 0) return
          const deltaSeconds =
            ((event.clientX - drag.originClientX) / drag.canvasWidth) * drag.durationSeconds
          const startSeconds = Math.max(
            0,
            Math.round((drag.note.startSeconds + deltaSeconds) * 100) / 100,
          )
          const durationSeconds = drag.note.endSeconds - drag.note.startSeconds
          onChange({
            ...drag.note,
            startSeconds,
            endSeconds: startSeconds + durationSeconds,
          })
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        Target-note piano roll. Use the note list below when Canvas is unavailable.
      </canvas>
    </div>
  )
}
