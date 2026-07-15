import { describe, expect, it } from 'vitest'

import {
  ORPHAN_GRACE_MILLISECONDS,
  ORPHAN_ROOT_BATCH_SIZE,
  authorizeCleanupRequest,
  cleanupTokenFallbackForRuntime,
  cleanupTokenMatches,
  isExpectedObjectPath,
  isPackageDirectory,
  isPastOrphanGrace,
  nextOrphanScanOffset,
  resolveCleanupToken,
  resolveSupabaseSecretKey,
  splitExpectedObjectPath,
} from './contract.ts'

const FOLDER = '123e4567-e89b-42d3-a456-426614174000'
const FILE = `${'a'.repeat(64)}.zip`

describe('analysis-report cleanup contract', () => {
  it('requires a substantial cleanup token and compares it without plain-text branching', async () => {
    const token = 'cleanup-token-that-is-longer-than-thirty-two-characters'
    expect(resolveCleanupToken(` ${token} `)).toBe(token)
    expect(() => resolveCleanupToken('short')).toThrow(/32/)
    await expect(cleanupTokenMatches(token, token)).resolves.toBe(true)
    await expect(cleanupTokenMatches(`${token}x`, token)).resolves.toBe(false)
    await expect(cleanupTokenMatches(null, token)).resolves.toBe(false)
  })

  it('uses the database verifier for hosted cleanup authorization', async () => {
    const token = 'a'.repeat(64)
    const presented: string[] = []

    await expect(
      authorizeCleanupRequest(token, undefined, (candidate) => {
        presented.push(candidate)
        return Promise.resolve(candidate === token)
      }),
    ).resolves.toBe(true)
    expect(presented).toEqual([token])

    await expect(
      authorizeCleanupRequest('short', undefined, () =>
        Promise.reject(new Error('invalid tokens must not reach the database')),
      ),
    ).resolves.toBe(false)
  })

  it('keeps the environment token as a local-only fallback', async () => {
    const token = 'local-cleanup-token-that-is-at-least-thirty-two-characters'
    let databaseCalls = 0

    await expect(
      authorizeCleanupRequest(token, token, () => {
        databaseCalls += 1
        return Promise.resolve(false)
      }),
    ).resolves.toBe(true)
    await expect(
      authorizeCleanupRequest(`${token}-wrong`, token, () => {
        databaseCalls += 1
        return Promise.resolve(true)
      }),
    ).resolves.toBe(false)
    expect(databaseCalls).toBe(0)
  })

  it('never enables the environment fallback for a hosted Supabase URL', () => {
    const token = 'local-cleanup-token-that-is-at-least-thirty-two-characters'
    expect(cleanupTokenFallbackForRuntime('http://127.0.0.1:54321', token)).toBe(token)
    expect(cleanupTokenFallbackForRuntime('http://kong:8000', token)).toBe(token)
    expect(cleanupTokenFallbackForRuntime('https://abcdefghijklmnopqrst.supabase.co', token)).toBe(
      undefined,
    )
    expect(cleanupTokenFallbackForRuntime('not-a-url', token)).toBe(undefined)
  })

  it('resolves current named Supabase secret keys and local fallbacks', () => {
    expect(
      resolveSupabaseSecretKey({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_current"}' }),
    ).toBe('sb_secret_current')
    expect(resolveSupabaseSecretKey({ SUPABASE_SECRET_KEY: 'local-secret' })).toBe('local-secret')
    expect(() => resolveSupabaseSecretKey({ SUPABASE_SECRET_KEYS: '{}' })).toThrow(/default/)
  })

  it('accepts only the deterministic UUID/hash ZIP object shape', () => {
    expect(isPackageDirectory(FOLDER)).toBe(true)
    expect(isExpectedObjectPath(FOLDER, FILE)).toBe(true)
    expect(splitExpectedObjectPath(`${FOLDER}/${FILE}`)).toEqual({
      folder: FOLDER,
      fileName: FILE,
    })
    expect(splitExpectedObjectPath(`../${FILE}`)).toBeNull()
    expect(splitExpectedObjectPath(`${FOLDER}/nested/${FILE}`)).toBeNull()
    expect(isExpectedObjectPath(FOLDER, `${'A'.repeat(64)}.zip`)).toBe(false)
  })

  it('requires a valid Storage creation time beyond the orphan grace period', () => {
    const now = new Date('2026-07-14T20:00:00.000Z')
    const old = new Date(now.valueOf() - ORPHAN_GRACE_MILLISECONDS - 1).toISOString()
    const recent = new Date(now.valueOf() - ORPHAN_GRACE_MILLISECONDS + 1).toISOString()
    expect(isPastOrphanGrace(old, now)).toBe(true)
    expect(isPastOrphanGrace(recent, now)).toBe(false)
    expect(isPastOrphanGrace('not-a-date', now)).toBe(false)
    expect(isPastOrphanGrace(null, now)).toBe(false)
  })

  it('advances bounded root scans and wraps at the end', () => {
    expect(nextOrphanScanOffset(0, ORPHAN_ROOT_BATCH_SIZE)).toBe(ORPHAN_ROOT_BATCH_SIZE)
    expect(nextOrphanScanOffset(50, ORPHAN_ROOT_BATCH_SIZE - 1)).toBe(0)
    expect(nextOrphanScanOffset(100_000, ORPHAN_ROOT_BATCH_SIZE)).toBe(0)
    expect(nextOrphanScanOffset(-1, ORPHAN_ROOT_BATCH_SIZE)).toBe(0)
  })
})
