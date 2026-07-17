import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { MelodyPreviewPlayer, type MelodyPreviewNote } from '../audio/runtime/melody-preview'
import { MelodyKeyboard, type MelodyKeyboardProps } from './MelodyKeyboard'

const previewNote = (
  displayedMidiNote: number,
  startSeconds = 0,
  endSeconds = 1,
): MelodyPreviewNote => ({ displayedMidiNote, startSeconds, endSeconds })

let auditionSpy: MockInstance<MelodyPreviewPlayer['audition']>
let playSpy: MockInstance<MelodyPreviewPlayer['play']>
let stopAllSpy: MockInstance<MelodyPreviewPlayer['stopAll']>
let closeSpy: MockInstance<MelodyPreviewPlayer['close']>

beforeEach(() => {
  auditionSpy = vi.spyOn(MelodyPreviewPlayer.prototype, 'audition').mockResolvedValue()
  playSpy = vi.spyOn(MelodyPreviewPlayer.prototype, 'play').mockReturnValue({
    activation: Promise.resolve(),
    noteCount: 1,
    durationSeconds: 1,
    truncated: false,
  })
  stopAllSpy = vi.spyOn(MelodyPreviewPlayer.prototype, 'stopAll')
  closeSpy = vi.spyOn(MelodyPreviewPlayer.prototype, 'close')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderKeyboard(overrides: Partial<MelodyKeyboardProps> = {}) {
  const onAddNote = vi.fn<MelodyKeyboardProps['onAddNote']>()
  const onUndoLastNote = vi.fn<MelodyKeyboardProps['onUndoLastNote']>()
  const props: MelodyKeyboardProps = {
    notes: [],
    transpositionSemitones: 0,
    onAddNote,
    onUndoLastNote,
    ...overrides,
  }

  return {
    ...render(<MelodyKeyboard {...props} />),
    onAddNote,
    onUndoLastNote,
    props,
  }
}

describe('MelodyKeyboard', () => {
  it('adds natural and sharp keys with the default timing choices', async () => {
    const user = userEvent.setup()
    const { onAddNote } = renderKeyboard()

    await user.click(screen.getByRole('button', { name: 'Add C4' }))
    await user.click(screen.getByRole('button', { name: 'Add C sharp 4' }))

    expect(onAddNote).toHaveBeenNthCalledWith(1, {
      displayedMidiNote: 60,
      durationSeconds: 1,
      gapSeconds: 0,
    })
    expect(onAddNote).toHaveBeenNthCalledWith(2, {
      displayedMidiNote: 61,
      durationSeconds: 1,
      gapSeconds: 0,
    })
    expect(auditionSpy).toHaveBeenNthCalledWith(1, 60)
    expect(auditionSpy).toHaveBeenNthCalledWith(2, 61)
    expect(screen.getByText('Added C sharp 4.')).toHaveAttribute('role', 'status')
  })

  it('includes the selected note length and gap with the next key entry', async () => {
    const user = userEvent.setup()
    const { onAddNote } = renderKeyboard()

    await user.selectOptions(screen.getByLabelText('Note length'), '0.5')
    await user.selectOptions(screen.getByLabelText('Gap before each new note'), '0.25')
    await user.click(screen.getByRole('button', { name: 'Add G4' }))

    expect(onAddNote).toHaveBeenCalledWith({
      displayedMidiNote: 67,
      durationSeconds: 0.5,
      gapSeconds: 0.25,
    })
  })

  it('starts near the last entered pitch and changes octaves with accessible controls', async () => {
    const user = userEvent.setup()
    const { onAddNote } = renderKeyboard({ notes: [previewNote(45)] })

    expect(screen.getByRole('group', { name: 'Piano keys, octave 2' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add A2' }))
    await user.click(screen.getByRole('button', { name: 'Raise keyboard octave' }))
    expect(screen.getByRole('group', { name: 'Piano keys, octave 3' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add A3' }))
    await user.click(screen.getByRole('button', { name: 'Lower keyboard octave' }))

    expect(screen.getByRole('group', { name: 'Piano keys, octave 2' })).toBeInTheDocument()
    expect(onAddNote.mock.calls.map(([input]) => input.displayedMidiNote)).toEqual([45, 57])
  })

  it('disables undo without notes and removes only through an explicit enabled action', async () => {
    const user = userEvent.setup()
    const { onUndoLastNote, props, rerender } = renderKeyboard()
    const undo = screen.getByRole('button', { name: 'Undo last note' })

    expect(undo).toBeDisabled()
    expect(screen.getByText('0 notes entered.')).toBeInTheDocument()

    rerender(<MelodyKeyboard {...props} notes={[previewNote(60, 0, 1), previewNote(62, 1, 2)]} />)
    expect(undo).toBeEnabled()
    expect(screen.getByText('2 notes entered.')).toBeInTheDocument()
    await user.click(undo)

    expect(onUndoLastNote).toHaveBeenCalledOnce()
    expect(screen.getByText('Removed the last note.')).toHaveAttribute('role', 'status')
  })

  it('forwards every rapid repeated tap without merging pitches', () => {
    const { onAddNote } = renderKeyboard()
    const key = screen.getByRole('button', { name: 'Add A4' })

    for (let index = 0; index < 7; index += 1) fireEvent.click(key)

    expect(onAddNote).toHaveBeenCalledTimes(7)
    expect(auditionSpy).toHaveBeenCalledTimes(7)
    expect(auditionSpy.mock.calls).toEqual(Array.from({ length: 7 }, () => [69]))
    expect(onAddNote.mock.calls.map(([input]) => input)).toEqual(
      Array.from({ length: 7 }, () => ({
        displayedMidiNote: 69,
        durationSeconds: 1,
        gapSeconds: 0,
      })),
    )
  })

  it('exposes a labelled key group and disables pitches outside the stored MIDI range', () => {
    renderKeyboard({
      notes: [previewNote(24)],
      transpositionSemitones: 48,
    })

    const region = screen.getByRole('region', { name: 'Enter melody with piano' })
    const keys = within(region).getByRole('group', { name: 'Piano keys, octave 1' })
    expect(keys).toHaveAttribute('aria-describedby', 'melody-keyboard-help')
    expect(within(keys).getAllByRole('button')).toHaveLength(12)
    expect(within(keys).getByRole('button', { name: 'Unavailable C1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Lower keyboard octave' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Raise keyboard octave' })).toBeEnabled()
  })

  it('disables playback until at least one note has been entered', () => {
    renderKeyboard()

    expect(screen.getByRole('button', { name: 'Play melody so far' })).toBeDisabled()
    expect(playSpy).not.toHaveBeenCalled()
  })

  it('plays the entered sequence and toggles the same control to stop playback', async () => {
    const user = userEvent.setup()
    const notes = [previewNote(60, 0, 0.5), previewNote(64, 0.75, 1.25)]
    playSpy.mockReturnValueOnce({
      activation: Promise.resolve(),
      noteCount: notes.length,
      durationSeconds: 1.25,
      truncated: false,
    })
    renderKeyboard({ notes })

    const play = screen.getByRole('button', { name: 'Play melody so far' })
    expect(play).toHaveAttribute('aria-pressed', 'false')
    await user.click(play)

    expect(playSpy).toHaveBeenCalledWith(notes, expect.any(Function))
    const stop = screen.getByRole('button', { name: 'Stop playback' })
    expect(stop).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Playing melody preview.')).toHaveAttribute('role', 'status')

    await user.click(stop)

    expect(stopAllSpy).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Play melody so far' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByText('Stopped melody preview.')).toHaveAttribute('role', 'status')
  })

  it('keeps the entered note and exposes an alert when audible preview fails', async () => {
    const user = userEvent.setup()
    auditionSpy.mockRejectedValueOnce(new DOMException('Playback blocked.', 'NotAllowedError'))
    const { onAddNote } = renderKeyboard()

    await user.click(screen.getByRole('button', { name: 'Add A4' }))

    expect(onAddNote).toHaveBeenCalledWith({
      displayedMidiNote: 69,
      durationSeconds: 1,
      gapSeconds: 0,
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sound preview could not start. Check the device volume, then tap again. Your entered notes are unchanged.',
    )
  })

  it('closes a lazily created preview player when the keyboard unmounts', async () => {
    const user = userEvent.setup()
    const { unmount } = renderKeyboard()
    await user.click(screen.getByRole('button', { name: 'Add C4' }))

    unmount()

    expect(closeSpy).toHaveBeenCalledOnce()
  })
})
