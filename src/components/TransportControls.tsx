export interface TransportControlsProps {
  readonly phase: 'idle' | 'countdown' | 'playing' | 'paused' | 'retry' | 'recording' | 'finalizing'
  readonly currentSeconds: number
  readonly durationSeconds: number
  readonly countdownSeconds?: number
  readonly loopEnabled?: boolean
  readonly disabled?: boolean
  readonly onStart: () => void
  readonly onPause: () => void
  readonly onStop: () => void
  readonly onSeek: (seconds: number) => void
}

export function TransportControls({
  phase,
  currentSeconds,
  durationSeconds,
  countdownSeconds = 0,
  loopEnabled = false,
  disabled = false,
  onStart,
  onPause,
  onStop,
  onSeek,
}: TransportControlsProps) {
  const active = phase === 'playing' || phase === 'recording' || phase === 'countdown'
  const startLabel = phase === 'retry' ? 'Tap to retry' : phase === 'paused' ? 'Resume' : 'Start'
  return (
    <section className="ss-transport" aria-label="Practice transport">
      <span className="ss-visually-hidden" role="status">
        Transport {phase === 'recording' ? 'recording' : phase}.
      </span>
      <div className="ss-transport__readout">
        <strong>
          {phase === 'countdown' ? Math.ceil(countdownSeconds) : formatTime(currentSeconds)}
        </strong>
        <span>
          {phase === 'recording'
            ? '● Recording'
            : loopEnabled
              ? '↻ Loop on'
              : formatTime(durationSeconds)}
        </span>
      </div>
      <input
        aria-label="Timeline position"
        aria-valuetext={`${formatTime(currentSeconds)} of ${formatTime(durationSeconds)}`}
        className="ss-range"
        type="range"
        min={0}
        max={Math.max(0.01, durationSeconds)}
        step={0.01}
        value={Math.max(0, Math.min(durationSeconds, currentSeconds))}
        onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
      />
      <div className="ss-button-row">
        <button
          className="ss-button ss-button--primary"
          type="button"
          onClick={active ? onPause : onStart}
          disabled={disabled}
        >
          {phase === 'recording'
            ? 'Finish take'
            : phase === 'countdown'
              ? 'Cancel'
              : active
                ? 'Pause'
                : startLabel}
        </button>
        <button
          className="ss-button"
          type="button"
          onClick={onStop}
          disabled={disabled || phase === 'idle'}
        >
          Stop
        </button>
      </div>
    </section>
  )
}
import { formatTime } from './time-format'
