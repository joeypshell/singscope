import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ExactTimeInput } from './ExactTimeInput'
import { calculateRollViewport } from './touch-piano-roll-viewport'
import { TransportControls } from './TransportControls'
import { parseExactTime } from './time-format'

describe('mobile controls', () => {
  it('parses exact seconds and minute notation', () => {
    expect(parseExactTime('7.25')).toBe(7.25)
    expect(parseExactTime('1:02.5')).toBe(62.5)
    expect(parseExactTime('1:99')).toBeNull()
  })

  it('commits accessible exact time entry', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ExactTimeInput label="Loop start" valueSeconds={2} onChange={onChange} />)
    const input = screen.getByLabelText('Loop start')
    await user.clear(input)
    await user.type(input, '1:02.5')
    await user.tab()
    expect(onChange).toHaveBeenCalledWith(62.5)
  })

  it('turns retry state into a direct tap action', async () => {
    const onStart = vi.fn()
    render(
      <TransportControls
        phase="retry"
        currentSeconds={0}
        durationSeconds={10}
        onStart={onStart}
        onPause={vi.fn()}
        onStop={vi.fn()}
        onSeek={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Tap to retry' }))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('locks transport and seeking while a take is finalizing', () => {
    render(
      <TransportControls
        phase="finalizing"
        currentSeconds={4}
        durationSeconds={10}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onStop={vi.fn()}
        onSeek={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Finishing…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
    expect(screen.getByLabelText('Timeline position')).toBeDisabled()
  })

  it('fits the piano roll to the actual low or high notes without large-array spreads', () => {
    const low = calculateRollViewport(
      [{ id: 'low', startSeconds: 0, endSeconds: 2, midiNote: 33 }],
      0,
      undefined,
    )
    const high = calculateRollViewport(
      [{ id: 'high', startSeconds: 0, endSeconds: 3, midiNote: 100 }],
      0,
      undefined,
    )
    const many = calculateRollViewport(
      Array.from({ length: 100_000 }, (_, index) => ({
        id: `note-${index}`,
        startSeconds: index / 100,
        endSeconds: index / 100 + 0.1,
        midiNote: 45 + (index % 12),
      })),
      0,
      undefined,
    )

    expect(low.maxMidi).toBeLessThan(60)
    expect(high.minMidi).toBeGreaterThan(72)
    expect(many.durationSeconds).toBeCloseTo(1_000.09)
  })
})
