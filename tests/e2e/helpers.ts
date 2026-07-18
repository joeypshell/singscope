/// <reference types="node" />

import { expect, type Page } from '@playwright/test'

const ONBOARDING_KEY = 'singscope:onboarding:v1'

/**
 * The browser still uses its real workers, IndexedDB/OPFS fallback, and Canvas.
 * MediaRecorder and host-codec metadata are deterministic so CI does not need
 * audio hardware. AudioContext is shimmed only on WebKit ports that omit it.
 */
export async function installDeterministicBrowserAdapters(page: Page): Promise<void> {
  await page.addInitScript(
    ({ onboardingKey }) => {
      localStorage.setItem(onboardingKey, 'complete')

      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: undefined,
      })
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: undefined,
      })

      const deterministicMelodySamples = (): Float32Array => {
        const sampleRate = 48_000
        const midiNotes = [57, 69, 68, 64, 66, 68, 69]
        const leadInSeconds = 0.45
        const onsetSpacingSeconds = 0.56
        const pitchedSeconds = 0.34
        const durationSeconds = leadInSeconds + midiNotes.length * onsetSpacingSeconds + 0.4
        let noiseState = 0x43a6_284d
        const noise = () => {
          noiseState = (Math.imul(noiseState, 1_664_525) + 1_013_904_223) >>> 0
          return (noiseState / 0xffff_ffff) * 2 - 1
        }
        const samples = Float32Array.from(
          { length: Math.round(durationSeconds * sampleRate) },
          () => noise() * 0.0015,
        )

        for (const [noteIndex, midiNote] of midiNotes.entries()) {
          const frequencyHz = 440 * 2 ** ((midiNote - 69) / 12)
          const onsetSample = Math.round(
            (leadInSeconds + noteIndex * onsetSpacingSeconds) * sampleRate,
          )
          const pitchedSamples = Math.round(pitchedSeconds * sampleRate)
          for (let index = 0; index < pitchedSamples; index += 1) {
            const time = index / sampleRate
            const attack = Math.min(1, time / 0.009)
            const decay = Math.exp(-3.2 * time)
            const phase = 2 * Math.PI * frequencyHz * time
            const piano =
              0.5 * Math.sin(phase) +
              0.22 * Math.sin(2.002 * phase + 0.13) +
              0.12 * Math.sin(3.008 * phase + 0.31) +
              0.06 * Math.sin(4.018 * phase + 0.47)
            samples[onsetSample + index] =
              (samples[onsetSample + index] ?? 0) + 0.24 * attack * decay * piano
          }

          const tailStart = onsetSample + pitchedSamples
          const tailSamples = Math.round((onsetSpacingSeconds - pitchedSeconds) * sampleRate)
          for (let index = 0; index < tailSamples; index += 1) {
            const decay = Math.exp((-2 * index) / tailSamples)
            samples[tailStart + index] = (samples[tailStart + index] ?? 0) + noise() * 0.05 * decay
          }
        }
        return samples
      }

      const deterministicMelodyWav = (): ArrayBuffer => {
        const samples = deterministicMelodySamples()
        const buffer = new ArrayBuffer(44 + samples.length * 2)
        const view = new DataView(buffer)
        const ascii = (offset: number, value: string) => {
          for (let index = 0; index < value.length; index += 1) {
            view.setUint8(offset + index, value.charCodeAt(index))
          }
        }
        ascii(0, 'RIFF')
        view.setUint32(4, buffer.byteLength - 8, true)
        ascii(8, 'WAVE')
        ascii(12, 'fmt ')
        view.setUint32(16, 16, true)
        view.setUint16(20, 1, true)
        view.setUint16(22, 1, true)
        view.setUint32(24, 48_000, true)
        view.setUint32(28, 96_000, true)
        view.setUint16(32, 2, true)
        view.setUint16(34, 16, true)
        ascii(36, 'data')
        view.setUint32(40, samples.length * 2, true)
        for (let index = 0; index < samples.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
          view.setInt16(44 + index * 2, Math.round(sample * 0x7fff), true)
        }
        return buffer
      }

      class DeterministicAudioTrack extends EventTarget {
        readonly id = 'singscope-e2e-microphone'
        readonly kind = 'audio'
        readonly label = 'Deterministic microphone'
        enabled = true
        muted = false
        readyState: MediaStreamTrackState = 'live'

        getSettings(): MediaTrackSettings {
          return {
            deviceId: this.id,
            sampleRate: 48_000,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          }
        }

        stop(): void {
          this.readyState = 'ended'
        }
      }

      class DeterministicMediaDevices extends EventTarget {
        getUserMedia(): Promise<MediaStream> {
          const track = new DeterministicAudioTrack()
          return Promise.resolve({
            getAudioTracks: () => [track],
            getTracks: () => [track],
          } as unknown as MediaStream)
        }

        enumerateDevices(): Promise<MediaDeviceInfo[]> {
          return Promise.resolve([
            {
              deviceId: 'singscope-e2e-microphone',
              groupId: 'singscope-e2e-group',
              kind: 'audioinput',
              label: 'Deterministic microphone',
              toJSON: () => ({}),
            },
          ])
        }
      }

      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: new DeterministicMediaDevices(),
      })

      class DeterministicMediaRecorder extends EventTarget {
        static isTypeSupported(mimeType: string): boolean {
          return mimeType.startsWith('audio/webm')
        }

        readonly mimeType: string
        state: RecordingState = 'inactive'

        constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
          super()
          this.mimeType = options?.mimeType ?? 'audio/webm'
        }

        start(): void {
          if (this.state !== 'inactive') {
            throw new DOMException('Recorder is already active.', 'InvalidStateError')
          }
          this.state = 'recording'
        }

        stop(): void {
          if (this.state === 'inactive') return
          this.state = 'inactive'
          const encoded = new Blob([deterministicMelodyWav()], {
            type: this.mimeType,
          })
          this.dispatchEvent(new MessageEvent('dataavailable', { data: encoded }))
          this.dispatchEvent(new Event('stop'))
        }

        pause(): void {
          if (this.state === 'recording') this.state = 'paused'
        }

        resume(): void {
          if (this.state === 'paused') this.state = 'recording'
        }

        requestData(): void {
          if (this.state !== 'recording') return
          this.dispatchEvent(
            new MessageEvent('dataavailable', {
              data: new Blob([new Uint8Array([0])], { type: this.mimeType }),
            }),
          )
        }
      }

      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: DeterministicMediaRecorder,
      })

      if (!Reflect.has(window, 'AudioContext')) {
        class DeterministicAudioContext extends EventTarget {
          readonly destination = {}
          readonly sampleRate = 48_000
          readonly audioWorklet = { addModule: () => Promise.resolve() }
          state: AudioContextState = 'suspended'
          private runningStartedAt = 0
          private accumulatedSeconds = 0

          get currentTime(): number {
            return (
              this.accumulatedSeconds +
              (this.state === 'running' ? (performance.now() - this.runningStartedAt) / 1000 : 0)
            )
          }

          resume(): Promise<void> {
            if (this.state !== 'running') {
              this.runningStartedAt = performance.now()
              this.state = 'running'
              this.dispatchEvent(new Event('statechange'))
            }
            return Promise.resolve()
          }

          close(): Promise<void> {
            if (this.state === 'running') {
              this.accumulatedSeconds = this.currentTime
            }
            this.state = 'closed'
            this.dispatchEvent(new Event('statechange'))
            return Promise.resolve()
          }

          createMediaElementSource(): MediaElementAudioSourceNode {
            return {
              connect: <T>(destination: T) => destination,
              disconnect: () => undefined,
            } as MediaElementAudioSourceNode
          }

          createMediaStreamSource(): MediaStreamAudioSourceNode {
            return {
              connect: <T>(destination: T) => destination,
              disconnect: () => undefined,
            } as MediaStreamAudioSourceNode
          }

          createGain(): GainNode {
            return {
              connect: <T>(destination: T) => destination,
              disconnect: () => undefined,
              gain: {
                cancelScheduledValues: () => undefined,
                linearRampToValueAtTime: () => undefined,
                setValueAtTime: () => undefined,
                value: 1,
              },
            } as unknown as GainNode
          }

          createMediaStreamDestination(): MediaStreamAudioDestinationNode {
            const stream = {
              getAudioTracks: () => [],
              getTracks: () => [],
            } as unknown as MediaStream
            return {
              connect: <T>(destination: T) => destination,
              stream,
            } as MediaStreamAudioDestinationNode
          }

          createOscillator(): OscillatorNode {
            return {
              connect: <T>(destination: T) => destination,
              frequency: { value: 440 },
              start: () => undefined,
              stop: () => undefined,
            } as OscillatorNode
          }

          decodeAudioData(): Promise<AudioBuffer> {
            const samples = deterministicMelodySamples()
            return Promise.resolve({
              duration: samples.length / 48_000,
              length: samples.length,
              numberOfChannels: 1,
              sampleRate: 48_000,
              getChannelData: () => samples,
            } as unknown as AudioBuffer)
          }
        }

        Object.defineProperty(window, 'AudioContext', {
          configurable: true,
          value: DeterministicAudioContext,
        })
      }

      if (!Reflect.has(window, 'AudioWorkletNode')) {
        class DeterministicMessagePort extends EventTarget {
          start(): void {
            // The deterministic pipeline does not emit PCM batches.
          }

          postMessage(): void {
            // Buffer recycling is inert without deterministic PCM batches.
          }
        }

        class DeterministicAudioWorkletNode extends EventTarget {
          readonly port = new DeterministicMessagePort()

          connect<T>(destination: T): T {
            return destination
          }

          disconnect(): void {
            // No native graph is allocated by the deterministic adapter.
          }
        }

        Object.defineProperty(window, 'AudioWorkletNode', {
          configurable: true,
          value: DeterministicAudioWorkletNode,
        })
      }

      const AudioContextConstructor = window.AudioContext
      try {
        Object.defineProperty(AudioContextConstructor.prototype, 'decodeAudioData', {
          configurable: true,
          value: () => {
            const samples = deterministicMelodySamples()
            return Promise.resolve({
              duration: samples.length / 48_000,
              length: samples.length,
              numberOfChannels: 1,
              sampleRate: 48_000,
              getChannelData: () => samples,
            } as unknown as AudioBuffer)
          },
        })
      } catch {
        // A host codec can decode the deterministic WAV if its prototype is locked.
      }

      // The Windows WebKit build has no system audio codecs. The returned value
      // remains a real HTMLAudioElement, while local playback/metadata events are
      // deterministic and stay inside the browser process.
      const NativeAudio = window.Audio
      const AudioWithFixtureMetadata = new Proxy(NativeAudio, {
        construct(Target, argumentsList) {
          const element = Reflect.construct(Target, [])
          let mediaTime = 0
          let playingStartedAt = 0
          let paused = true
          let source = typeof argumentsList[0] === 'string' ? argumentsList[0] : ''
          const readCurrentTime = () =>
            mediaTime + (paused ? 0 : (performance.now() - playingStartedAt) / 1000)
          Object.defineProperties(element, {
            currentTime: {
              configurable: true,
              get: readCurrentTime,
              set: (value: number) => {
                mediaTime = value
                if (!paused) playingStartedAt = performance.now()
                element.dispatchEvent(new Event('seeked'))
              },
            },
            duration: { configurable: true, get: () => 8 },
            paused: { configurable: true, get: () => paused },
            src: {
              configurable: true,
              get: () => source,
              set: (value: string) => {
                source = value
                window.setTimeout(() => element.dispatchEvent(new Event('loadedmetadata')), 0)
              },
            },
          })
          element.play = () => {
            if (paused) playingStartedAt = performance.now()
            paused = false
            element.dispatchEvent(new Event('playing'))
            return Promise.resolve()
          }
          element.pause = () => {
            if (!paused) mediaTime = readCurrentTime()
            paused = true
          }
          if (source.length > 0) {
            window.setTimeout(() => element.dispatchEvent(new Event('loadedmetadata')), 0)
          }
          return element
        },
      })
      Object.defineProperty(window, 'Audio', {
        configurable: true,
        value: AudioWithFixtureMetadata,
      })
    },
    { onboardingKey: ONBOARDING_KEY },
  )
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'SingScope' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open synthetic demo' })).toBeVisible()
}

