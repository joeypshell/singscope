import { midiNoteName } from '../domain/pitch'
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
  readonly transpositionSemitones?: number | undefined
  readonly onChange: (note: EditableTargetNote) => void
  readonly onAdd: () => void
  readonly onRemove: (id: string) => void
}

function pianoNoteName(midiNote: number, transpositionSemitones: number): string {
  if (!Number.isInteger(midiNote) || !Number.isInteger(transpositionSemitones)) return '—'
  return midiNoteName(midiNote + transpositionSemitones) ?? '—'
}

export function TargetNoteEditor({
  notes,
  transpositionSemitones = 0,
  onChange,
  onAdd,
  onRemove,
}: TargetNoteEditorProps) {
  const pianoNotes = notes.map((note) => pianoNoteName(note.midiNote, transpositionSemitones))

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
      {pianoNotes.length > 0 ? (
        <p aria-label="Piano note sequence">
          <strong>Piano notes after transpose:</strong> {pianoNotes.join(' · ')}
        </p>
      ) : null}
      <TouchPianoRoll notes={notes} onChange={onChange} />
      <ol className="ss-note-list">
        {notes.map((note, index) => (
          <li key={note.id}>
            <strong>Note {index + 1}</strong>
            <p>
              <strong>Piano note after transpose:</strong>{' '}
              <output aria-label={`Piano note ${index + 1}`}>{pianoNotes[index]}</output>
            </p>
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
