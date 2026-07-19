declare const currentFrame: number
declare const sampleRate: number

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
  ): boolean
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void

interface CaptureProcessorOptions {
  readonly batchSize?: number
  readonly poolSize?: number
}

interface CaptureWorkletOptions extends AudioWorkletNodeOptions {
  readonly processorOptions?: CaptureProcessorOptions
}

type CaptureControlMessage =
  | { readonly type: 'recycle'; readonly buffer?: ArrayBuffer }
  | { readonly type: 'flush'; readonly requestId: number }

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly batchSize: number
  private readonly pool: Float32Array[] = []
  private writeBuffer: Float32Array
  private writeOffset = 0
  private batchStartFrame = 0
  private sumSquares = 0
  private peak = 0
  private acceptingInput = true

  constructor(options: CaptureWorkletOptions) {
    super()
    this.batchSize = Math.max(1024, options.processorOptions?.batchSize ?? 4096)
    const poolSize = Math.max(2, options.processorOptions?.poolSize ?? 6)
    for (let index = 0; index < poolSize; index += 1)
      this.pool.push(new Float32Array(this.batchSize))
    this.writeBuffer = this.pool.pop() ?? new Float32Array(this.batchSize)
    this.port.onmessage = (event: MessageEvent<CaptureControlMessage>) => {
      const message = event.data
      if (message.type === 'recycle' && message.buffer?.byteLength === this.batchSize * 4) {
        this.pool.push(new Float32Array(message.buffer))
        return
      }
      if (message.type === 'flush' && Number.isSafeInteger(message.requestId)) {
        // Ignore all future render quanta before acknowledging. Messages sent on
        // this port are ordered, so the main thread receives the final partial
        // PCM batch before the acknowledgement.
        this.acceptingInput = false
        if (this.writeOffset > 0) this.flush(this.writeOffset)
        this.port.postMessage({ type: 'flushed', requestId: message.requestId })
      }
    }
  }

  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    if (!this.acceptingInput) return true
    const channel = inputs[0]?.[0]
    if (!channel) return true
    if (this.writeOffset === 0) this.batchStartFrame = currentFrame

    for (const sample of channel) {
      this.writeBuffer[this.writeOffset] = sample
      this.writeOffset += 1
      this.sumSquares += sample * sample
      this.peak = Math.max(this.peak, Math.abs(sample))
      if (this.writeOffset === this.batchSize) this.flush(this.batchSize)
    }
    return true
  }

  private flush(sampleCount: number): void {
    const completed =
      sampleCount === this.batchSize ? this.writeBuffer : this.writeBuffer.slice(0, sampleCount)
    const rms = Math.sqrt(this.sumSquares / sampleCount)
    this.port.postMessage(
      {
        type: 'pcm',
        contextFrame: this.batchStartFrame,
        contextTimeSeconds: this.batchStartFrame / sampleRate,
        sampleRate,
        rms,
        peak: this.peak,
        samples: completed.buffer,
      },
      [completed.buffer],
    )
    this.port.postMessage({ type: 'level', rms, peak: this.peak })
    if (sampleCount === this.batchSize) {
      this.writeBuffer = this.pool.pop() ?? new Float32Array(this.batchSize)
    }
    this.writeOffset = 0
    this.sumSquares = 0
    this.peak = 0
  }
}

registerProcessor('singscope-pcm-capture', PcmCaptureProcessor)

export {}
