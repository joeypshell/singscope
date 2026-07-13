import { load } from 'midi-json-parser-broker'
import type { IMidiFile } from 'midi-json-parser-worker'
import midiWorkerUrl from '../workers/midi.worker.ts?worker&url'

export const MIDI_LIMITS = {
  bytes: 5 * 1024 * 1024,
  tracks: 64,
  events: 100_000,
} as const

export interface MidiTempoPoint {
  readonly tick: number
  readonly seconds: number
  readonly microsecondsPerQuarter: number
}

export interface MidiTargetNote {
  readonly id: string
  readonly trackIndex: number
  readonly channel: number
  readonly midiNote: number
  readonly velocity: number
  readonly startSeconds: number
  readonly endSeconds: number
  readonly label: string | null
  readonly overlapsAnotherNote: boolean
}

export interface MidiTrackSummary {
  readonly index: number
  readonly name: string
  readonly noteCount: number
  readonly channelCount: number
  readonly durationSeconds: number
}

export interface ParsedMidi {
  readonly format: 0 | 1
  readonly ppqn: number
  readonly tempos: readonly MidiTempoPoint[]
  readonly tracks: readonly MidiTrackSummary[]
  readonly notesByTrack: ReadonlyMap<number, readonly MidiTargetNote[]>
}

type MidiEventRecord = Readonly<Record<string, unknown>> & { readonly delta: number }

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function asEvent(value: unknown): MidiEventRecord {
  if (!isRecord(value) || !Number.isSafeInteger(value['delta']) || Number(value['delta']) < 0) {
    throw new Error('MIDI contains an invalid delta time.')
  }
  return value as MidiEventRecord
}

function nestedNumber(event: MidiEventRecord, key: string, member: string): number | null {
  const value = event[key]
  if (!isRecord(value)) return null
  const nested = value[member]
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : null
}

function eventText(event: MidiEventRecord, key: string): string | null {
  const value = event[key]
  return typeof value === 'string' ? value.slice(0, 256) : null
}

interface TimedEvent {
  readonly tick: number
  readonly event: MidiEventRecord
}

function timeTrack(track: readonly unknown[]): TimedEvent[] {
  let tick = 0
  return track.map((raw) => {
    const event = asEvent(raw)
    tick += event.delta
    if (!Number.isSafeInteger(tick)) throw new Error('MIDI timeline is too large.')
    return { tick, event }
  })
}

function buildTempoMap(tracks: readonly (readonly unknown[])[], ppqn: number): MidiTempoPoint[] {
  const changes = tracks
    .flatMap(timeTrack)
    .flatMap(({ tick, event }) => {
      const tempo = nestedNumber(event, 'setTempo', 'microsecondsPerQuarter')
      return tempo === null ? [] : [{ tick, tempo }]
    })
    .filter(({ tempo }) => tempo >= 1 && tempo <= 60_000_000)
    .sort((a, b) => a.tick - b.tick)

  const deduplicated = new Map<number, number>([[0, 500_000]])
  for (const change of changes) deduplicated.set(change.tick, change.tempo)

  let previousTick = 0
  let previousSeconds = 0
  let previousTempo = 500_000
  const points: MidiTempoPoint[] = []
  for (const [tick, tempo] of [...deduplicated].sort((a, b) => a[0] - b[0])) {
    previousSeconds += ((tick - previousTick) * previousTempo) / ppqn / 1_000_000
    points.push({ tick, seconds: previousSeconds, microsecondsPerQuarter: tempo })
    previousTick = tick
    previousTempo = tempo
  }
  return points
}

export function midiTickToSeconds(
  tick: number,
  ppqn: number,
  tempos: readonly MidiTempoPoint[],
): number {
  if (!Number.isFinite(tick) || tick < 0 || !Number.isInteger(ppqn) || ppqn < 1) {
    throw new Error('Invalid MIDI time conversion.')
  }
  let point = tempos[0]
  if (!point) throw new Error('Tempo map is empty.')
  for (const candidate of tempos) {
    if (candidate.tick > tick) break
    point = candidate
  }
  return point.seconds + ((tick - point.tick) * point.microsecondsPerQuarter) / ppqn / 1_000_000
}

function withOverlapFlags(
  notes: readonly Omit<MidiTargetNote, 'overlapsAnotherNote'>[],
): MidiTargetNote[] {
  const flags = new Set<string>()
  const ordered = [...notes].sort(
    (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds,
  )
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]
    if (!current) continue
    for (let otherIndex = index + 1; otherIndex < ordered.length; otherIndex += 1) {
      const other = ordered[otherIndex]
      if (!other || other.startSeconds >= current.endSeconds) break
      if (other.endSeconds > current.startSeconds) {
        flags.add(current.id)
        flags.add(other.id)
      }
    }
  }
  return ordered.map((note) => ({ ...note, overlapsAnotherNote: flags.has(note.id) }))
}

