/**
 * Sprint 051 A B3 — citation-parser unit tests.
 *
 * Load-bearing: the parser is the seam between the agent's emitted
 * text and the drawer's click target, so regressions here silently
 * break the whole citation UX. 7 cases covering: no markers, single
 * marker, multiple markers, optional section fragment, malformed
 * markers (pass through), unknown artifact type (skip), unicode
 * around the marker.
 */
import { describe, it, expect } from 'vitest'

import { parseCitations } from '../citation-parser'

describe('parseCitations', () => {
  it('returns a single text token when the input has no markers', () => {
    const out = parseCitations('Just plain prose, no citations at all.')
    expect(out).toEqual([
      { kind: 'text', text: 'Just plain prose, no citations at all.' },
    ])
  })

  it('splits around a single marker', () => {
    const out = parseCitations('See [[cite:sop:abc123]] for details.')
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ kind: 'text', text: 'See ' })
    expect(out[1]).toMatchObject({
      kind: 'citation',
      artifact: 'sop',
      artifactId: 'abc123',
      section: null,
    })
    expect(out[2]).toEqual({ kind: 'text', text: ' for details.' })
  })

  it('parses multiple markers in one paragraph', () => {
    const out = parseCitations(
      'The SOP [[cite:sop:sop-1]] and FAQ [[cite:faq:faq-2]] both apply.',
    )
    const citations = out.filter((t) => t.kind === 'citation')
    expect(citations).toHaveLength(2)
    expect(citations[0]).toMatchObject({ artifact: 'sop', artifactId: 'sop-1' })
    expect(citations[1]).toMatchObject({ artifact: 'faq', artifactId: 'faq-2' })
  })

  it('captures the optional #section fragment', () => {
    const out = parseCitations('[[cite:sop:abc#early-checkin]] is the rule.')
    const cite = out.find((t) => t.kind === 'citation')
    expect(cite).toMatchObject({
      artifact: 'sop',
      artifactId: 'abc',
      section: 'early-checkin',
    })
  })

  it('passes malformed (unterminated) markers through as plain text', () => {
    const txt = 'weird [[cite:sop:abc without the closing brackets — still text'
    const out = parseCitations(txt)
    expect(out).toEqual([{ kind: 'text', text: txt }])
  })

  it('skips markers with unknown artifact types but preserves surrounding text', () => {
    const out = parseCitations(
      'unknown [[cite:bogus:xyz]] type and a real [[cite:faq:faq-x]] one',
    )
    // The bogus marker is silently dropped from the token stream; only
    // the valid FAQ citation surfaces as a chip. The surrounding text
    // stays readable.
    const citations = out.filter((t) => t.kind === 'citation')
    expect(citations).toHaveLength(1)
    expect(citations[0]).toMatchObject({ artifact: 'faq', artifactId: 'faq-x' })
  })

  it('preserves unicode text around markers', () => {
    const out = parseCitations('日本語 [[cite:sop:id1]] テスト — ok.')
    expect(out[0]).toEqual({ kind: 'text', text: '日本語 ' })
    expect(out.find((t) => t.kind === 'citation')).toMatchObject({
      artifactId: 'id1',
    })
    expect(out[out.length - 1]).toEqual({ kind: 'text', text: ' テスト — ok.' })
  })
})
