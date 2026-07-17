import { useEffect, useRef, useState } from 'react'

import { MelodyPreviewPlayer, type MelodyPreviewNote } from '../audio/runtime/melody-preview'
import { midiNoteName } from '../domain/pitch'

const MIN_OCTAVE = 1
const MAX_OCTAVE = 7

const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11] as const
const BLACK_KEYS = [
  { pitchClass: 1, left: `${(1 / 7) * 100}%` },
  { pitchClass: 3, left: `${(2 / 7) * 100}%` },
  { pitchClass: 6, left: `${(4 / 7) * 100}%` },
  { pitchClass: 8, left: `${(5 / 7) * 100}%` },
  { pitchClass: 10, left: `${(6 / 7) * 100}%` },
] as const

const NOTE_LENGTHS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const
const NOTE_GAPS = [0, 0.05, 0.1, 0.25, 0.5] as const

export interface KeyboardNoteInput {
  readonly displayedMidiNote: number
  readonly durationSeconds: number
  readonly gapSeconds: number
}

export interface MelodyKeyboardProps {
  readonly notes: readonly MelodyPreviewNote[]
  readonly transpositionSemitones: number
  readonly onAddNote: (input: KeyboardNoteInput) => void
  readonly onUndoLastNote: () => void
}

function octaveForMidiNote(midiNote: number | null | undefined): number {
  if (midiNote === null || midiNote === undefined || !Number.isFinite(midiNote)) return 4
  return Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, Math.floor(midiNote / 12) - 1))
}

function midiFor(octave: number, pitchClass: number): number {
  return (octave + 1) * 12 + pitchClass
}

function spokenNoteName(noteName: string): string {
  return noteName.replace('♯', ' sharp ')
}

function formatSeconds(value: number): string {
  return `${value.toString()} s`
}

