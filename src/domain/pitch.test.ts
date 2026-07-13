import { describe, expect, it } from 'vitest'

import { isUtcDate, isUuid } from './guards'
import {
  centsBetweenFrequencies,
  centsBetweenMidi,
  frequencyToMidi,
  midiNoteName,
  midiToFrequency,
} from './pitch'

describe('pitch conversions', () => {
  it('converts frequency, MIDI, cents, and note names without fake invalid values', () => {
    expect(frequencyToMidi(440)).toBe(69)
    expect(midiToFrequency(69)).toBe(440)
    expect(midiToFrequency(60)).toBeCloseTo(261.6256, 3)
    expect(centsBetweenFrequencies(880, 440)).toBeCloseTo(1200, 8)
    expect(centsBetweenMidi(69.25, 69)).toBe(25)
    expect(midiNoteName(60)).toBe('C4')
    expect(frequencyToMidi(0)).toBeNull()
    expect(midiToFrequency(Number.NaN)).toBeNull()
    expect(centsBetweenFrequencies(-1, 440)).toBeNull()
  })
})

describe('identifier and UTC guards', () => {
  it('accepts canonical UUIDs and UTC metadata dates', () => {
    expect(isUuid('018f5e22-cc7a-7c7c-8c2c-4cf891e44599')).toBe(true)
    expect(isUuid('not-an-id')).toBe(false)
    expect(isUtcDate('2026-07-13T17:30:00.000Z')).toBe(true)
    expect(isUtcDate('2026-07-13T12:30:00-05:00')).toBe(false)
  })
})
