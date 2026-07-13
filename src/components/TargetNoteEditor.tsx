import { ExactTimeInput } from './ExactTimeInput'
import { TouchPianoRoll } from './TouchPianoRoll'

export interface EditableTargetNote {
  readonly id: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly midiNote: number
  readonly lyric?: string
}

export interface TargetNoteEditorProps {
  readonly notes: readonly EditableTargetNote[]
  readonly onChange: (note: EditableTargetNote) => void
  readonly onAdd: () => void
  readonly onRemove: (id: string) => void
}

export function TargetNoteEditor({ notes, onChange, onAdd, onRemove }: TargetNoteEditorProps) {
  return (
    <section aria-labelledby="target-note-heading">
      <div className="ss-section-heading">
        <div>
          <h3 id="target-note-heading">Target notes</h3>
          <p>The list is authoritative; dragging is optional.</p>
        </div>
        <button className="ss-button" type="button" onClick={onAdd}>
          Add note
        </button>
      </div>
      <TouchPianoRoll notes={notes} onChange={onChange} />
      <ol className="ss-note-list">
        {notes.map((note, index) => (
          <li key={note.id}>
            <strong>Note {index + 1}</strong>
            <div className="ss-field-grid">
              <ExactTimeInput
                label="Start"
                valueSeconds={note.startSeconds}
                onChange={(startSeconds) => onChange({ ...note, startSeconds })}
              />
              <ExactTimeInput
                label="End"
                valueSeconds={note.endSeconds}
                onChange={(endSeconds) => onChange({ ...note, endSeconds })}
              />
              <label className="ss-field">
                <span>MIDI note</span>
                <input
                  type="number"
                  min={0}
                  max={127}
                  value={note.midiNote}
                  onChange={(event) =>
                    onChange({ ...note, midiNote: event.currentTarget.valueAsNumber })
                  }
                />
              </label>
              <label className="ss-field">
                <span>Lyric (optional)</span>
                <input
                  type="text"
                  maxLength={120}
                  value={note.lyric ?? ''}
                  onChange={(event) => onChange({ ...note, lyric: event.currentTarget.value })}
                />
              </label>
            </div>
            <button
              className="ss-button ss-button--danger"
              type="button"
              onClick={() => onRemove(note.id)}
            >
              Remove note {index + 1}
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
