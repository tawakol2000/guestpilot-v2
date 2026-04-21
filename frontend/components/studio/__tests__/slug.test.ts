/**
 * Sprint 052 A C1 — shared slug contract (frontend side).
 *
 * Byte-identical output to `backend/src/build-tune-agent/lib/slug.ts`.
 * The backend regression test in
 * `backend/src/build-tune-agent/__tests__/citation-grammar.test.ts`
 * locks the prompt ↔ slug contract; this suite locks the frontend
 * slug function itself. A mismatch between frontend + backend would
 * silently break B3 citation scroll.
 */
import { describe, it, expect } from 'vitest'
import { slug } from '@/lib/slug'

describe('slug', () => {
  it('lowercases alphanumeric text', () => {
    expect(slug('Hello')).toBe('hello')
    expect(slug('EarlyCheckin')).toBe('earlycheckin')
  })

  it('replaces whitespace runs with a single dash', () => {
    expect(slug('hello world')).toBe('hello-world')
    expect(slug('multiple   spaces')).toBe('multiple-spaces')
  })

  it('collapses runs of non-alphanumeric characters into one dash', () => {
    expect(slug('Early Check-in')).toBe('early-check-in')
    expect(slug('a/b/c')).toBe('a-b-c')
    expect(slug('foo!!!bar')).toBe('foo-bar')
  })

  it('strips leading and trailing dashes', () => {
    expect(slug('---foo---')).toBe('foo')
    expect(slug('  spaces  ')).toBe('spaces')
    expect(slug('__underscore__')).toBe('underscore')
  })

  it('returns empty string for empty or punctuation-only input', () => {
    expect(slug('')).toBe('')
    expect(slug('!!!')).toBe('')
    expect(slug('   ')).toBe('')
    expect(slug('---')).toBe('')
  })

  it('treats unicode non-ascii as non-alphanumeric', () => {
    // The contract is ASCII-only on purpose — headings with diacritics
    // still produce a usable slug, just not a pretty one. Regression-
    // locked so a future "let's preserve unicode" patch has to update
    // the frontend AND backend mirror AND the prompt block.
    expect(slug('café-résumé')).toBe('caf-r-sum')
    expect(slug('naïve')).toBe('na-ve')
  })

  it('matches the backend slug rule for the canonical prompt examples', () => {
    // These two strings are embedded in `<citation_grammar>` as the
    // teaching examples. Keep this pair aligned with the prompt.
    expect(slug('Early Check-in')).toBe('early-check-in')
    expect(slug('Overnight guests?')).toBe('overnight-guests')
  })
})
