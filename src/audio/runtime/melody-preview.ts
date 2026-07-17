const TAP_PREVIEW_SECONDS = 0.45
const START_LEAD_SECONDS = 0.025
const MIN_AUDIBLE_SECONDS = 0.08
const MAX_PREVIEW_SECONDS = 120
const MAX_PREVIEW_NOTES = 256

export interface MelodyPreviewNote {
  readonly displayedMidiNote: number
  readonly startSeconds: number
  readonly endSeconds: number
}

export interface MelodyPreviewResult {
  readonly activation: Promise<void>
  readonly noteCount: number
  readonly durationSeconds: number
  readonly truncated: boolean
}

interface ScheduledNote extends MelodyPreviewNote {
  readonly offsetSeconds: number
  readonly durationSeconds: number
}

interface ScheduledVoice {
  readonly oscillator: OscillatorNode
  readonly gain: GainNode
}

function isValidPreviewNote(note: MelodyPreviewNote): boolean {
  return (
    Number.isInteger(note.displayedMidiNote) &&
    note.displayedMidiNote >= 0 &&
    note.displayedMidiNote <= 127 &&
    Number.isFinite(note.startSeconds) &&
    Number.isFinite(note.endSeconds) &&
    note.startSeconds >= 0 &&
    note.endSeconds > note.startSeconds
  )
}

function frequencyForMidiNote(midiNote: number): number {
  return 440 * 2 ** ((midiNote - 69) / 12)
}

function defaultAudioContext(): AudioContext {
  return new AudioContext({ latencyHint: 'interactive' })
}

/**
 * Setup-only note auditioning. All audible timing is anchored to AudioContext.currentTime.
 * The context is created lazily so opening Manual mode never triggers an audio permission or
 * activation prompt.
 */
export class MelodyPreviewPlayer {
  private context: AudioContext | null = null
  private masterGain: GainNode | null = null
  private readonly tapNodes = new Set<ScheduledVoice>()
  private readonly sequenceNodes = new Set<ScheduledVoice>()
  private sequenceGeneration = 0

  constructor(private readonly createAudioContext: () => AudioContext = defaultAudioContext) {}

  audition(displayedMidiNote: number): Promise<void> {
    if (!Number.isInteger(displayedMidiNote) || displayedMidiNote < 0 || displayedMidiNote > 127) {
      return Promise.reject(new RangeError('Preview pitch must be a MIDI note from 0 to 127.'))
    }

    this.stopSequence()
    this.stopNodes(this.tapNodes)
    const context = this.ensureContext()
    // resume() is intentionally invoked synchronously from the key's click handler for Safari.
    const activation = this.activate(context)
    const startTime = context.currentTime + START_LEAD_SECONDS
    this.scheduleVoice(context, displayedMidiNote, startTime, TAP_PREVIEW_SECONDS, this.tapNodes)
    return activation.catch((error: unknown) => {
      this.stopNodes(this.tapNodes)
      throw error
    })
  }

  play(notes: readonly MelodyPreviewNote[], onEnded: () => void): MelodyPreviewResult {
    this.stopAll()
    const validNotes = notes.filter(isValidPreviewNote).sort((left, right) => {
      if (left.startSeconds !== right.startSeconds) return left.startSeconds - right.startSeconds
      return left.endSeconds - right.endSeconds
    })
    if (validNotes.length === 0) throw new Error('Add at least one valid note before previewing.')

    const originSeconds = validNotes[0]?.startSeconds ?? 0
    const scheduled: ScheduledNote[] = []
    for (const note of validNotes) {
      if (scheduled.length >= MAX_PREVIEW_NOTES) break
      const offsetSeconds = Math.max(0, note.startSeconds - originSeconds)
      if (offsetSeconds >= MAX_PREVIEW_SECONDS) break
      const durationSeconds = Math.min(
        note.endSeconds - note.startSeconds,
        MAX_PREVIEW_SECONDS - offsetSeconds,
      )
      if (durationSeconds <= 0) continue
      scheduled.push({ ...note, offsetSeconds, durationSeconds })
    }
    if (scheduled.length === 0) throw new Error('No notes fit inside the melody preview window.')

    const context = this.ensureContext()
    // resume() is intentionally invoked synchronously from the Play button's click handler.
    const activation = this.activate(context)
    const generation = ++this.sequenceGeneration
    const baseContextTime = context.currentTime + START_LEAD_SECONDS
    let completionIndex = 0
    let completionSeconds = -Infinity
    for (const [index, note] of scheduled.entries()) {
      const endingSeconds = note.offsetSeconds + note.durationSeconds
      if (endingSeconds >= completionSeconds) {
        completionSeconds = endingSeconds
        completionIndex = index
      }
    }

    for (const [index, note] of scheduled.entries()) {
      this.scheduleVoice(
        context,
        note.displayedMidiNote,
        baseContextTime + note.offsetSeconds,
        Math.max(MIN_AUDIBLE_SECONDS, note.durationSeconds),
        this.sequenceNodes,
        index === completionIndex
          ? () => {
              if (generation !== this.sequenceGeneration) return
              onEnded()
            }
          : undefined,
      )
    }

    const truncated =
      scheduled.length < validNotes.length ||
      validNotes.some((note) => note.endSeconds - originSeconds > MAX_PREVIEW_SECONDS)
    return {
      activation: activation.catch((error: unknown) => {
        if (generation === this.sequenceGeneration) this.stopSequence()
        throw error
      }),
      noteCount: scheduled.length,
      durationSeconds: Math.max(0, completionSeconds),
      truncated,
    }
  }

