import type { CaptureSettings } from '../../audio/runtime/types'
import { formatTime } from '../../components/time-format'
import { StatusBanner } from '../../components/StatusBanner'

export type RecordedMelodyPhase =
  'idle' | 'requesting' | 'recording' | 'finalizing' | 'analyzing' | 'error'

export interface RecordedMelodyView {
  readonly phase: RecordedMelodyPhase
  readonly elapsedSeconds: number
  readonly captureSettings: CaptureSettings | null
  readonly errorMessage: string | null
  readonly hasRecordedSource: boolean
}

export interface RecordedMelodyControlProps {
  readonly model: RecordedMelodyView
  readonly onStart: () => void
  readonly onStop: () => void
  readonly onRecordAgain: () => void
  readonly useAsReference?: boolean | undefined
  readonly onUseAsReferenceChange?: ((checked: boolean) => void) | undefined
}

function reportedBoolean(value: boolean | null): string {
  return value === null ? 'Not reported' : value ? 'On' : 'Off'
}

function CaptureSettingsSummary({ settings }: { readonly settings: CaptureSettings }) {
  return (
    <section className="ss-stack" aria-labelledby="applied-microphone-settings-heading">
      <h4 id="applied-microphone-settings-heading">Settings actually applied</h4>
      <dl className="ss-metric-grid">
        <div>
          <dt>Microphone</dt>
          <dd>{settings.label ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt>Sample rate</dt>
          <dd>{settings.sampleRate === null ? 'Not reported' : `${settings.sampleRate} Hz`}</dd>
        </div>
        <div>
          <dt>Channels</dt>
          <dd>{settings.channelCount ?? 'Not reported'}</dd>
        </div>
        <div>
          <dt>Echo cancellation</dt>
          <dd>{reportedBoolean(settings.echoCancellation)}</dd>
        </div>
        <div>
          <dt>Noise suppression</dt>
          <dd>{reportedBoolean(settings.noiseSuppression)}</dd>
        </div>
        <div>
          <dt>Automatic gain</dt>
          <dd>{reportedBoolean(settings.autoGainControl)}</dd>
        </div>
      </dl>
    </section>
  )
}

function BusyStatus({ phase }: Pick<RecordedMelodyView, 'phase'>) {
  if (phase === 'requesting') {
    return (
      <StatusBanner
        tone="info"
        title="Waiting for microphone permission…"
        message="Safari may ask you to allow microphone access for this site."
      />
    )
  }
  if (phase === 'recording') {
    return (
      <StatusBanner
        tone="warning"
        title="● Recording melody"
        message="Keep SingScope in the foreground. Switching apps safely stops this capture."
      />
    )
  }
  if (phase === 'finalizing') {
    return (
      <StatusBanner
        tone="info"
        title="Finishing local recording…"
        message="Waiting for the final microphone bytes before analysis."
      />
    )
  }
  if (phase === 'analyzing') {
    return (
      <StatusBanner
        tone="info"
        title="Analyzing recording on this device…"
        message="The estimated notes will remain editable before you save."
      />
    )
  }
  return null
}

export function RecordedMelodyControl({
  model,
  onStart,
  onStop,
  onRecordAgain,
  useAsReference,
  onUseAsReferenceChange,
}: RecordedMelodyControlProps) {
  const busy =
    model.phase === 'requesting' ||
    model.phase === 'recording' ||
    model.phase === 'finalizing' ||
    model.phase === 'analyzing'

  return (
    <section className="ss-stack" aria-labelledby="record-melody-heading">
      <div>
        <h3 id="record-melody-heading">Record a melody</h3>
        <p>
          Sing, hum, whistle, or play one note at a time. Leave a short silence between notes.
          Chords and mixed music are not supported.
        </p>
        <p>Record up to 60 seconds (8 MiB maximum) and keep SingScope in the foreground.</p>
        <p>Recorded and analyzed only on this device. Nothing is uploaded.</p>
      </div>

      {model.phase === 'error' ? (
        <StatusBanner
          tone="danger"
          title="Recording needs attention"
          message={model.errorMessage ?? 'The recording could not be used. Try again.'}
          actionLabel="Record again"
          onAction={onRecordAgain}
        />
      ) : (
        <BusyStatus phase={model.phase} />
      )}

      {model.phase === 'recording' ? (
        <p>
          <strong>Elapsed:</strong>{' '}
          <time
            aria-label="Recording elapsed time"
            dateTime={`PT${Math.max(0, model.elapsedSeconds)}S`}
          >
            {formatTime(model.elapsedSeconds)}
          </time>
        </p>
      ) : null}

      {model.captureSettings ? <CaptureSettingsSummary settings={model.captureSettings} /> : null}

      {useAsReference !== undefined && onUseAsReferenceChange ? (
        <label className="ss-choice">
          <input
            type="checkbox"
            checked={useAsReference}
            disabled={busy}
            onChange={(event) => onUseAsReferenceChange(event.currentTarget.checked)}
          />
          <span>Also use this melody audio as the backing audio</span>
        </label>
      ) : null}

      <div className="ss-button-row">
        {model.phase === 'idle' && !model.hasRecordedSource ? (
          <button className="ss-button ss-button--primary" type="button" onClick={onStart}>
            Start recording
          </button>
        ) : null}
        {model.phase === 'idle' && model.hasRecordedSource ? (
          <button className="ss-button" type="button" onClick={onRecordAgain}>
            Record again
          </button>
        ) : null}
        {model.phase === 'recording' ? (
          <button className="ss-button ss-button--primary" type="button" onClick={onStop}>
            Stop and analyze
          </button>
        ) : null}
      </div>
    </section>
  )
}
