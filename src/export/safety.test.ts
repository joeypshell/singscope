import { describe, expect, it } from 'vitest'

import {
  assertSafeArchivePath,
  assertSafeDownloadName,
  createCsv,
  escapeHtml,
  validateJsonShape,
} from './safety'

describe('export safety', () => {
  it('escapes HTML report metadata', () => {
    expect(escapeHtml('<img src=x onerror="bad">')).toBe(
      '&lt;img src=x onerror=&quot;bad&quot;&gt;',
    )
  })

  it('neutralizes spreadsheet formulas and applies RFC CSV quoting', () => {
    expect(createCsv(['name', 'note'], [['=HYPERLINK("bad")', 'line, two']])).toBe(
      'name,note\r\n"\'=HYPERLINK(""bad"")","line, two"\r\n',
    )
  })

  it('rejects archive traversal and unsafe download names', () => {
    expect(() => assertSafeArchivePath('../recording.mp4')).toThrow(/Unsafe archive path/)
    expect(() => assertSafeArchivePath('assets\\recording.mp4')).toThrow(/Unsafe archive path/)
    expect(() => assertSafeDownloadName('../feedback.zip')).toThrow(/not safe/)
  })

  it('bounds imported JSON depth and array lengths', () => {
    expect(() => validateJsonShape({ ok: [1, null, 'value'] })).not.toThrow()
    expect(() => validateJsonShape([1, 2, 3], { maxArrayLength: 2 })).toThrow(/array-length/)
    expect(() => validateJsonShape({ a: { b: true } }, { maxDepth: 1 })).toThrow(/nesting/)
  })
})
