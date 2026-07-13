import { afterEach, describe, expect, it } from 'vitest'

import { SingScopeDatabase } from './db'
import { createRepositories } from './repositories'
import type { VersionedRecord } from './types'

const databases: SingScopeDatabase[] = []
const PROJECT_ID = '12ad03d1-d323-4e53-9b44-ccfe552da537'

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function setup(): {
  database: SingScopeDatabase
  repositories: ReturnType<typeof createRepositories>
} {
  const database = new SingScopeDatabase(`singscope:test:metadata:${crypto.randomUUID()}`)
  databases.push(database)
  return { database, repositories: createRepositories(database) }
}

describe('validated repositories', () => {
  it('round-trips versioned project data', async () => {
    const { repositories } = setup()
    const record: VersionedRecord = {
      id: PROJECT_ID,
      schemaVersion: 1,
      createdAt: '2026-07-13T12:00:00.000Z',
      updatedAt: '2026-07-13T12:00:00.000Z',
      payload: { name: 'Warmups', offsetSeconds: 0 },
    }

    await repositories.projects.put(record)
    expect(await repositories.projects.get(PROJECT_ID)).toEqual(record)
    expect(await repositories.projects.list()).toEqual([record])
  })

  it('rejects malformed or non-finite persisted payloads', async () => {
    const { repositories } = setup()
    const invalid = {
      id: PROJECT_ID,
      schemaVersion: 1,
      createdAt: 'not-a-date',
      updatedAt: '2026-07-13T12:00:00.000Z',
      payload: { pitch: Number.NaN },
    }

    await expect(repositories.projects.put(invalid as VersionedRecord)).rejects.toMatchObject({
      code: 'corrupt-data',
    })
  })

  it('keys pitch chunks by take and index', async () => {
    const { repositories } = setup()
    const takeId = '62502936-8db7-4a4e-9995-16095f427eca'
    const chunk = {
      id: '727de71b-1afc-41db-bb4c-8bded37a4a3f',
      projectId: PROJECT_ID,
      takeId,
      index: 0,
      startSeconds: 0,
      endSeconds: 1,
      schemaVersion: 1,
      createdAt: '2026-07-13T12:00:00.000Z',
      updatedAt: '2026-07-13T12:00:00.000Z',
      payload: [{ timeSeconds: 0.1, hz: null }],
    }
    await repositories.pitchChunks.put(chunk)
    expect(await repositories.pitchChunks.get([takeId, 0])).toEqual(chunk)
  })
})
