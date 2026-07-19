import { MetricGrid, type MetricDisplay } from '../../components/MetricGrid'
import { PitchChartCanvas } from '../../components/PitchChartCanvas'
import { Sheet } from '../../components/Sheet'
import { StatusBanner } from '../../components/StatusBanner'
import { TransportControls } from '../../components/TransportControls'
import type { PitchChartPoint, PitchChartScene } from '../../rendering/pitch-chart'
import type { AnalysisDebugRouteCategory, AnalysisDebugView } from '../../app/types'
import { AnalysisDebugPanel } from '../setup/AnalysisDebugPanel'
import { ExportPanel, type ExportView } from './ExportPanel'

export interface ReviewPointView extends PitchChartPoint {
  readonly targetFrequencyHz: number | null
  readonly centsError: number | null
  readonly noteLabel: string | null
}

export interface ReviewView {
  readonly projectTitle: string
  readonly takeLabel: string
  readonly playbackPhase: 'idle' | 'playing' | 'paused'
  readonly currentSeconds: number
  readonly durationSeconds: number
  readonly scene: PitchChartScene
  readonly metrics: readonly MetricDisplay[]
  readonly sectionMetrics: readonly {
    readonly id: string
    readonly name: string
    readonly metrics: readonly MetricDisplay[]
  }[]
  readonly selectedPoint: ReviewPointView | null
  readonly timingOffsetSeconds: number
  readonly partialReason: string | null
  readonly export: ExportView
  readonly traceDisplay: 'raw' | 'smoothed' | 'both'
  readonly pitchMode: 'pitch' | 'cents'
  readonly zoomLevel: number
  readonly loopPlayback: boolean
  readonly analysisDebug?: AnalysisDebugView | undefined
}

export interface ReviewScreenProps {
  readonly model: ReviewView
  readonly onBack: () => void
  readonly onPlay: () => void
  readonly onPause: () => void
  readonly onStop: () => void
  readonly onSeek: (seconds: number) => void
  readonly onTimingOffsetChange: (seconds: number) => void
  readonly onPrepareExport: () => void
  readonly onShareExport: () => void
  readonly onIncludeReferenceChange: (enabled: boolean) => void
  readonly onIncludeWavChange: (enabled: boolean) => void
  readonly onTraceDisplayChange: (display: ReviewView['traceDisplay']) => void
  readonly onPitchModeChange: (mode: ReviewView['pitchMode']) => void
  readonly onZoomIn: () => void
  readonly onZoomOut: () => void
  readonly onLoopPlaybackChange: (enabled: boolean) => void
  readonly onSaveRecording?: (() => void) | undefined
  readonly onSavePitchCsv?: (() => void) | undefined
  readonly onSaveTargetCsv?: (() => void) | undefined
  readonly onSaveChartPng?: (() => void) | undefined
  readonly onSaveSessionJson?: (() => void) | undefined
  readonly onSaveReportHtml?: (() => void) | undefined
  readonly onSaveManifestJson?: (() => void) | undefined
  readonly onSaveReadme?: (() => void) | undefined
  readonly onAnalysisDebugExpectedNoteCountChange?: ((count: number | null) => void) | undefined
  readonly onAnalysisDebugIssueDescriptionChange?: ((description: string) => void) | undefined
  readonly onAnalysisDebugRouteCategoryChange?:
    ((route: AnalysisDebugRouteCategory) => void) | undefined
  readonly onSendAnalysisDebug?: (() => void) | undefined
  readonly onSaveAnalysisDebugPackage?: (() => void) | undefined
}

