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

interface WorkletFlushedMessage {
  readonly type: 'flushed'
  readonly requestId: number
}

type WorkletMessage = PcmBatchMessage | WorkletLevelMessage | WorkletFlushedMessage

export interface CapturePipelineHandlers {
  readonly onPitchCandidate: (candidate: PitchCandidateMessage) => void
  readonly onLevel?: (rms: number, peak: number) => void
  readonly onGap?: (contextTimeSeconds: number) => void
}

export interface CapturePipelineOptions {
  readonly maxInFlightBatches?: number
  readonly workletUrl?: string | URL
  readonly workerUrl?: string | URL
  /** Test seam for exercising queue behavior without allocating a browser worklet. */
  readonly createWorkletNode?:
    ((context: AudioContext, options: AudioWorkletNodeOptions) => AudioWorkletNode) | undefined
  /** Test seam for exercising queue behavior without allocating a browser worker. */
  readonly createWorker?: ((url: string | URL, options: WorkerOptions) => Worker) | undefined
}

/** Fixed-size counters only; no microphone samples or unbounded event history are retained. */
export interface CapturePipelineDiagnostics {
  readonly receivedBatches: number
  readonly submittedBatches: number
  readonly processedBatches: number
  readonly droppedBatches: number
  readonly recycledBuffers: number
  readonly inFlightBatches: number
  readonly highWaterMark: number
  readonly abandonedBatches: number
  readonly lateWorkerResults: number
  readonly drainTimedOut: boolean
  readonly disposed: boolean
}

interface DrainState {
  readonly requestId: number
  readonly resolve: (diagnostics: CapturePipelineDiagnostics) => void
  timeout: ReturnType<typeof setTimeout> | null
  workletFlushed: boolean
}

const DEFAULT_DRAIN_TIMEOUT_MS = 1_000
const MAX_DRAIN_TIMEOUT_MS = 5_000

export class PcmCapturePipeline {
  private readonly handlers: CapturePipelineHandlers
  private readonly maxInFlight: number
  private readonly node: AudioWorkletNode
  private readonly source: AudioNode
  private readonly worker: Worker
  private readonly silentGain: GainNode
  private readonly pendingBatches = new Map<number, number>()
  private receivedBatches = 0
  private submittedBatches = 0
  private processedBatches = 0
  private droppedBatches = 0
  private recycledBuffers = 0
  private highWaterMark = 0
  private abandonedBatches = 0
  private lateWorkerResults = 0
  private drainTimedOut = false
  private disposed = false
  private drained = false
  private inputConnected = false
  private nextId = 1
  private nextDrainRequestId = 1
  private drainState: DrainState | null = null
  private drainPromise: Promise<CapturePipelineDiagnostics> | null = null

  private constructor(
    source: AudioNode,
    node: AudioWorkletNode,
    worker: Worker,
    silentGain: GainNode,
    handlers: CapturePipelineHandlers,
    maxInFlight: number,
  ) {
    this.source = source
    this.node = node
    this.worker = worker
    this.silentGain = silentGain
    this.handlers = handlers
    this.maxInFlight = maxInFlight
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

    let node: AudioWorkletNode | null = null
    let worker: Worker | null = null
    let silentGain: GainNode | null = null
    let pipeline: PcmCapturePipeline | null = null
    try {
      const nodeOptions: AudioWorkletNodeOptions = {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { batchSize: 4096, poolSize: 6 },
      }
      node = options.createWorkletNode
        ? options.createWorkletNode(context, nodeOptions)
        : new AudioWorkletNode(context, 'singscope-pcm-capture', nodeOptions)
      const workerOptions: WorkerOptions = { type: 'module', name: 'singscope-dsp' }
      worker = options.createWorker
        ? options.createWorker(workerUrl, workerOptions)
        : new Worker(workerUrl, workerOptions)
      silentGain = context.createGain()
      pipeline = new PcmCapturePipeline(
        source,
        node,
        worker,
        silentGain,
        handlers,
        Math.max(1, options.maxInFlightBatches ?? 4),
      )
      pipeline.connect(context.destination)
      return pipeline
    } catch (error) {
      if (pipeline) {
        pipeline.dispose()
      } else {
        try {
          node?.disconnect()
        } catch {
          // A partially constructed AudioWorkletNode may have no active outputs.
        }
        try {
          silentGain?.disconnect()
        } catch {
          // A gain that never reached the destination is already isolated.
        }
        worker?.terminate()
      }
      throw error
    }
  }

  getDiagnostics(): CapturePipelineDiagnostics {
    return {
      receivedBatches: this.receivedBatches,
      submittedBatches: this.submittedBatches,
      processedBatches: this.processedBatches,
      droppedBatches: this.droppedBatches,
      recycledBuffers: this.recycledBuffers,
      inFlightBatches: this.pendingBatches.size,
      highWaterMark: this.highWaterMark,
      abandonedBatches: this.abandonedBatches,
      lateWorkerResults: this.lateWorkerResults,
      drainTimedOut: this.drainTimedOut,
      disposed: this.disposed,
    }
  }

