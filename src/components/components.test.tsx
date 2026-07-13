import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ExactTimeInput } from './ExactTimeInput'
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
})