export function MelodyKeyboard({
  notes,
  transpositionSemitones,
  onAddNote,
  onUndoLastNote,
}: MelodyKeyboardProps) {
  const lastDisplayedMidiNote = notes.at(-1)?.displayedMidiNote
  const [octave, setOctave] = useState(() => octaveForMidiNote(lastDisplayedMidiNote))
  const [durationSeconds, setDurationSeconds] = useState(1)
  const [gapSeconds, setGapSeconds] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const [audioError, setAudioError] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const previewPlayer = useRef<MelodyPreviewPlayer | null>(null)

  const getPreviewPlayer = () => {
    previewPlayer.current ??= new MelodyPreviewPlayer()
    return previewPlayer.current
  }

  const stopPlayback = (announcementText?: string) => {
    previewPlayer.current?.stopAll()
    setIsPlaying(false)
    if (announcementText) setAnnouncement(announcementText)
  }

  const handleAudioFailure = () => {
    setIsPlaying(false)
    setAudioError('Sound preview could not start. Check the device volume, then tap again.')
  }

  useEffect(() => {
    const stopForBackground = () => {
      if (document.visibilityState !== 'visible') {
        previewPlayer.current?.stopAll()
        setIsPlaying(false)
      }
    }
    const stopForPageHide = () => {
      previewPlayer.current?.stopAll()
      setIsPlaying(false)
    }
    document.addEventListener('visibilitychange', stopForBackground)
    window.addEventListener('pagehide', stopForPageHide)
    return () => {
      document.removeEventListener('visibilitychange', stopForBackground)
      window.removeEventListener('pagehide', stopForPageHide)
      const player = previewPlayer.current
      previewPlayer.current = null
      if (player) void player.close().catch(() => undefined)
    }
  }, [])

  const addPitch = (displayedMidiNote: number) => {
    const noteName = midiNoteName(displayedMidiNote)
    if (noteName === null) return
    onAddNote({ displayedMidiNote, durationSeconds, gapSeconds })
    setIsPlaying(false)
    setAudioError(null)
    try {
      void getPreviewPlayer().audition(displayedMidiNote).catch(handleAudioFailure)
    } catch {
      handleAudioFailure()
    }
    setAnnouncement(`Added ${spokenNoteName(noteName)}.`)
  }

  const toggleMelodyPlayback = () => {
    if (isPlaying) {
      stopPlayback('Stopped melody preview.')
      return
    }
    setAudioError(null)
    try {
      const result = getPreviewPlayer().play(notes, () => {
        setIsPlaying(false)
        setAnnouncement('Melody preview finished.')
      })
      setIsPlaying(true)
      setAnnouncement(
        result.truncated
          ? `Playing the first ${result.noteCount.toString()} notes of the melody preview.`
          : 'Playing melody preview.',
      )
      void result.activation.catch(handleAudioFailure)
    } catch {
      handleAudioFailure()
    }
  }

  const pianoKey = (pitchClass: number, kind: 'white' | 'black', left?: string) => {
    const displayedMidiNote = midiFor(octave, pitchClass)
    const storedMidiNote = displayedMidiNote - transpositionSemitones
    const noteName = midiNoteName(displayedMidiNote) ?? 'Unknown note'
    const unavailable =
      !Number.isInteger(storedMidiNote) || storedMidiNote < 0 || storedMidiNote > 127
    return (
      <button
        key={pitchClass}
        className={`ss-piano-key ss-piano-key--${kind}`}
        type="button"
        style={left ? { left } : undefined}
        disabled={unavailable}
        aria-label={`${unavailable ? 'Unavailable' : 'Add'} ${spokenNoteName(noteName)}`}
        onClick={() => addPitch(displayedMidiNote)}
      >
        {noteName}
      </button>
    )
  }

  return (
    <section className="ss-melody-keyboard ss-stack" aria-labelledby="melody-keyboard-heading">
      <div>
        <h4 id="melody-keyboard-heading">Enter melody with piano</h4>
        <p id="melody-keyboard-help">
          Tap one key per note and you will hear its final pitch after transpose. Each new note is
          placed after the current sequence; adjust exact pitch and timing below, then play the
          melody so far.
        </p>
      </div>

      <div className="ss-keyboard-settings">
        <div className="ss-field">
          <span>Keyboard octave</span>
          <div className="ss-octave-control">
            <button
              className="ss-button"
              type="button"
              aria-label="Lower keyboard octave"
              disabled={octave <= MIN_OCTAVE}
              onClick={() => setOctave((value) => Math.max(MIN_OCTAVE, value - 1))}
            >
              −
            </button>
            <output aria-live="polite">Octave {octave}</output>
            <button
              className="ss-button"
              type="button"
              aria-label="Raise keyboard octave"
              disabled={octave >= MAX_OCTAVE}
              onClick={() => setOctave((value) => Math.min(MAX_OCTAVE, value + 1))}
            >
              +
            </button>
          </div>
        </div>
        <label className="ss-field">
          <span>Note length</span>
          <select
            value={durationSeconds}
            onChange={(event) => setDurationSeconds(Number(event.currentTarget.value))}
          >
            {NOTE_LENGTHS.map((value) => (
              <option key={value} value={value}>
                {formatSeconds(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="ss-field">
          <span>Gap before each new note</span>
          <select
            value={gapSeconds}
            onChange={(event) => setGapSeconds(Number(event.currentTarget.value))}
          >
            {NOTE_GAPS.map((value) => (
              <option key={value} value={value}>
                {formatSeconds(value)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="ss-keyboard-scroll">
        <div
          className="ss-keyboard-keys"
          role="group"
          aria-label={`Piano keys, octave ${octave}`}
          aria-describedby="melody-keyboard-help"
        >
          {WHITE_PITCH_CLASSES.map((pitchClass) => pianoKey(pitchClass, 'white'))}
          {BLACK_KEYS.map(({ pitchClass, left }) => pianoKey(pitchClass, 'black', left))}
        </div>
      </div>

      <div className="ss-keyboard-summary">
        <output aria-live="polite">
          {notes.length.toString()} {notes.length === 1 ? 'note' : 'notes'} entered.
        </output>
        <div className="ss-keyboard-actions">
          <button
            className="ss-button ss-button--primary"
            type="button"
            disabled={notes.length === 0}
            aria-pressed={isPlaying}
            onClick={toggleMelodyPlayback}
          >
            <span aria-hidden="true">{isPlaying ? '■' : '▶'}</span>{' '}
            {isPlaying ? 'Stop playback' : 'Play melody so far'}
          </button>
          <button
            className="ss-button"
            type="button"
            disabled={notes.length === 0}
            onClick={() => {
              stopPlayback()
              onUndoLastNote()
              setAnnouncement('Removed the last note.')
            }}
          >
            Undo last note
          </button>
        </div>
      </div>
      {audioError ? (
        <p className="ss-keyboard-audio-error" role="alert">
          {audioError} Your entered notes are unchanged.
        </p>
      ) : null}
      <p className="ss-visually-hidden" role="status">
        {announcement}
      </p>
    </section>
  )
}
