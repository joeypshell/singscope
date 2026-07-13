import { StatusBanner } from '../../components/StatusBanner'

export interface ExportView {
  readonly phase: 'idle' | 'preparing' | 'ready' | 'sharing' | 'complete' | 'error'
  readonly packageSizeLabel: string | null
  readonly shareSheetEligible: boolean
  readonly includeReference: boolean
  readonly includeWav: boolean
  readonly omissions: readonly string[]
  readonly errorMessage: string | null
  readonly individualFiles?:
    | {
        readonly recording: boolean
        readonly pitchCsv: boolean
        readonly targetCsv: boolean
        readonly chartPng: boolean
        readonly sessionJson: boolean
        readonly reportHtml: boolean
        readonly manifestJson: boolean
        readonly readme: boolean
      }
    | undefined
}

export interface ExportPanelProps {
  readonly model: ExportView
  readonly onPrepare: () => void
  readonly onShareOrSave: () => void
  readonly onIncludeReferenceChange: (enabled: boolean) => void
  readonly onIncludeWavChange: (enabled: boolean) => void
  readonly onSaveRecording?: (() => void) | undefined
  readonly onSavePitchCsv?: (() => void) | undefined
  readonly onSaveTargetCsv?: (() => void) | undefined
  readonly onSaveChartPng?: (() => void) | undefined
  readonly onSaveSessionJson?: (() => void) | undefined
  readonly onSaveReportHtml?: (() => void) | undefined
  readonly onSaveManifestJson?: (() => void) | undefined
  readonly onSaveReadme?: (() => void) | undefined
}

export function ExportPanel({
  model,
  onPrepare,
  onShareOrSave,
  onIncludeReferenceChange,
  onIncludeWavChange,
  onSaveRecording,
  onSavePitchCsv,
  onSaveTargetCsv,
  onSaveChartPng,
  onSaveSessionJson,
  onSaveReportHtml,
  onSaveManifestJson,
  onSaveReadme,
}: ExportPanelProps) {
  return (
    <section className="ss-stack" aria-labelledby="export-heading">
      <div>
        <h2 id="export-heading">Coach-ready package</h2>
        <p>
          Preparation happens locally. Sharing requires a fresh tap for iPhone’s Share Sheet or Save
          to Files.
        </p>
      </div>
      <label className="ss-choice">
        <input
          type="checkbox"
          checked={model.includeWav}
          onChange={(event) => onIncludeWavChange(event.currentTarget.checked)}
        />
        <span>Include WAV when it fits the 32 MiB / 96 MiB memory limits</span>
      </label>
      <label className="ss-choice">
        <input
          type="checkbox"
          checked={model.includeReference}
          onChange={(event) => onIncludeReferenceChange(event.currentTarget.checked)}
        />
        <span>I have the rights to include the reference audio</span>
      </label>
      {model.omissions.length > 0 ? (
        <StatusBanner
          tone="warning"
          title="Some optional files will be omitted"
          message={model.omissions.join(' ')}
        />
      ) : null}
      {model.errorMessage ? (
        <StatusBanner tone="danger" title="Export could not finish" message={model.errorMessage} />
      ) : null}
      {model.individualFiles ? (
        <div className="ss-stack">
          <div>
            <h3>Individual files</h3>
            <p>Save the essentials separately if a full package is too large.</p>
          </div>
          <div className="ss-button-row">
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.recording || !onSaveRecording}
              onClick={onSaveRecording}
            >
              Save recording
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.pitchCsv || !onSavePitchCsv}
              onClick={onSavePitchCsv}
            >
              Save pitch CSV
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.targetCsv || !onSaveTargetCsv}
              onClick={onSaveTargetCsv}
            >
              Save target CSV
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.chartPng || !onSaveChartPng}
              onClick={onSaveChartPng}
            >
              Save chart PNG
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.sessionJson || !onSaveSessionJson}
              onClick={onSaveSessionJson}
            >
              Save session JSON
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.reportHtml || !onSaveReportHtml}
              onClick={onSaveReportHtml}
            >
              Save report HTML
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.manifestJson || !onSaveManifestJson}
              onClick={onSaveManifestJson}
            >
              Save manifest JSON
            </button>
            <button
              className="ss-button"
              type="button"
              disabled={!model.individualFiles.readme || !onSaveReadme}
              onClick={onSaveReadme}
            >
              Save README
            </button>
          </div>
        </div>
      ) : null}
      <div className="ss-button-row">
        <button
          className="ss-button ss-button--primary"
          type="button"
          disabled={model.phase === 'preparing'}
          onClick={onPrepare}
        >
          {model.phase === 'preparing' ? 'Preparing…' : 'Prepare package'}
        </button>
        <button
          className="ss-button"
          type="button"
          disabled={model.phase !== 'ready'}
          onClick={onShareOrSave}
        >
          {model.shareSheetEligible ? 'Share / Save' : 'Save to Files'}
          {model.packageSizeLabel ? ` · ${model.packageSizeLabel}` : ''}
        </button>
      </div>
    </section>
  )
}
