import { describe, expect, it } from 'vitest'

import { createStaticReport } from './report'

describe('static report', () => {
  it('contains no script and escapes untrusted labels and notes', () => {
    const html = createStaticReport({
      title: '<script>alert(1)</script>',
      projectName: '<img src=x>',
      takeLabel: 'Take 1',
      recordedAt: '2026-07-13',
      metrics: { '<b>coverage</b>': null },
      notes: ['<iframe>'],
    })

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<iframe>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Not available')
  })
})
