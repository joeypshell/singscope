import type {
  MelodyReferenceRenderInput,
  MelodyReferenceWorkerRequest,
  MelodyReferenceWorkerResponse,
} from '../dsp/melody-reference'
import melodyReferenceWorkerUrl from '../../workers/melody-reference.worker.ts?worker&url'

const RENDER_TIMEOUT_MS = 30_000

export type MelodyReferenceRenderer = (input: MelodyReferenceRenderInput) => Promise<ArrayBuffer>

export const renderMelodyReferenceInWorker: MelodyReferenceRenderer = (input) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(melodyReferenceWorkerUrl, {
      type: 'module',
      name: 'singscope-melody-reference',
    })
    let settled = false
    const finish = (result: { readonly bytes: ArrayBuffer } | { readonly error: Error }) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timeout)
      worker.terminate()
      if ('bytes' in result) resolve(result.bytes)
      else reject(result.error)
    }
    const timeout = globalThis.setTimeout(
      () => finish({ error: new Error('The local melody guide took too long to prepare.') }),
      RENDER_TIMEOUT_MS,
    )
    worker.addEventListener('message', (event: MessageEvent<MelodyReferenceWorkerResponse>) => {
      const response = event.data
      if (response.type === 'melody-reference-rendered') finish({ bytes: response.bytes })
      else finish({ error: new Error(response.message) })
    })
    worker.addEventListener('error', () => {
      finish({ error: new Error('The local melody guide worker could not start.') })
    })
    const request: MelodyReferenceWorkerRequest = {
      type: 'render-melody-reference',
      input,
    }
    worker.postMessage(request)
  })
