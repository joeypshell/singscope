/// <reference lib="webworker" />

import {
  renderMelodyReferenceWav,
  type MelodyReferenceWorkerRequest,
  type MelodyReferenceWorkerResponse,
} from '../audio/dsp/melody-reference'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data
  if (
    typeof request !== 'object' ||
    request === null ||
    !('type' in request) ||
    request.type !== 'render-melody-reference' ||
    !('input' in request)
  ) {
    return
  }
  try {
    const bytes = renderMelodyReferenceWav((request as MelodyReferenceWorkerRequest).input)
    const response: MelodyReferenceWorkerResponse = {
      type: 'melody-reference-rendered',
      bytes,
    }
    workerScope.postMessage(response, [bytes])
  } catch (error) {
    const response: MelodyReferenceWorkerResponse = {
      type: 'melody-reference-error',
      message: error instanceof Error ? error.message : 'The melody reference could not be built.',
    }
    workerScope.postMessage(response)
  }
})

export {}
