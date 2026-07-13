import { describe, expect, it } from 'vitest'
import type { IMidiFile } from 'midi-json-parser-worker'
import { midiTickToSeconds, parseMidiStructure, transformMidiNotes } from './midi'

function fixture(): IMidiFile {
  return {
    division: 480,
    format: 1,
    tracks: [
      [
        { delta: 0, setTempo: { microsecondsPerQuarter: 500_000 } },
        { delta: 480, setTempo: { microsecondsPerQuarter: 1_000_000 } },
      ],
      [
        { delta: 0, trackName: 'Lead' },
        { delta: 0, lyric: 'la' },
        { channel: 0, delta: 0, noteOn: { noteNumber: 60, velocity: 100 } },
        { channel: 0, delta: 480, noteOff: { noteNumber: 60, velocity: 0 } },
        { channel: 0, delta: 0, noteOn: { noteNumber: 62, velocity: 100 } },
        { channel: 0, delta: 480, noteOn: { noteNumber: 62, velocity: 0 } },
      ],
    ],
  }
}

describe('MIDI conversion', () => {
  it('builds a PPQN tempo map and extracts notes', () => {
    const parsed = parseMidiStructure(fixture())
    expect(midiTickToSeconds(960, parsed.ppqn, parsed.tempos)).toBe(1.5)
    expect(parsed.tracks[1]).toMatchObject({ name: 'Lead', noteCount: 2, durationSeconds: 1.5 })
    expect(parsed.notesByTrack.get(1)?.[0]).toMatchObject({
      midiNote: 60,
      label: 'la',
      startSeconds: 0,
      endSeconds: 0.5,
    })
  })

  it('flags overlapping melody notes as unscorable', () => {
    const source = fixture()
    source.tracks[1] = [
      { channel: 0, delta: 0, noteOn: { noteNumber: 60, velocity: 100 } },
      { channel: 0, delta: 120, noteOn: { noteNumber: 64, velocity: 100 } },
      { channel: 0, delta: 120, noteOff: { noteNumber: 64, velocity: 0 } },
      { channel: 0, delta: 240, noteOff: { noteNumber: 60, velocity: 0 } },
    ]
    expect(
      parseMidiStructure(source)
        .notesByTrack.get(1)
        ?.every((note) => note.overlapsAnotherNote),
    ).toBe(true)
  })

  it('applies non-destructive transposition and alignment', () => {
    const note = parseMidiStructure(fixture()).notesByTrack.get(1)?.[0]
    expect(note).toBeDefined()
    if (!note) throw new Error('MIDI fixture did not produce a note.')
    expect(transformMidiNotes([note], 2, 0.25)[0]).toMatchObject({
      midiNote: 62,
      startSeconds: 0.25,
      endSeconds: 0.75,
    })
    expect(note.midiNote).toBe(60)
  })

  it('rejects SMPTE and format 2 files', () => {
    expect(() => parseMidiStructure({ division: 0xe728, format: 1, tracks: [] })).toThrow(/SMPTE/)
    expect(() => parseMidiStructure({ division: 480, format: 2, tracks: [] })).toThrow(/format 2/)
  })
})
