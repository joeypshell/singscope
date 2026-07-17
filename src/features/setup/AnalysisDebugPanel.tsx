import type { AnalysisDebugRouteCategory, AnalysisDebugView } from '../../app/types'
import { StatusBanner } from '../../components/StatusBanner'

export interface AnalysisDebugPanelProps {
  readonly model: AnalysisDebugView
  readonly onExpectedNoteCountChange: (count: number | null) => void
  readonly onIssueDescriptionChange: (description: string) => void
  readonly onRouteCategoryChange: (route: AnalysisDebugRouteCategory) => void
  readonly onSend: () => void
  readonly onSavePackage: () => void
}

function sendButtonLabel(model: AnalysisDebugView): string {
  if (model.phase === 'preparing') return 'Preparing report…'
  if (model.phase === 'uploading') return 'Sending report…'
  if (model.phase === 'complete') return 'Report sent'
  if (model.phase === 'error' && model.canSavePackage) return 'Retry sending report'
  if (model.phase === 'error') return 'Try sending again'
  return 'Send bug report'
}

export function AnalysisDebugPanel({
  model,
  onExpectedNoteCountChange,
  onIssueDescriptionChange,
  onRouteCategoryChange,
  onSend,
  onSavePackage,
}: AnalysisDebugPanelProps) {
  const busy = model.phase === 'preparing' || model.phase === 'uploading'
  const decodeFailure = model.context === 'decode-failure'

  return (
    <section className="ss-card ss-stack" aria-labelledby="analysis-debug-heading">
      <div>
        <h3 id="analysis-debug-heading">
          {decodeFailure ? 'Report this recording failure' : 'Report a missed-note bug'}
        </h3>
        {decodeFailure ? (
          <p>
            One tap prepares and sends the exact microphone recording that this browser could not
            decode, plus the failure description, browser version, viewport, display mode, and
            applied capture settings. SingScope does not send a report until you tap the button
            below.
          </p>
        ) : (
          <p>
            One tap prepares and sends the exact analyzed source audio—your microphone audio when
            recorded here—plus the raw analysis, estimated notes, browser version, viewport, display
            mode, and applied capture settings. SingScope does not send a report until you tap the
            button below.
          </p>
        )}
      </div>
      <div className="ss-stack">
        <label className="ss-field">
          <span>Number of notes you played (optional)</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            disabled={busy}
            value={model.expectedNoteCount ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber
              onExpectedNoteCountChange(Number.isFinite(value) ? value : null)
            }}
          />
        </label>
        <label className="ss-field">
          <span>Microphone route</span>
          <select
            value={model.routeCategory}
            disabled={busy}
            onChange={(event) =>
              onRouteCategoryChange(event.currentTarget.value as AnalysisDebugRouteCategory)
            }
          >
            <option value="unknown">Not sure</option>
            <option value="built-in">Built-in iPhone microphone</option>
            <option value="wired">Wired / USB-C microphone</option>
            <option value="bluetooth">Bluetooth microphone</option>
          </select>
        </label>
        <label className="ss-field">
          <span>What went wrong? (optional)</span>
          <textarea
            maxLength={500}
            rows={3}
            disabled={busy}
            value={model.issueDescription}
            onChange={(event) => onIssueDescriptionChange(event.currentTarget.value)}
          />
        </label>
      </div>
      <p className="ss-help">
        The report may contain identifiable voice or room audio. Tapping Send uploads it to the
        private SingScope report inbox, where authorized maintainers can access it and Supabase may
        also process normal request metadata such as your IP address. The service records a 30-day
        deletion deadline; until scheduled cleanup is verified, a maintainer must delete it. The
        diagnostics omit your project title, file name, microphone identifier, lyrics, and unrelated
        projects.
      </p>
      {!model.reportingAvailable ? (
        <StatusBanner
          tone="warning"
          title="Direct reporting is not configured"
          message="This build has no report destination. Update the app configuration before sending a report."
        />
      ) : null}
      {model.errorMessage ? (
        <StatusBanner
          tone="danger"
          title="Bug report delivery not confirmed"
          message={model.errorMessage}
        />
      ) : null}
      {model.phase === 'complete' && model.reportId ? (
        <StatusBanner
          tone="success"
          title="Bug report sent"
          message={`Report ID: ${model.reportId}${model.receivedAt ? ` · Received ${model.receivedAt}` : ''}`}
        />
      ) : null}
      <div className="ss-button-row">
        <button
          className="ss-button ss-button--primary"
          type="button"
          disabled={!model.reportingAvailable || busy || model.phase === 'complete'}
          onClick={onSend}
        >
          {sendButtonLabel(model)}
          {model.packageSizeLabel && model.phase === 'error' ? ` · ${model.packageSizeLabel}` : ''}
        </button>
        {model.phase === 'error' && model.canSavePackage ? (
          <button className="ss-button" type="button" onClick={onSavePackage}>
            Save debug package
          </button>
        ) : null}
      </div>
    </section>
  )
}
