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

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly batchSize: number
  private readonly pool: Float32Array[] = []
  private writeBuffer: Float32Array
  private writeOffset = 0
  private batchStartFrame = 0
  private sumSquares = 0
  private peak = 0

  constructor(options: CaptureWorkletOptions) {
    super()
    this.batchSize = Math.max(1024, options.processorOptions?.batchSize ?? 4096)
    const poolSize = Math.max(2, options.processorOptions?.poolSize ?? 6)
    for (let index = 0; index < poolSize; index += 1)
      this.pool.push(new Float32Array(this.batchSize))
    this.writeBuffer = this.pool.pop() ?? new Float32Array(this.batchSize)
    this.port.onmessage = (event: MessageEvent<{ type?: string; buffer?: ArrayBuffer }>) => {
      if (event.data.type === 'recycle' && event.data.buffer?.byteLength === this.batchSize * 4) {
        this.pool.push(new Float32Array(event.data.buffer))
      }
    }
  }

  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    if (this.writeOffset === 0) this.batchStartFrame = currentFrame

    for (const sample of channel) {
      this.writeBuffer[this.writeOffset] = sample
      this.writeOffset += 1
      this.sumSquares += sample * sample
      this.peak = Math.max(this.peak, Math.abs(sample))
      if (this.writeOffset === this.batchSize) this.flush()
    }
    return true
  }

  private flush(): void {
    const completed = this.writeBuffer
    const rms = Math.sqrt(this.sumSquares / this.batchSize)
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
    this.writeBuffer = this.pool.pop() ?? new Float32Array(this.batchSize)
    this.writeOffset = 0
    this.sumSquares = 0
    this.peak = 0
  }
}

registerProcessor('singscope-pcm-capture', PcmCaptureProcessor)

export {}
