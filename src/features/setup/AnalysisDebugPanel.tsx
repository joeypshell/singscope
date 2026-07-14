import type { AnalysisDebugRouteCategory, AnalysisDebugView } from '../../app/types'
import { StatusBanner } from '../../components/StatusBanner'

export interface AnalysisDebugPanelProps {
  readonly model: AnalysisDebugView
  readonly onExpectedNoteCountChange: (count: number | null) => void
  readonly onIssueDescriptionChange: (description: string) => void
  readonly onRouteCategoryChange: (route: AnalysisDebugRouteCategory) => void
  readonly onPrepare: () => void
  readonly onShareOrSave: () => void
}

export function AnalysisDebugPanel({
  model,
  onExpectedNoteCountChange,
  onIssueDescriptionChange,
  onRouteCategoryChange,
  onPrepare,
  onShareOrSave,
}: AnalysisDebugPanelProps) {
  const preparing = model.phase === 'preparing'
  const sharing = model.phase === 'sharing'
  const ready = model.phase === 'ready' || model.phase === 'complete'

  return (
    <section className="ss-card ss-stack" aria-labelledby="analysis-debug-heading">
      <div>
        <h3 id="analysis-debug-heading">Help diagnose a missed-note bug</h3>
        <p>
          Prepare a debug package containing the exact analyzed source audio—your microphone audio
          when recorded here—plus the raw analysis, estimated notes, browser user-agent/version,
          viewport and display mode, and applied capture settings. Preparation stays on this device.
          Nothing is uploaded or shared unless you make a fresh Share / Save tap.
        </p>
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
            disabled={preparing || sharing}
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
            disabled={preparing || sharing}
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
            disabled={preparing || sharing}
            value={model.issueDescription}
            onChange={(event) => onIssueDescriptionChange(event.currentTarget.value)}
          />
        </label>
      </div>
      <p className="ss-help">
        The package may contain identifiable voice or room audio. Review where you send it; its
        diagnostics omit your project title, file name, microphone identifier, and unrelated
        projects. Attaching it to ChatGPT—or sending it to any other service or person—uploads the
        exact audio and diagnostics to that recipient.
      </p>
      {model.errorMessage ? (
        <StatusBanner
          tone="danger"
          title="Debug package could not finish"
          message={model.errorMessage}
        />
      ) : null}
      {model.phase === 'complete' ? (
        <StatusBanner
          tone="success"
          title="Share / Save request accepted"
          message="Your browser accepted the request. You can use the prepared package again until a new analysis replaces it."
        />
      ) : null}
      <div className="ss-button-row">
        <button
          className="ss-button ss-button--primary"
          type="button"
          disabled={preparing || sharing}
          onClick={onPrepare}
        >
          {preparing ? '1. Preparing debug package…' : '1. Prepare debug package'}
        </button>
        <button className="ss-button" type="button" disabled={!ready} onClick={onShareOrSave}>
          2. Share / Save
          {model.packageSizeLabel ? ` · ${model.packageSizeLabel}` : ''}
        </button>
      </div>
    </section>
  )
}
