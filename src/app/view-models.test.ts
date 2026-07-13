import { describe, expect, it } from 'vitest'

import { createDemoProject } from './demo'
import { toTargetSet } from './view-models'

describe('application view models', () => {
  it('preserves the source asset link for an analyzed target revision', () => {
    const targetSourceAssetId = crypto.randomUUID()
    const project = {
      ...createDemoProject(),
      targetMode: 'isolated-vocal' as const,
      targetSourceAssetId,
      targetSourceName: 'recorded-melody.m4a',
      targetSourceMimeType: 'audio/mp4',
    }

    expect(toTargetSet(project)).toMatchObject({
      kind: 'analyzed',
      sourceAssetId: targetSourceAssetId,
    })
  })
})
