import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MelodyKeyboard, type MelodyKeyboardProps } from './MelodyKeyboard'

function renderKeyboard(overrides: Partial<MelodyKeyboardProps> = {}) {
  const onAddNote = vi.fn<MelodyKeyboardProps['onAddNote']>()
  const onUndoLastNote = vi.fn<MelodyKeyboardProps['onUndoLastNote']>()
  const props: MelodyKeyboardProps = {
    noteCount: 0,
    lastDisplayedMidiNote: null,
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
    const { onAddNote } = renderKeyboard({ lastDisplayedMidiNote: 45 })

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

    rerender(<MelodyKeyboard {...props} noteCount={2} />)
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
      lastDisplayedMidiNote: 24,
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
})