  stopAll(): void {
    this.stopSequence()
    this.stopNodes(this.tapNodes)
  }

  stopSequence(): void {
    this.sequenceGeneration += 1
    this.stopNodes(this.sequenceNodes)
  }

  async close(): Promise<void> {
    this.stopAll()
    const context = this.context
    this.context = null
    try {
      this.masterGain?.disconnect()
    } catch {
      // A browser may already have disconnected the graph while closing the page.
    }
    this.masterGain = null
    if (context && context.state !== 'closed') await context.close()
  }

  private ensureContext(): AudioContext {
    if (this.context?.state === 'closed') {
      this.context = null
      this.masterGain = null
    }
    if (this.context) return this.context
    const context = this.createAudioContext()
    const masterGain = context.createGain()
    masterGain.gain.value = 0.72
    masterGain.connect(context.destination)
    this.context = context
    this.masterGain = masterGain
    return context
  }

  private activate(context: AudioContext): Promise<void> {
    return context.state === 'running' ? Promise.resolve() : context.resume()
  }

  private scheduleVoice(
    context: AudioContext,
    midiNote: number,
    startTime: number,
    durationSeconds: number,
    nodes: Set<ScheduledVoice>,
    onEnded?: () => void,
  ): void {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const duration = Math.max(MIN_AUDIBLE_SECONDS, durationSeconds)
    const endTime = startTime + duration
    const attackEnd = startTime + Math.min(0.018, duration / 4)
    const releaseStart = Math.max(attackEnd, endTime - Math.min(0.09, duration / 3))
    oscillator.type = 'triangle'
    oscillator.frequency.value = frequencyForMidiNote(midiNote)
    gain.gain.setValueAtTime(0, startTime)
    gain.gain.linearRampToValueAtTime(0.16, attackEnd)
    gain.gain.linearRampToValueAtTime(0.065, releaseStart)
    gain.gain.linearRampToValueAtTime(0, endTime)
    oscillator.connect(gain).connect(this.masterGain ?? context.destination)
    const voice = { oscillator, gain }
    nodes.add(voice)
    oscillator.onended = () => {
      nodes.delete(voice)
      try {
        oscillator.disconnect()
        gain.disconnect()
      } catch {
        // Safari can release a short-lived node before its onended callback runs.
      }
      onEnded?.()
    }
    oscillator.start(startTime)
    oscillator.stop(endTime + 0.02)
  }

  private stopNodes(nodes: Set<ScheduledVoice>): void {
    const stopTime = this.context?.currentTime ?? 0
    for (const { oscillator, gain } of nodes) {
      oscillator.onended = null
      try {
        oscillator.stop(stopTime)
      } catch {
        // stop() throws when a browser has already ended this oscillator.
      }
      try {
        oscillator.disconnect()
      } catch {
        // A stopped browser-owned node may already be disconnected.
      }
      try {
        gain.disconnect()
      } catch {
        // The gain may also have been released with its oscillator.
      }
    }
    nodes.clear()
  }
}
