import { describe, expect, it, vi } from 'vitest'

import { ManagedWakeLock } from './managed-wake-lock'

describe('ManagedWakeLock', () => {
  it('reuses one sentinel across retries and releases it on disposal', async () => {
    const release = vi.fn(() => Promise.resolve())
    const request = vi.fn(() => Promise.resolve({ released: false, release }))
    const wakeLock = new ManagedWakeLock({ request })

    await Promise.all([wakeLock.request(), wakeLock.request()])
    await wakeLock.request()
    expect(request).toHaveBeenCalledOnce()

    await wakeLock.release()
    expect(release).toHaveBeenCalledOnce()
    await wakeLock.request()
    expect(request).toHaveBeenCalledTimes(2)
  })
})
