import { describe, expect, it, vi } from 'vitest'

import {
  PcmCapturePipeline,
  type PcmBatchMessage,
  type PitchCandidateMessage,
} from './capture-pipeline'

class FakeMessagePort extends EventTarget {
  readonly posted: { message: unknown; transfer: readonly Transferable[] }[] = []
  readonly start = vi.fn()

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posted.push({ message, transfer })
  }

  emit(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }))
  }
}

class FakeWorkletNode {
  readonly port = new FakeMessagePort()
  readonly connect = vi.fn(<T>(destination: T): T => destination)
  readonly disconnect = vi.fn()
}

interface PostedWorkerMessage {
  readonly message: Record<string, unknown>
  readonly transfer: readonly Transferable[]
}

class FakeWorker extends EventTarget {
  readonly posted: PostedWorkerMessage[] = []
  readonly terminate = vi.fn()

  postMessage(message: Record<string, unknown>, transfer: readonly Transferable[] = []): void {
    this.posted.push({ message, transfer })
  }

  emit(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }))
  }
}

class FakeAudioContext {
  readonly destination = {} as AudioDestinationNode
  readonly audioWorklet = { addModule: vi.fn(() => Promise.resolve()) }
  readonly silentGain = {
    gain: { value: 1 },
    connect: vi.fn(<T>(destination: T): T => destination),
    disconnect: vi.fn(),
  }
  readonly createGain = vi.fn(() => this.silentGain)
}

function pcm(contextTimeSeconds: number): PcmBatchMessage {
  return {
    type: 'pcm',
    contextFrame: contextTimeSeconds * 48_000,
    contextTimeSeconds,
    sampleRate: 48_000,
    rms: 0.1,
    peak: 0.2,
    samples: new ArrayBuffer(4096 * 4),
  }
}

function candidate(contextTimeSeconds: number): PitchCandidateMessage {
  return {
    type: 'pitch-candidate',
    contextTimeSeconds,
    frequencyHz: 440,
    confidence: 0.95,
    rms: 0.1,
    peak: 0.2,
    analysisGap: false,
    scorable: true,
    reason: null,
  }
}

async function fixture(maxInFlightBatches = 2) {
  const context = new FakeAudioContext()
  const node = new FakeWorkletNode()
  const worker = new FakeWorker()
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const onPitchCandidate = vi.fn()
  const onGap = vi.fn()
  const pipeline = await PcmCapturePipeline.create(
    context as unknown as AudioContext,
    source as unknown as AudioNode,
    { onPitchCandidate, onGap },
    {
      maxInFlightBatches,
      createWorkletNode: (_audioContext, options) => {
        expect(options.processorOptions).toEqual({ batchSize: 4096, poolSize: 6 })
        return node as unknown as AudioWorkletNode
      },
      createWorker: () => worker as unknown as Worker,
    },
  )
  return { context, node, worker, source, onPitchCandidate, onGap, pipeline }
}

function resultFor(post: PostedWorkerMessage, candidates: readonly PitchCandidateMessage[] = []) {
  return {
    type: 'dsp-result',
    id: post.message['id'],
    candidates,
    recycle: post.message['samples'],
  }
}

