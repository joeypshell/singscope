import { DEFAULT_YIN_CONFIG, YinPitchDetector } from '../audio/dsp/yin'
import { resampleLinear } from '../audio/dsp/resample'
import type { PitchEstimateReason } from '../audio/dsp/contracts'

interface AnalyzeMessage {
  readonly type: 'analyze'
  readonly id: number
  readonly contextTimeSeconds: number
  readonly sampleRate: number
  readonly rms: number
  readonly peak: number
  readonly samples: ArrayBuffer
}

interface GapMessage {
  readonly type: 'gap'
  readonly contextTimeSeconds: number
}

interface Candidate {
  readonly type: 'pitch-candidate'
  readonly contextTimeSeconds: number
  readonly frequencyHz: number | null
  readonly confidence: number
  readonly rms: number
  readonly peak: number
  readonly analysisGap: boolean
  readonly scorable: boolean
  readonly reason: PitchEstimateReason
}

const TARGET_RATE = DEFAULT_YIN_CONFIG.internalSampleRateHz
const FRAME_SIZE = Math.round(TARGET_RATE * DEFAULT_YIN_CONFIG.frameDurationSeconds)
const HOP_SIZE = Math.round(TARGET_RATE * DEFAULT_YIN_CONFIG.hopDurationSeconds)
const detector = new YinPitchDetector()

let queued = new Float32Array(0)
let queuedStartTime = 0

function analyze(message: AnalyzeMessage): readonly Candidate[] {
  const input = new Float32Array(message.samples)
  const normalized = resampleLinear(input, message.sampleRate, TARGET_RATE)
  if (queued.length === 0) queuedStartTime = message.contextTimeSeconds
  const merged = new Float32Array(queued.length + normalized.length)
  merged.set(queued)
  merged.set(normalized, queued.length)
  queued = merged

  const candidates: Candidate[] = []
  let consumed = 0
  while (queued.length - consumed >= FRAME_SIZE) {
    const frame = queued.subarray(consumed, consumed + FRAME_SIZE)
    const estimate = detector.detect(frame, TARGET_RATE)
    candidates.push({
      type: 'pitch-candidate',
      contextTimeSeconds: queuedStartTime + (consumed + FRAME_SIZE / 2) / TARGET_RATE,
      frequencyHz: estimate.candidateHz,
      confidence: estimate.confidence ?? 0,
      rms: estimate.rms,
      peak: estimate.peak,
      analysisGap: false,
      scorable: estimate.frequencyHz !== null,
      reason: estimate.reason,
    })
    consumed += HOP_SIZE
  }
  if (consumed > 0) {
    queued = queued.slice(consumed)
    queuedStartTime += consumed / TARGET_RATE
  }
  return candidates
}

const workerScope = self as DedicatedWorkerGlobalScope
workerScope.addEventListener('message', (event: MessageEvent<AnalyzeMessage | GapMessage>) => {
  const message = event.data
  if (message.type === 'gap') {
    queued = new Float32Array(0)
    queuedStartTime = message.contextTimeSeconds
    detector.reset()
    return
  }
  const candidates = analyze(message)
  workerScope.postMessage(
    { type: 'dsp-result', id: message.id, candidates, recycle: message.samples },
    [message.samples],
  )
})

export {}
