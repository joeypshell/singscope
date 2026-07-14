import type { PitchEstimateReason } from '../dsp/contracts'

export interface PcmBatchMessage {
  readonly type: 'pcm'
  readonly contextFrame: number
  readonly contextTimeSeconds: number
  readonly sampleRate: number
  readonly rms: number
  readonly peak: number
  readonly samples: ArrayBuffer
}

export interface PitchCandidateMessage {
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

export type PitchCandidateGapReason =
  'silence' | 'below-confidence' | 'out-of-range' | 'invalid-frame' | 'timeline-gap' | null

export function pitchCandidateGapReason(
  candidate: PitchCandidateMessage,
  timelineAvailable: boolean,
  accepted: boolean,
): PitchCandidateGapReason {
  if (!timelineAvailable) return 'timeline-gap'
  if (accepted) return null
  if (candidate.reason === 'low-confidence') return 'below-confidence'
  return candidate.reason ?? 'invalid-frame'
}

interface WorkerResultMessage {
  readonly type: 'dsp-result'
  readonly id: number
  readonly candidates: readonly PitchCandidateMessage[]
  readonly recycle: ArrayBuffer
}

interface WorkletLevelMessage {
  readonly type: 'level'
  readonly rms: number
  readonly peak: number
}

export interface CapturePipelineHandlers {
  readonly onPitchCandidate: (candidate: PitchCandidateMessage) => void
  readonly onLevel?: (rms: number, peak: number) => void
  readonly onGap?: (contextTimeSeconds: number) => void
}

export interface CapturePipelineOptions {
  readonly maxInFlightBatches?: number
  readonly workletUrl?: string | URL
  readonly workerUrl?: string | URL
}

export class PcmCapturePipeline {
  private readonly handlers: CapturePipelineHandlers
  private readonly maxInFlight: number
  private readonly node: AudioWorkletNode
  private readonly worker: Worker
  private readonly silentGain: GainNode
  private inFlight = 0
  private nextId = 1

  private constructor(
    context: AudioContext,
    node: AudioWorkletNode,
    worker: Worker,
    handlers: CapturePipelineHandlers,
    maxInFlight: number,
  ) {
    this.node = node
    this.worker = worker
    this.handlers = handlers
    this.maxInFlight = maxInFlight
    this.silentGain = context.createGain()
    this.silentGain.gain.value = 0
    this.node.connect(this.silentGain).connect(context.destination)
    this.node.port.addEventListener('message', this.onWorkletMessage)
    this.node.port.start()
    this.worker.addEventListener('message', this.onWorkerMessage)
  }

  static async create(
    context: AudioContext,
    source: AudioNode,
    handlers: CapturePipelineHandlers,
    options: CapturePipelineOptions = {},
  ): Promise<PcmCapturePipeline> {
    const workletUrl = options.workletUrl ?? defaultWorkletUrl
    const workerUrl = options.workerUrl ?? defaultDspWorkerUrl
    await context.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(context, 'singscope-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { batchSize: 4096, poolSize: 6 },
    })
    const worker = new Worker(workerUrl, { type: 'module', name: 'singscope-dsp' })
    const pipeline = new PcmCapturePipeline(
      context,
      node,
      worker,
      handlers,
      Math.max(1, options.maxInFlightBatches ?? 4),
    )
    source.connect(node)
    return pipeline
  }

  dispose(): void {
    this.node.port.removeEventListener('message', this.onWorkletMessage)
    this.worker.removeEventListener('message', this.onWorkerMessage)
    this.node.disconnect()
    this.silentGain.disconnect()
    this.worker.terminate()
  }

  private readonly onWorkletMessage = (
    event: MessageEvent<PcmBatchMessage | WorkletLevelMessage>,
  ) => {
    const message = event.data
    if (message.type === 'level') {
      this.handlers.onLevel?.(message.rms, message.peak)
      return
    }

    if (this.inFlight >= this.maxInFlight) {
      this.handlers.onGap?.(message.contextTimeSeconds)
      this.worker.postMessage({ type: 'gap', contextTimeSeconds: message.contextTimeSeconds })
      this.node.port.postMessage({ type: 'recycle', buffer: message.samples }, [message.samples])
      return
    }

    const id = this.nextId++
    this.inFlight += 1
    this.worker.postMessage({ ...message, type: 'analyze', id }, [message.samples])
  }

  private readonly onWorkerMessage = (event: MessageEvent<WorkerResultMessage>) => {
    const message = event.data
    this.inFlight = Math.max(0, this.inFlight - 1)
    for (const candidate of message.candidates) this.handlers.onPitchCandidate(candidate)
    this.node.port.postMessage({ type: 'recycle', buffer: message.recycle }, [message.recycle])
  }
}
import defaultDspWorkerUrl from '../../workers/dsp.worker.ts?worker&url'
import defaultWorkletUrl from '../worklets/pcm-capture.worklet.ts?worker&url'