describe('PcmCapturePipeline diagnostics', () => {
  it('bounds work in flight, records overflow, and recovers when a worker result arrives', async () => {
    const { node, worker, onPitchCandidate, onGap, pipeline } = await fixture(2)
    const first = pcm(1)
    const second = pcm(2)
    const dropped = pcm(3)

    node.port.emit(first)
    node.port.emit(second)
    node.port.emit(dropped)

    expect(worker.posted.map((post) => post.message['type'])).toEqual(['analyze', 'analyze', 'gap'])
    expect(onGap).toHaveBeenCalledWith(3)
    expect(node.port.posted).toEqual([
      {
        message: { type: 'recycle', buffer: dropped.samples },
        transfer: [dropped.samples],
      },
    ])
    expect(pipeline.getDiagnostics()).toEqual({
      receivedBatches: 3,
      submittedBatches: 2,
      processedBatches: 0,
      droppedBatches: 1,
      recycledBuffers: 1,
      inFlightBatches: 2,
      highWaterMark: 2,
      abandonedBatches: 0,
      lateWorkerResults: 0,
      drainTimedOut: false,
      disposed: false,
    })

    const firstAnalyze = worker.posted[0]
    expect(firstAnalyze).toBeDefined()
    if (!firstAnalyze) return
    const detected = candidate(1.04)
    worker.emit(resultFor(firstAnalyze, [detected]))
    expect(onPitchCandidate).toHaveBeenCalledWith(detected)
    expect(pipeline.getDiagnostics()).toMatchObject({
      processedBatches: 1,
      recycledBuffers: 2,
      inFlightBatches: 1,
      highWaterMark: 2,
    })

    const recovered = pcm(4)
    node.port.emit(recovered)
    expect(worker.posted.map((post) => post.message['type'])).toEqual([
      'analyze',
      'analyze',
      'gap',
      'analyze',
    ])
    expect(pipeline.getDiagnostics()).toMatchObject({
      receivedBatches: 4,
      submittedBatches: 3,
      droppedBatches: 1,
      inFlightBatches: 2,
      highWaterMark: 2,
    })

    const secondAnalyze = worker.posted[1]
    const recoveredAnalyze = worker.posted[3]
    expect(secondAnalyze).toBeDefined()
    expect(recoveredAnalyze).toBeDefined()
    if (!secondAnalyze || !recoveredAnalyze) return
    worker.emit(resultFor(secondAnalyze))
    worker.emit(resultFor(recoveredAnalyze))
    expect(pipeline.getDiagnostics()).toMatchObject({
      processedBatches: 3,
      recycledBuffers: 4,
      inFlightBatches: 0,
    })
  })

  it('ignores duplicate or unknown results without corrupting queue accounting', async () => {
    const { node, worker, onPitchCandidate, pipeline } = await fixture(1)
    node.port.emit(pcm(1))
    const analyze = worker.posted[0]
    expect(analyze).toBeDefined()
    if (!analyze) return

    worker.emit(resultFor(analyze, [candidate(1.04)]))
    worker.emit(resultFor(analyze, [candidate(1.06)]))
    worker.emit({ ...resultFor(analyze), id: 999 })

    expect(onPitchCandidate).toHaveBeenCalledTimes(1)
    expect(pipeline.getDiagnostics()).toMatchObject({
      submittedBatches: 1,
      processedBatches: 1,
      recycledBuffers: 1,
      inFlightBatches: 0,
    })
  })

  it('flushes a partial worklet batch and waits for every accepted result before draining', async () => {
    const { node, worker, source, onPitchCandidate, pipeline } = await fixture(2)
    const first = pcm(1)
    const partial = { ...pcm(1.08), samples: new ArrayBuffer(512 * 4) }
    node.port.emit(first)

    const draining = pipeline.drain(1_000)
    expect(pipeline.drain()).toBe(draining)
    expect(source.disconnect).toHaveBeenCalledWith(node)
    expect(node.port.posted).toContainEqual({
      message: { type: 'flush', requestId: 1 },
      transfer: [],
    })

    // The real worklet sends its partial PCM first and then this acknowledgement.
    node.port.emit(partial)
    node.port.emit({ type: 'flushed', requestId: 1 })
    let settled = false
    void draining.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    const firstAnalyze = worker.posted[0]
    const partialAnalyze = worker.posted[1]
    expect(firstAnalyze).toBeDefined()
    expect(partialAnalyze).toBeDefined()
    if (!firstAnalyze || !partialAnalyze) return
    worker.emit(resultFor(firstAnalyze, [candidate(1.04)]))
    await Promise.resolve()
    expect(settled).toBe(false)
    worker.emit(resultFor(partialAnalyze, [candidate(1.1)]))

    await expect(draining).resolves.toMatchObject({
      submittedBatches: 2,
      processedBatches: 2,
      inFlightBatches: 0,
      abandonedBatches: 0,
      drainTimedOut: false,
    })
    expect(onPitchCandidate).toHaveBeenCalledTimes(2)
    pipeline.dispose()
  })

  it('turns accepted batches into explicit gaps when the bounded drain times out', async () => {
    vi.useFakeTimers()
    try {
      const { node, worker, onPitchCandidate, onGap, pipeline } = await fixture(2)
      node.port.emit(pcm(1))
      node.port.emit(pcm(2))

      const draining = pipeline.drain(25)
      node.port.emit({ type: 'flushed', requestId: 1 })
      await vi.advanceTimersByTimeAsync(25)

      await expect(draining).resolves.toMatchObject({
        submittedBatches: 2,
        processedBatches: 0,
        inFlightBatches: 0,
        abandonedBatches: 2,
        drainTimedOut: true,
      })
      expect(onGap.mock.calls).toEqual([[1], [2]])

      const firstAnalyze = worker.posted[0]
      expect(firstAnalyze).toBeDefined()
      if (firstAnalyze) worker.emit(resultFor(firstAnalyze, [candidate(1.04)]))
      expect(onPitchCandidate).not.toHaveBeenCalled()
      pipeline.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up the worker and graph when connecting the input source fails', async () => {
    const context = new FakeAudioContext()
    const node = new FakeWorkletNode()
    const worker = new FakeWorker()
    const source = {
      connect: vi.fn(() => {
        throw new DOMException('route changed', 'InvalidStateError')
      }),
      disconnect: vi.fn(),
    }

    await expect(
      PcmCapturePipeline.create(
        context as unknown as AudioContext,
        source as unknown as AudioNode,
        { onPitchCandidate: vi.fn() },
        {
          createWorkletNode: () => node as unknown as AudioWorkletNode,
          createWorker: () => worker as unknown as Worker,
        },
      ),
    ).rejects.toThrow('route changed')
    expect(source.disconnect).toHaveBeenCalledWith(node)
    expect(node.disconnect).toHaveBeenCalledOnce()
    expect(context.silentGain.disconnect).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('defines disposal as abandoning in-flight buffers and ignoring a synchronous late result', async () => {
    const { node, worker, source, onPitchCandidate, pipeline } = await fixture(2)
    node.port.emit(pcm(1))
    const analyze = worker.posted[0]
    expect(analyze).toBeDefined()
    if (!analyze) return

    worker.terminate.mockImplementationOnce(() => {
      worker.emit(resultFor(analyze, [candidate(1.04)]))
    })
    pipeline.dispose()
    pipeline.dispose()

    expect(onPitchCandidate).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(source.disconnect).toHaveBeenCalledWith(node)
    expect(node.disconnect).toHaveBeenCalledOnce()
    expect(pipeline.getDiagnostics()).toEqual({
      receivedBatches: 1,
      submittedBatches: 1,
      processedBatches: 0,
      droppedBatches: 0,
      recycledBuffers: 0,
      inFlightBatches: 0,
      highWaterMark: 1,
      abandonedBatches: 1,
      lateWorkerResults: 1,
      drainTimedOut: false,
      disposed: true,
    })

    node.port.emit(pcm(2))
    expect(pipeline.getDiagnostics().receivedBatches).toBe(1)
  })
})
