import { StatusBanner } from '../../components/StatusBanner'
import { PitchChartCanvas } from '../../components/PitchChartCanvas'
import { TargetNoteEditor, type EditableTargetNote } from '../../components/TargetNoteEditor'
import type { KeyboardNoteInput } from '../../components/MelodyKeyboard'
import type { PitchChartScene } from '../../rendering/pitch-chart'
import { RecordedMelodyControl, type RecordedMelodyView } from './RecordedMelodyControl'
import { AnalysisDebugPanel } from './AnalysisDebugPanel'
import type { AnalysisDebugRouteCategory, AnalysisDebugView } from '../../app/types'

export type { RecordedMelodyPhase, RecordedMelodyView } from './RecordedMelodyControl'

export type TargetMode = 'midi' | 'manual' | 'isolated-vocal'

export interface MidiTrackView {
  readonly id: string
  readonly name: string
  readonly noteCount: number
}

export interface ProjectSetupView {
  readonly title: string
  readonly referenceName: string | null
  readonly targetMode: TargetMode
  readonly targetStatus: string
  readonly notes: readonly EditableTargetNote[]
  readonly transpositionSemitones: number
  readonly alignmentSeconds: number
  readonly validationMessage: string | null
  readonly canSave: boolean
  readonly midiTracks?: readonly MidiTrackView[] | undefined
  readonly selectedMidiTrackId?: string | null | undefined
  readonly recordedMelody?: RecordedMelodyView | undefined
  readonly analysisScene?: PitchChartScene | undefined
  readonly analysisSourceUrl?: string | null | undefined
  readonly analysisDebug?: AnalysisDebugView | undefined
}

export interface ProjectSetupScreenProps {
  readonly model: ProjectSetupView
  readonly onBack: () => void
  readonly onTitleChange: (title: string) => void
  readonly onReferenceFile: (file: File) => void
  readonly onTargetModeChange: (mode: TargetMode) => void
  readonly onMidiFile: (file: File) => void
  readonly onMidiTrackChange?: ((trackId: string) => void) | undefined
  readonly onIsolatedVocalFile: (file: File) => void
  readonly onStartRecordedMelody?: (() => void) | undefined
  readonly onStopRecordedMelody?: (() => void) | undefined
  readonly onRecordMelodyAgain?: (() => void) | undefined
  readonly useRecordedSourceAsReference?: boolean | undefined
  readonly onUseRecordedSourceAsReferenceChange?: ((checked: boolean) => void) | undefined
  readonly onTranspositionChange: (semitones: number) => void
  readonly onAlignmentChange: (seconds: number) => void
  readonly onNoteChange: (note: EditableTargetNote) => void
  readonly onAddNote: () => void
  readonly onAddKeyboardNote?: ((input: KeyboardNoteInput) => void) | undefined
  readonly onRemoveNote: (id: string) => void
  readonly onSave: () => void
  readonly onAnalysisDebugExpectedNoteCountChange?: ((count: number | null) => void) | undefined
  readonly onAnalysisDebugIssueDescriptionChange?: ((description: string) => void) | undefined
  readonly onAnalysisDebugRouteCategoryChange?:
    ((route: AnalysisDebugRouteCategory) => void) | undefined
  readonly onSendAnalysisDebug?: (() => void) | undefined
  readonly onSaveAnalysisDebugPackage?: (() => void) | undefined
}

function SelectedFile({ label, name }: { readonly label: string; readonly name: string | null }) {
  return (
    <p>
      <strong>{label}:</strong> {name ?? 'None selected'}
    </p>
  )
}

