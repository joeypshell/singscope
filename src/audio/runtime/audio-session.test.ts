import { describe, expect, it } from 'vitest'

import { beginBrowserAudioCapture, prepareBrowserAudioPlayback } from './audio-session'

function fakeNavigator(session: { type: string }): Navigator {
  return { audioSession: session } as unknown as Navigator
}

describe('browser audio-session routing', () => {
  it('uses playback for ordinary media and ignores unsupported browsers', () => {
    const session = { type: 'auto' }
    expect(prepareBrowserAudioPlayback(fakeNavigator(session))).toBe(true)
    expect(session.type).toBe('playback')
    expect(prepareBrowserAudioPlayback({} as Navigator)).toBe(false)
  })

  it('keeps play-and-record until the last overlapping capture releases', () => {
    const session = { type: 'auto' }
    const navigatorValue = fakeNavigator(session)
    const first = beginBrowserAudioCapture(navigatorValue)
    const second = beginBrowserAudioCapture(navigatorValue)
    expect(session.type).toBe('play-and-record')

    prepareBrowserAudioPlayback(navigatorValue)
    expect(session.type).toBe('play-and-record')
    first.release()
    expect(session.type).toBe('play-and-record')
    second.release()
    expect(session.type).toBe('playback')
  })

  it('reasserts the capture route after getUserMedia changes it', () => {
    const session = { type: 'auto' }
    const capture = beginBrowserAudioCapture(fakeNavigator(session))
    session.type = 'auto'
    capture.reassert()
    expect(session.type).toBe('play-and-record')
    capture.release()
  })

  it('repairs a late cancelled permission result without disrupting a newer capture', () => {
    const session = { type: 'auto' }
    const navigatorValue = fakeNavigator(session)
    const cancelled = beginBrowserAudioCapture(navigatorValue)
    cancelled.release()
    const current = beginBrowserAudioCapture(navigatorValue)

    // Safari resolves the cancelled getUserMedia request late and changes its
    // native session before the caller immediately stops that stale stream.
    session.type = 'auto'
    prepareBrowserAudioPlayback(navigatorValue)
    expect(session.type).toBe('play-and-record')

    current.release()
    expect(session.type).toBe('playback')
  })

  it('contains a throwing experimental setter', () => {
    const navigatorValue = {
      audioSession: Object.defineProperty({}, 'type', {
        configurable: true,
        set: () => {
          throw new DOMException('unsupported', 'NotSupportedError')
        },
      }),
    } as unknown as Navigator
    expect(prepareBrowserAudioPlayback(navigatorValue)).toBe(false)
    expect(() => beginBrowserAudioCapture(navigatorValue).release()).not.toThrow()
  })
})