export async function openSyntheticDemo(page: Page): Promise<void> {
  await openApp(page)
  await page.getByRole('button', { name: 'Open synthetic demo' }).click()
  await expect(page).toHaveURL(/#\/practice\//)
  await expect(page.getByRole('heading', { name: 'Synthetic warm-up' })).toBeVisible()
  await expect(
    page.getByRole('img', { name: /Live target and detected pitch chart/ }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled({ timeout: 10_000 })

  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
}

export async function recordSyntheticTake(page: Page): Promise<void> {
  await openSyntheticDemo(page)

  const start = page.getByRole('button', { name: 'Start' })
  await expect(start).toBeVisible()
  // Give the bundled reference's metadata event time to settle before the
  // user-activation-sensitive Start click.
  await page.waitForTimeout(250)
  await start.click()

  await expect(
    page.getByRole('region', { name: 'Practice transport' }).getByText('● Recording'),
  ).toBeVisible({ timeout: 8_000 })
  // Dispatch immediately: under a loaded CI host the eight-second synthetic
  // reference can otherwise finish while Playwright waits for visual stability.
  await page
    .getByRole('region', { name: 'Practice transport' })
    .getByRole('button', { name: 'Stop' })
    .evaluate((button: HTMLButtonElement) => button.click())

  await expect(page).toHaveURL(/#\/review\//, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: 'Transparent metrics' })).toBeVisible()
  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
}

export function twoTrackMidiFixture(): Buffer {
  const ascii = (value: string) => [...Buffer.from(value, 'ascii')]
  const u32 = (value: number) => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]
  const track = (events: readonly number[]) => [...ascii('MTrk'), ...u32(events.length), ...events]
  const trackName = (name: string) => [0x00, 0xff, 0x03, name.length, ...ascii(name)]
  const end = [0x00, 0xff, 0x2f, 0x00]

  const conductor = [...trackName('Conductor'), 0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, ...end]
  const melody = [
    ...trackName('Melody'),
    0x00,
    0x90,
    60,
    100,
    0x83,
    0x60,
    0x80,
    60,
    0,
    0x00,
    0x90,
    62,
    100,
    0x83,
    0x60,
    0x80,
    62,
    0,
    ...end,
  ]
  const alternate = [
    ...trackName('Alternate'),
    0x00,
    0x90,
    67,
    100,
    0x87,
    0x40,
    0x80,
    67,
    0,
    ...end,
  ]
  const header = [...ascii('MThd'), 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x03, 0x01, 0xe0]

  return Buffer.from([...header, ...track(conductor), ...track(melody), ...track(alternate)])
}
