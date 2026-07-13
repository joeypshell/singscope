import type { AudioInputOption, CaptureSettings } from './types'

export type CaptureProfile = 'raw' | 'echo-reduced'

export interface MicrophoneRequest {
  readonly deviceId?: string
  readonly profile: CaptureProfile
}

export interface MicrophoneAccessResult {
  readonly stream: MediaStream
  readonly settings: CaptureSettings
  readonly inputs: readonly AudioInputOption[]
  readonly showInputSelector: boolean
}

function nullableNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableBoolean(value: boolean | string | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function createMicrophoneConstraints(request: MicrophoneRequest): MediaStreamConstraints {
  const raw = request.profile === 'raw'
  const audio: MediaTrackConstraints = {
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: !raw },
    noiseSuppression: { ideal: !raw },
    autoGainControl: { ideal: !raw },
  }
  if (request.deviceId) audio.deviceId = { exact: request.deviceId }
  return { audio, video: false }
}

export async function enumerateLabeledAudioInputs(
  mediaDevices: MediaDevices = navigator.mediaDevices,
): Promise<readonly AudioInputOption[]> {
  const devices = await mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput' && device.label.trim().length > 0)
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
}

export async function requestMicrophone(
  request: MicrophoneRequest,
  mediaDevices: MediaDevices = navigator.mediaDevices,
): Promise<MicrophoneAccessResult> {
  const stream = await mediaDevices.getUserMedia(createMicrophoneConstraints(request))
  const track = stream.getAudioTracks()[0]
  if (!track) {
    stream.getTracks().forEach((item) => item.stop())
    throw new DOMException('No audio track was returned.', 'NotFoundError')
  }
  const settings = track.getSettings()
  const inputs = await enumerateLabeledAudioInputs(mediaDevices).catch(() => [])
  const matched = inputs.find((input) => input.deviceId === settings.deviceId)
  return {
    stream,
    settings: {
      deviceId: settings.deviceId ?? null,
      label: matched?.label ?? (track.label || null),
      sampleRate: nullableNumber(settings.sampleRate),
      channelCount: nullableNumber(settings.channelCount),
      echoCancellation: nullableBoolean(settings.echoCancellation),
      noiseSuppression: nullableBoolean(settings.noiseSuppression),
      autoGainControl: nullableBoolean(settings.autoGainControl),
    },
    inputs,
    showInputSelector: inputs.length > 1,
  }
}

export function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}
