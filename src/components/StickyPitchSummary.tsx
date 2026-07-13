export interface StickyPitchSummaryProps {
  readonly phase: 'idle' | 'ready' | 'countdown' | 'recording' | 'paused' | 'retry' | 'finalizing'
  readonly noteName: string | null
  readonly frequencyHz: number | null
  readonly cents: number | null
  readonly confidence: number | null
  readonly level: number
}

export function StickyPitchSummary({
  phase,
  noteName,
  frequencyHz,
  cents,
  confidence,
  level,
}: StickyPitchSummaryProps) {
  const normalizedLevel = Math.max(0, Math.min(1, level))
  const centsText =
    cents === null ? 'No pitch' : `${cents > 0 ? '+' : ''}${Math.round(cents)} cents`
  return (
    <header className={`ss-pitch-summary ss-pitch-summary--${phase}`}>
      <div>
        <small>{phase === 'recording' ? '● Recording' : phase}</small>
        <strong>{noteName ?? '—'}</strong>
      </div>
      <div className="ss-pitch-summary__reading">
        <span>{centsText}</span>
        <small>{frequencyHz === null ? 'Listening…' : `${frequencyHz.toFixed(1)} Hz`}</small>
      </div>
      <progress
        className="ss-meter"
        aria-label="Microphone level"
        max={1}
        value={normalizedLevel}
      />
      <span className="ss-visually-hidden">
        Practice state: {phase}.{' '}
        {confidence === null
          ? 'No confidence reading'
          : `${Math.round(confidence * 100)} percent confidence`}
      </span>
    </header>
  )
}
