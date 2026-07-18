import type { WakeLockAdapter, WakeLockHandle } from './types'

/** Shares one screen-wake sentinel across retries and repeated takes. */
export class ManagedWakeLock {
  private handle: WakeLockHandle | null = null
  private pending: Promise<void> | null = null

  constructor(private readonly adapter: WakeLockAdapter | undefined) {}

  request(): Promise<void> {
    if (this.handle && !this.handle.released) return Promise.resolve()
    if (this.pending) return this.pending
    if (!this.adapter) return Promise.resolve()

    this.pending = this.adapter
      .request()
      .then((handle) => {
        this.handle = handle
      })
      .catch(() => undefined)
      .then(() => {
        this.pending = null
      })
    return this.pending
  }

  async release(): Promise<void> {
    await this.pending
    const handle = this.handle
    this.handle = null
    if (handle && !handle.released) await handle.release().catch(() => undefined)
  }
}
