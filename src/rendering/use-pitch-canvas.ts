import { useEffect, useRef } from 'react'
import { calculateCanvasResolution, renderPitchChart, type PitchChartScene } from './pitch-chart'

export function usePitchCanvas(scene: PitchChartScene, maxFps = 30) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef(scene)

  useEffect(() => {
    sceneRef.current = scene
  }, [scene])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let animationFrame = 0
    let lastFrame = 0
    let active = true
    const interval = 1000 / Math.max(1, Math.min(30, maxFps))

    const draw = (timestamp: number) => {
      if (!active) return
      if (timestamp - lastFrame >= interval) {
        const rect = canvas.getBoundingClientRect()
        const resolution = calculateCanvasResolution(
          rect.width,
          rect.height,
          window.devicePixelRatio,
        )
        if (canvas.width !== resolution.pixelWidth) canvas.width = resolution.pixelWidth
        if (canvas.height !== resolution.pixelHeight) canvas.height = resolution.pixelHeight
        const context = canvas.getContext('2d')
        if (context) renderPitchChart(context, sceneRef.current, resolution)
        lastFrame = timestamp
      }
      animationFrame = requestAnimationFrame(draw)
    }
    animationFrame = requestAnimationFrame(draw)
    return () => {
      active = false
      cancelAnimationFrame(animationFrame)
    }
  }, [maxFps])

  return canvasRef
}
