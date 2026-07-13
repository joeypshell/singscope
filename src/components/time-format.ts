export function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  const remaining = safe - minutes * 60
  return `${minutes}:${remaining.toFixed(1).padStart(4, '0')}`
}

export function parseExactTime(value: string): number | null {
  const trimmed = value.trim()
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const match = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(trimmed)
  if (!match) return null
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  return minutes * 60 + seconds
}