export function parseMidiStructure(file: IMidiFile): ParsedMidi {
  if (file.format !== 0 && file.format !== 1) {
    throw new Error(
      file.format === 2
        ? 'MIDI format 2 is not supported.'
        : 'Only MIDI formats 0 and 1 are supported.',
    )
  }
  if ((file.division & 0x8000) !== 0) throw new Error('SMPTE MIDI timing is not supported.')
  if (!Number.isInteger(file.division) || file.division < 1)
    throw new Error('MIDI PPQN division is invalid.')
  if (file.tracks.length > MIDI_LIMITS.tracks)
    throw new Error(`MIDI has more than ${MIDI_LIMITS.tracks} tracks.`)
  const eventCount = file.tracks.reduce((sum, track) => sum + track.length, 0)
  if (eventCount > MIDI_LIMITS.events)
    throw new Error(`MIDI has more than ${MIDI_LIMITS.events.toLocaleString()} events.`)

  const tempos = buildTempoMap(file.tracks, file.division)
  const notesByTrack = new Map<number, readonly MidiTargetNote[]>()
  const summaries: MidiTrackSummary[] = []

  file.tracks.forEach((track, trackIndex) => {
    const timed = timeTrack(track)
    const open = new Map<
      string,
      { tick: number; velocity: number; label: string | null; serial: number }[]
    >()
    const notes: Omit<MidiTargetNote, 'overlapsAnotherNote'>[] = []
    const channels = new Set<number>()
    let serial = 0
    let latestLabel: string | null = null
    let trackName = `Track ${trackIndex + 1}`

    for (const { tick, event } of timed) {
      trackName = eventText(event, 'trackName') ?? trackName
      latestLabel = eventText(event, 'lyric') ?? eventText(event, 'marker') ?? latestLabel
      const eventChannel = event['channel']
      const channel =
        typeof eventChannel === 'number' && Number.isInteger(eventChannel) ? eventChannel : 0
      const noteOn = nestedNumber(event, 'noteOn', 'noteNumber')
      const onVelocity = nestedNumber(event, 'noteOn', 'velocity') ?? 0
      const noteOff = nestedNumber(event, 'noteOff', 'noteNumber')
      const isOff = noteOff !== null || (noteOn !== null && onVelocity === 0)
      const noteNumber = noteOff ?? noteOn
      if (
        noteNumber === null ||
        !Number.isInteger(noteNumber) ||
        noteNumber < 0 ||
        noteNumber > 127
      )
        continue
      channels.add(channel)
      const key = `${channel}:${noteNumber}`

      if (!isOff) {
        serial += 1
        const stack = open.get(key) ?? []
        stack.push({
          tick,
          velocity: Math.max(0, Math.min(127, onVelocity)),
          label: latestLabel,
          serial,
        })
        open.set(key, stack)
        latestLabel = null
        continue
      }

      const stack = open.get(key)
      const start = stack?.shift()
      if (!start || tick <= start.tick) continue
      const startSeconds = midiTickToSeconds(start.tick, file.division, tempos)
      const endSeconds = midiTickToSeconds(tick, file.division, tempos)
      notes.push({
        id: `midi-${trackIndex}-${start.serial}`,
        trackIndex,
        channel,
        midiNote: noteNumber,
        velocity: start.velocity,
        startSeconds,
        endSeconds,
        label: start.label,
      })
    }

    const finalized = withOverlapFlags(notes)
    notesByTrack.set(trackIndex, finalized)
    summaries.push({
      index: trackIndex,
      name: trackName,
      noteCount: finalized.length,
      channelCount: channels.size,
      durationSeconds: finalized.reduce((maximum, note) => Math.max(maximum, note.endSeconds), 0),
    })
  })

  return { format: file.format, ppqn: file.division, tempos, tracks: summaries, notesByTrack }
}

export function transformMidiNotes(
  notes: readonly MidiTargetNote[],
  transposition: number,
  alignmentSeconds: number,
): readonly MidiTargetNote[] {
  if (!Number.isInteger(transposition) || transposition < -48 || transposition > 48) {
    throw new Error('Transposition must be a whole number between -48 and 48 semitones.')
  }
  if (!Number.isFinite(alignmentSeconds) || Math.abs(alignmentSeconds) > 3600) {
    throw new Error('MIDI alignment is outside the supported range.')
  }
  return notes.map((note) => {
    const midiNote = note.midiNote + transposition
    if (midiNote < 0 || midiNote > 127)
      throw new Error('Transposition moves a note outside the MIDI range.')
    return {
      ...note,
      midiNote,
      startSeconds: Math.max(0, note.startSeconds + alignmentSeconds),
      endSeconds: Math.max(0, note.endSeconds + alignmentSeconds),
    }
  })
}

export async function parseMidiFile(file: File): Promise<ParsedMidi> {
  if (file.size > MIDI_LIMITS.bytes) throw new Error('MIDI files are limited to 5 MiB on iPhone.')
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (new TextDecoder('ascii').decode(header) !== 'MThd')
    throw new Error('This file is not a Standard MIDI File.')
  const parser = load(midiWorkerUrl)
  try {
    return parseMidiStructure(await parser.parseArrayBuffer(await file.arrayBuffer()))
  } finally {
    const terminate = parser['terminate']
    if (typeof terminate === 'function') await terminate()
  }
}
