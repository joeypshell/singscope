export type BrowserAudioSessionType = 'auto' | 'playback' | 'play-and-record'

interface BrowserAudioSession {
  type: string
}

type NavigatorWithAudioSession = Navigator & {
  readonly audioSession?: BrowserAudioSession
}

export interface AudioCaptureSession {
  /** Re-apply the capture route after getUserMedia changes Safari's native session. */
  reassert(): void
  /** Release this capture owner and restore ordinary media playback when it is the last one. */
  release(): void
}

const captureOwners = new WeakMap<BrowserAudioSession, Set<symbol>>()

function browserNavigator(): Navigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator
}

function audioSessionFor(navigatorValue: Navigator | undefined): BrowserAudioSession | undefined {
  if (!navigatorValue) return undefined
  try {
    return (navigatorValue as NavigatorWithAudioSession).audioSession
  } catch {
    return undefined
  }
}

function applyType(
  session: BrowserAudioSession | undefined,
  type: BrowserAudioSessionType,
): boolean {
  if (!session) return false
  try {
    session.type = type
    return true
  } catch {
    // Experimental Safari builds can expose audioSession while rejecting a type.
    return false
  }
}

/**
 * WebKit can leave the native route in its lower-fidelity capture state after
 * the microphone stops. Applying playback before returning control to auto
 * gives Safari an explicit route transition while keeping either assignment
 * failure contained for experimental implementations.
 */
function resetAfterCapture(session: BrowserAudioSession | undefined): void {
  applyType(session, 'playback')
  applyType(session, 'auto')
}

/**
 * Selects Safari's media-playback route. If microphone capture is still active,
 * keep the shared session in play-and-record so a preview cannot disrupt it.
 */
export function prepareBrowserAudioPlayback(
  navigatorValue: Navigator | undefined = browserNavigator(),
): boolean {
  const session = audioSessionFor(navigatorValue)
  const type =
    session && (captureOwners.get(session)?.size ?? 0) > 0 ? 'play-and-record' : 'playback'
  return applyType(session, type)
}

/**
 * Acquires an iPhone capture route synchronously from the initiating user gesture.
 * Multiple in-flight captures are reference counted to avoid stale permission
 * promises switching a newer recording back to playback.
 */
export function beginBrowserAudioCapture(
  navigatorValue: Navigator | undefined = browserNavigator(),
): AudioCaptureSession {
  const session = audioSessionFor(navigatorValue)
  const token = Symbol('singscope-audio-capture')
  let released = false

  if (session) {
    const owners = captureOwners.get(session) ?? new Set<symbol>()
    owners.add(token)
    captureOwners.set(session, owners)
    applyType(session, 'play-and-record')
  }

  return {
    reassert() {
      if (!released) applyType(session, 'play-and-record')
    },
    release() {
      if (released) return
      released = true
      if (!session) return
      const owners = captureOwners.get(session)
      owners?.delete(token)
      if (owners?.size === 0) captureOwners.delete(session)
      if ((owners?.size ?? 0) > 0) applyType(session, 'play-and-record')
      else resetAfterCapture(session)
    },
  }
}