export function ReviewScreen({
  model,
  onBack,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onTimingOffsetChange,
  onPrepareExport,
  onShareExport,
  onIncludeReferenceChange,
  onIncludeWavChange,
  onTraceDisplayChange,
  onPitchModeChange,
  onZoomIn,
  onZoomOut,
  onLoopPlaybackChange,
  onSaveRecording,
  onSavePitchCsv,
  onSaveTargetCsv,
  onSaveChartPng,
  onSaveSessionJson,
  onSaveReportHtml,
  onSaveManifestJson,
  onSaveReadme,
  onAnalysisDebugExpectedNoteCountChange,
  onAnalysisDebugIssueDescriptionChange,
  onAnalysisDebugRouteCategoryChange,
  onSendAnalysisDebug,
  onSaveAnalysisDebugPackage,
}: ReviewScreenProps) {
  const visibleScene: PitchChartScene = {
    ...model.scene,
    mode: model.pitchMode,
    raw: model.traceDisplay === 'smoothed' ? [] : model.scene.raw,
    smoothed: model.traceDisplay === 'raw' ? [] : model.scene.smoothed,
  }
  return (
    <main className="ss-screen">
      <header className="ss-review-heading">
        <div>
          <p className="ss-eyebrow">Review · {model.takeLabel}</p>
          <h1>{model.projectTitle}</h1>
        </div>
        <button className="ss-button" type="button" onClick={onBack}>
          Practice
        </button>
      </header>

      <div className="ss-stack">
        {model.partialReason ? (
          <StatusBanner
            tone="warning"
            title="Recoverable partial take"
            message={model.partialReason}
          />
        ) : null}
        <section className="ss-card ss-stack" aria-label="Review chart controls">
          <div className="ss-segmented" aria-label="Pitch trace display">
            {(['raw', 'smoothed', 'both'] as const).map((display) => (
              <button
                key={display}
                type="button"
                aria-pressed={model.traceDisplay === display}
                onClick={() => onTraceDisplayChange(display)}
              >
                {display === 'raw' ? 'Raw' : display === 'smoothed' ? 'Smoothed' : 'Both'}
              </button>
            ))}
          </div>
          <div className="ss-button-row">
            <button
              className="ss-button"
              type="button"
              aria-pressed={model.pitchMode === 'pitch'}
              onClick={() => onPitchModeChange('pitch')}
            >
              Pitch view
            </button>
            <button
              className="ss-button"
              type="button"
              aria-pressed={model.pitchMode === 'cents'}
              onClick={() => onPitchModeChange('cents')}
            >
              Cents view
            </button>
            <button className="ss-button" type="button" onClick={onZoomOut} aria-label="Zoom out">
              −
            </button>
            <span aria-live="polite">{model.zoomLevel.toFixed(1)}× zoom</span>
            <button className="ss-button" type="button" onClick={onZoomIn} aria-label="Zoom in">
              +
            </button>
          </div>
          <label className="ss-choice">
            <input
              type="checkbox"
              checked={model.loopPlayback}
              onChange={(event) => onLoopPlaybackChange(event.currentTarget.checked)}
            />
            <span>Loop the visible review range</span>
          </label>
        </section>
        <PitchChartCanvas
          scene={visibleScene}
          label="Review chart showing target, raw pitch, smoothed display pitch, confidence gaps, and playhead."
          onScrub={onSeek}
          height={420}
        />
        <TransportControls
          phase={model.playbackPhase}
          currentSeconds={model.currentSeconds}
          durationSeconds={model.durationSeconds}
          onStart={onPlay}
          onPause={onPause}
          onStop={onStop}
          onSeek={onSeek}
        />

        {model.analysisDebug &&
        onAnalysisDebugExpectedNoteCountChange &&
        onAnalysisDebugIssueDescriptionChange &&
        onAnalysisDebugRouteCategoryChange &&
        onSendAnalysisDebug &&
        onSaveAnalysisDebugPackage ? (
          <Sheet title="Report recording problem" summary="Send this take's diagnostics">
            <AnalysisDebugPanel
              model={model.analysisDebug}
              onExpectedNoteCountChange={onAnalysisDebugExpectedNoteCountChange}
              onIssueDescriptionChange={onAnalysisDebugIssueDescriptionChange}
              onRouteCategoryChange={onAnalysisDebugRouteCategoryChange}
              onSend={onSendAnalysisDebug}
              onSavePackage={onSaveAnalysisDebugPackage}
            />
          </Sheet>
        ) : null}

        <section className="ss-card ss-stack" aria-labelledby="metrics-heading">
          <div>
            <h2 id="metrics-heading">Transparent metrics</h2>
            <p>No overall score. Every number is independently inspectable.</p>
          </div>
          <MetricGrid metrics={model.metrics} />
          <label className="ss-field">
            <span>Manual timing offset (seconds)</span>
            <input
              type="number"
              inputMode="decimal"
              step={0.001}
              min={-2}
              max={2}
              value={model.timingOffsetSeconds}
              onChange={(event) => onTimingOffsetChange(event.currentTarget.valueAsNumber)}
            />
          </label>
        </section>

        <Sheet
          title="Inspected point"
          summary={
            model.selectedPoint ? `${model.selectedPoint.timeSeconds.toFixed(2)}s` : 'Tap the chart'
          }
        >
          {model.selectedPoint ? (
            <dl className="ss-metric-grid">
              <div>
                <dt>Time</dt>
                <dd>{model.selectedPoint.timeSeconds.toFixed(3)}s</dd>
              </div>
              <div>
                <dt>Raw pitch</dt>
                <dd>
                  {model.selectedPoint.frequencyHz === null
                    ? 'Unvoiced'
                    : `${model.selectedPoint.frequencyHz.toFixed(2)} Hz`}
                </dd>
              </div>
              <div>
                <dt>Error</dt>
                <dd>
                  {model.selectedPoint.centsError === null
                    ? 'Unscored'
                    : `${model.selectedPoint.centsError > 0 ? '+' : ''}${model.selectedPoint.centsError.toFixed(1)}¢`}
                </dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{Math.round(model.selectedPoint.confidence * 100)}%</dd>
              </div>
            </dl>
          ) : (
            <p>
              Tap or scrub the chart, or use the accessible playhead slider, to inspect a point.
            </p>
          )}
        </Sheet>

        <Sheet title="Section metrics" summary={`${model.sectionMetrics.length} sections`}>
          <div className="ss-stack">
            {model.sectionMetrics.map((section) => (
              <section key={section.id} aria-labelledby={`section-${section.id}`}>
                <h3 id={`section-${section.id}`}>{section.name}</h3>
                <MetricGrid metrics={section.metrics} />
              </section>
            ))}
          </div>
        </Sheet>

        <section className="ss-card">
          <ExportPanel
            model={model.export}
            onPrepare={onPrepareExport}
            onShareOrSave={onShareExport}
            onIncludeReferenceChange={onIncludeReferenceChange}
            onIncludeWavChange={onIncludeWavChange}
            onSaveRecording={onSaveRecording}
            onSavePitchCsv={onSavePitchCsv}
            onSaveTargetCsv={onSaveTargetCsv}
            onSaveChartPng={onSaveChartPng}
            onSaveSessionJson={onSaveSessionJson}
            onSaveReportHtml={onSaveReportHtml}
            onSaveManifestJson={onSaveManifestJson}
            onSaveReadme={onSaveReadme}
          />
        </section>
      </div>
    </main>
  )
}