  /**
   * Stops new PCM at the source, asks the worklet to emit its partial buffer, and
   * waits for every accepted worker batch. The deadline is capped so a failed
   * worklet or DSP worker cannot block take recovery indefinitely.
   */
  drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<CapturePipelineDiagnostics> {
    if (this.drainPromise) return this.drainPromise
    if (this.disposed) return Promise.resolve(this.getDiagnostics())

    this.disconnectInput()
    const requestId = this.nextDrainRequestId++
    const boundedTimeoutMs = boundedDrainTimeout(timeoutMs)
    this.drainPromise = new Promise<CapturePipelineDiagnostics>((resolve) => {
      const state: DrainState = {
        requestId,
        resolve,
        timeout: null,
        workletFlushed: false,
      }
      this.drainState = state
      state.timeout = setTimeout(() => this.finishDrain(true), boundedTimeoutMs)
      try {
        this.node.port.postMessage({ type: 'flush', requestId })
      } catch {
        this.finishDrain(true)
      }
    })
    return this.drainPromise
  }

  dispose(): void {
    if (this.disposed) return
    if (this.drainState) this.finishDrain(true)
    else this.abandonPendingAsGaps()
    this.disposed = true
    this.disconnectInput()
    this.node.port.removeEventListener('message', this.onWorkletMessage)
    try {
      this.node.disconnect()
    } catch {
      // Safari may already have disconnected a failed worklet node.
    }
    try {
      this.silentGain.disconnect()
    } catch {
      // A context shutdown may disconnect its destination first.
    }
    this.worker.terminate()
    this.worker.removeEventListener('message', this.onWorkerMessage)
  }

  private connect(destination: AudioDestinationNode): void {
    this.silentGain.gain.value = 0
    this.node.connect(this.silentGain).connect(destination)
    this.node.port.addEventListener('message', this.onWorkletMessage)
    this.node.port.start()
    this.worker.addEventListener('message', this.onWorkerMessage)
    try {
      this.source.connect(this.node)
      this.inputConnected = true
    } catch (error) {
      try {
        this.source.disconnect(this.node)
      } catch {
        // A failed connection has nothing to detach on conforming implementations.
      }
      throw error
    }
  }

  private disconnectInput(): void {
    if (!this.inputConnected) return
    this.inputConnected = false
    try {
      this.source.disconnect(this.node)
    } catch {
      // Repeated route loss and context shutdown can detach the edge first.
    }
  }

  private readonly onWorkletMessage = (event: MessageEvent<WorkletMessage>) => {
    if (this.disposed) return
    const message = event.data
    if (message.type === 'level') {
      this.handlers.onLevel?.(message.rms, message.peak)
      return
    }
    if (message.type === 'flushed') {
      const state = this.drainState
      if (message.requestId !== state?.requestId) return
      state.workletFlushed = true
      this.maybeFinishDrain()
      return
    }

    this.receivedBatches = addBounded(this.receivedBatches)
    if (this.drained || this.pendingBatches.size >= this.maxInFlight) {
      this.droppedBatches = addBounded(this.droppedBatches)
      this.handlers.onGap?.(message.contextTimeSeconds)
      if (!this.drained) {
        this.worker.postMessage({ type: 'gap', contextTimeSeconds: message.contextTimeSeconds })
      }
      this.recycle(message.samples)
      return
    }

    const id = this.nextId++
    this.pendingBatches.set(id, message.contextTimeSeconds)
    this.submittedBatches = addBounded(this.submittedBatches)
    this.highWaterMark = Math.max(this.highWaterMark, this.pendingBatches.size)
    try {
      this.worker.postMessage({ ...message, type: 'analyze', id }, [message.samples])
    } catch {
      this.pendingBatches.delete(id)
      this.droppedBatches = addBounded(this.droppedBatches)
      this.handlers.onGap?.(message.contextTimeSeconds)
      this.recycle(message.samples)
      this.maybeFinishDrain()
    }
  }

  private readonly onWorkerMessage = (event: MessageEvent<WorkerResultMessage>) => {
    const message = event.data
    if (this.disposed) {
      this.lateWorkerResults = addBounded(this.lateWorkerResults)
      return
    }
    if (!this.pendingBatches.delete(message.id)) return
    this.processedBatches = addBounded(this.processedBatches)
    try {
      for (const candidate of message.candidates) this.handlers.onPitchCandidate(candidate)
    } finally {
      this.recycle(message.recycle)
      this.maybeFinishDrain()
    }
  }

  private maybeFinishDrain(): void {
    const state = this.drainState
    if (state?.workletFlushed && this.pendingBatches.size === 0) this.finishDrain(false)
  }

  private finishDrain(timedOut: boolean): void {
    const state = this.drainState
    if (!state) return
    if (state.timeout !== null) clearTimeout(state.timeout)
    if (timedOut) {
      this.drainTimedOut = true
      this.abandonPendingAsGaps()
    }
    this.drained = true
    this.drainState = null
    state.resolve(this.getDiagnostics())
  }

  private abandonPendingAsGaps(): number {
    const contextTimes = [...this.pendingBatches.values()]
    this.pendingBatches.clear()
    this.abandonedBatches = addBounded(this.abandonedBatches, contextTimes.length)
    for (const contextTimeSeconds of contextTimes) this.handlers.onGap?.(contextTimeSeconds)
    return contextTimes.length
  }

  private recycle(buffer: ArrayBuffer): void {
    this.node.port.postMessage({ type: 'recycle', buffer }, [buffer])
    this.recycledBuffers = addBounded(this.recycledBuffers)
  }
}

function boundedDrainTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DRAIN_TIMEOUT_MS
  return Math.min(MAX_DRAIN_TIMEOUT_MS, Math.max(0, Math.round(value)))
}

function addBounded(value: number, increment = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + increment)
}
import defaultDspWorkerUrl from '../../workers/dsp.worker.ts?worker&url'
import defaultWorkletUrl from '../worklets/pcm-capture.worklet.ts?worker&url'
