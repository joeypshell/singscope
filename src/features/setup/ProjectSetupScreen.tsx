import { StatusBanner } from '../../components/StatusBanner'
import { TargetNoteEditor, type EditableTargetNote } from '../../components/TargetNoteEditor'

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
  readonly onTranspositionChange: (semitones: number) => void
  readonly onAlignmentChange: (seconds: number) => void
  readonly onNoteChange: (note: EditableTargetNote) => void
  readonly onAddNote: () => void
  readonly onRemoveNote: (id: string) => void
  readonly onSave: () => void
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
  onTranspositionChange,
  onAlignmentChange,
  onNoteChange,
  onAddNote,
  onRemoveNote,
  onSave,
}: ProjectSetupScreenProps) {
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
            <span>Backing audio (64 MiB / 20 minutes maximum)</span>
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
          <SelectedFile label="Reference" name={model.referenceName} />
        </section>

        <section className="ss-card ss-stack" aria-labelledby="target-heading">
          <div>
            <h2 id="target-heading">2. Target melody</h2>
            <p>Choose MIDI, touch/manual entry, or an already isolated monophonic vocal.</p>
          </div>
          <div className="ss-segmented" aria-label="Target source">
            {(['midi', 'manual', 'isolated-vocal'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={model.targetMode === mode}
                onClick={() => onTargetModeChange(mode)}
              >
                {mode === 'isolated-vocal' ? 'Isolated vocal' : mode === 'midi' ? 'MIDI' : 'Manual'}
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
                title="Monophonic, isolated sources only"
                message="SingScope does not isolate vocals from a mixed song or claim to extract its melody."
              />
              <label className="ss-field">
                <span>Isolated vocal (32 MiB / 8 minutes maximum)</span>
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
            </div>
          ) : null}
          <p role="status">{model.targetStatus}</p>
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
            onChange={onNoteChange}
            onAdd={onAddNote}
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