export function ProjectSetupScreen({
  model,
  onBack,
  onTitleChange,
  onReferenceFile,
  onTargetModeChange,
  onMidiFile,
  onMidiTrackChange,
  onIsolatedVocalFile,
  onStartRecordedMelody,
  onStopRecordedMelody,
  onRecordMelodyAgain,
  useRecordedSourceAsReference,
  onUseRecordedSourceAsReferenceChange,
  onTranspositionChange,
  onAlignmentChange,
  onNoteChange,
  onAddNote,
  onAddKeyboardNote,
  onRemoveNote,
  onSave,
  onAnalysisDebugExpectedNoteCountChange,
  onAnalysisDebugIssueDescriptionChange,
  onAnalysisDebugRouteCategoryChange,
  onSendAnalysisDebug,
  onSaveAnalysisDebugPackage,
}: ProjectSetupScreenProps) {
  const recordedMelodyAvailable =
    model.recordedMelody !== undefined &&
    onStartRecordedMelody !== undefined &&
    onStopRecordedMelody !== undefined &&
    onRecordMelodyAgain !== undefined
  const analysisDebugPanel =
    model.analysisDebug &&
    onAnalysisDebugExpectedNoteCountChange &&
    onAnalysisDebugIssueDescriptionChange &&
    onAnalysisDebugRouteCategoryChange &&
    onSendAnalysisDebug &&
    onSaveAnalysisDebugPackage ? (
      <AnalysisDebugPanel
        model={model.analysisDebug}
        onExpectedNoteCountChange={onAnalysisDebugExpectedNoteCountChange}
        onIssueDescriptionChange={onAnalysisDebugIssueDescriptionChange}
        onRouteCategoryChange={onAnalysisDebugRouteCategoryChange}
        onSend={onSendAnalysisDebug}
        onSavePackage={onSaveAnalysisDebugPackage}
      />
    ) : null

  return (
    <main className="ss-screen">
      <header className="ss-screen__header">
        <div>
          <p className="ss-eyebrow">Project setup</p>
          <h1>Reference and target</h1>
        </div>
        <button className="ss-button" type="button" onClick={onBack}>
          Back
        </button>
      </header>

      <div className="ss-stack">
        <section className="ss-card ss-stack" aria-labelledby="project-details-heading">
          <h2 id="project-details-heading">1. Project</h2>
          <label className="ss-field">
            <span>Project title</span>
            <input
              type="text"
              maxLength={120}
              value={model.title}
              onChange={(event) => onTitleChange(event.currentTarget.value)}
            />
          </label>
          <label className="ss-field">
            <span>
              Backing audio
              {model.targetMode === 'manual' ? ' (optional for Manual)' : ''} · 64 MiB / 20 minutes
              maximum
            </span>
            <input
              className="ss-file-input"
              type="file"
              accept="audio/*,.m4a,.mp3,.wav,.aac,.mp4"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file) onReferenceFile(file)
                event.currentTarget.value = ''
              }}
            />
          </label>
          <SelectedFile
            label="Practice reference"
            name={
              model.referenceName ??
              (model.targetMode === 'manual' ? 'Entered melody · synthesized locally' : null)
            }
          />
          {model.targetMode === 'manual' && model.referenceName === null ? (
            <p className="ss-help">
              No upload is needed. SingScope will use the notes you enter below as a simple local
              instrument guide during practice. The guide supports the same 80–1,200 Hz range as
              live pitch detection.
            </p>
          ) : null}
        </section>

        <section className="ss-card ss-stack" aria-labelledby="target-heading">
          <div>
            <h2 id="target-heading">2. Target melody</h2>
            <p>Choose MIDI, enter notes manually, or upload or record monophonic audio.</p>
          </div>
          <div className="ss-segmented" role="group" aria-label="Target source">
            {(['midi', 'manual', 'isolated-vocal'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={model.targetMode === mode}
                onClick={() => onTargetModeChange(mode)}
              >
                {mode === 'isolated-vocal' ? 'Audio / record' : mode === 'midi' ? 'MIDI' : 'Manual'}
              </button>
            ))}
          </div>

          {model.targetMode === 'midi' ? (
            <div className="ss-stack">
              <label className="ss-field">
                <span>MIDI format 0 or 1 (5 MiB maximum)</span>
                <input
                  className="ss-file-input"
                  type="file"
                  accept=".mid,.midi,audio/midi,audio/x-midi"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    if (file) onMidiFile(file)
                    event.currentTarget.value = ''
                  }}
                />
              </label>
              {(model.midiTracks?.length ?? 0) > 1 && onMidiTrackChange ? (
                <label className="ss-field">
                  <span>Melody track</span>
                  <select
                    value={model.selectedMidiTrackId ?? ''}
                    onChange={(event) => onMidiTrackChange(event.currentTarget.value)}
                  >
                    <option value="" disabled>
                      Select a melody track
                    </option>
                    {model.midiTracks?.map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.name} · {track.noteCount} notes
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          {model.targetMode === 'isolated-vocal' ? (
            <div className="ss-stack">
              <StatusBanner
                tone="info"
                title="Local-only, single-note audio"
                message="Upload or record an isolated voice or instrument, one note at a time. SingScope does not isolate mixed songs or analyze chords."
              />
              <label className="ss-field">
                <span>Upload monophonic audio (32 MiB / 8 minutes maximum)</span>
                <input
                  className="ss-file-input"
                  type="file"
                  accept="audio/*,.m4a,.mp3,.wav,.aac,.mp4"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    if (file) onIsolatedVocalFile(file)
                    event.currentTarget.value = ''
                  }}
                />
              </label>
              {recordedMelodyAvailable ? (
                <RecordedMelodyControl
                  model={model.recordedMelody}
                  onStart={onStartRecordedMelody}
                  onStop={onStopRecordedMelody}
                  onRecordAgain={onRecordMelodyAgain}
                  useAsReference={useRecordedSourceAsReference}
                  onUseAsReferenceChange={onUseRecordedSourceAsReferenceChange}
                />
              ) : null}
            </div>
          ) : null}
          <p role="status">{model.targetStatus}</p>
          {model.targetMode === 'isolated-vocal' && model.analysisScene ? (
            <section className="ss-card ss-stack" aria-labelledby="analysis-check-heading">
              <div>
                <h3 id="analysis-check-heading">Check what SingScope heard</h3>
                <p>
                  The dashed line is the accepted source pitch contour—not a waveform or a
                  guaranteed transcription. Red points are raw detector candidates; hollow points
                  were not accepted. The blue blocks are editable, quantized piano-note estimates at
                  the source's recorded pitch. Project transpose is previewed in the piano roll
                  below. Listen and compare before saving.
                </p>
              </div>
              {model.analysisSourceUrl ? (
                // This is user-created, non-speech melody audio; there is no spoken content to caption.
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <audio
                  aria-label="Play the exact analyzed source"
                  controls
                  preload="metadata"
                  src={model.analysisSourceUrl}
                />
              ) : null}
              <PitchChartCanvas
                scene={model.analysisScene}
                label="Accepted and raw analyzed-source pitch overlaid with editable piano-note estimates. Hatched gaps indicate frames without an accepted pitch."
                height={260}
              />
              <p className="ss-help">
                This project stores accepted pitch, raw candidates, levels, and analysis gaps.
                Hatched spans can still contain a rejected raw candidate. The editable note list
                below is authoritative for scoring.
              </p>
              {analysisDebugPanel}
            </section>
          ) : null}
          {model.targetMode === 'isolated-vocal' && !model.analysisScene
            ? analysisDebugPanel
            : null}
          <div className="ss-field-grid">
            <label className="ss-field">
              <span>Transpose (semitones)</span>
              <input
                type="number"
                min={-48}
                max={48}
                value={model.transpositionSemitones}
                onChange={(event) => onTranspositionChange(event.currentTarget.valueAsNumber)}
              />
            </label>
            <label className="ss-field">
              <span>Alignment (seconds)</span>
              <input
                type="number"
                inputMode="decimal"
                step={0.01}
                value={model.alignmentSeconds}
                onChange={(event) => onAlignmentChange(event.currentTarget.valueAsNumber)}
              />
            </label>
          </div>
          <TargetNoteEditor
            notes={model.notes}
            transpositionSemitones={model.transpositionSemitones}
            durationSeconds={model.analysisScene?.viewport.endSeconds}
            onChange={onNoteChange}
            onAdd={onAddNote}
            onAddKeyboardNote={model.targetMode === 'manual' ? onAddKeyboardNote : undefined}
            onRemove={onRemoveNote}
          />
        </section>

        {model.validationMessage ? (
          <StatusBanner tone="danger" title="Fix before saving" message={model.validationMessage} />
        ) : null}
        <button
          className="ss-button ss-button--primary"
          type="button"
          disabled={!model.canSave}
          onClick={onSave}
        >
          Save project
        </button>
      </div>
    </main>
  )
}
