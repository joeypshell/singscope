import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export async function sha256Blob(blob: Blob): Promise<string> {
  const hash = sha256.create()
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        hash.update(next.value)
      }
    } finally {
      reader.releaseLock()
    }
  } else {
    const bytes = new Uint8Array(await readBlobArrayBuffer(blob))
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      hash.update(bytes.subarray(offset, Math.min(offset + 1024 * 1024, bytes.length)))
    }
  }
  return bytesToHex(hash.digest())
}

export function sha256Bytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read Blob.'))
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('Blob did not produce binary data.'))
    }
    reader.readAsArrayBuffer(blob)
  })
}
