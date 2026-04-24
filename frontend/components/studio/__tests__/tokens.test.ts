/**
 * Sprint 057-A F2 — attributedStyle helper tests.
 *
 * Asserts the colour contract for every TextOrigin value so a future
 * token change causes a clear test failure rather than a silent visual
 * regression.
 */
import { describe, it, expect } from 'vitest'
import { attributedStyle, STUDIO_COLORS } from '../tokens'

describe('attributedStyle', () => {
  it('ai origin returns inkMuted colour', () => {
    expect(attributedStyle('ai')).toEqual({ color: STUDIO_COLORS.inkMuted })
  })

  it('human origin returns ink colour', () => {
    expect(attributedStyle('human')).toEqual({ color: STUDIO_COLORS.ink })
  })

  it('mixed origin returns inkMuted colour (agent portion wins)', () => {
    expect(attributedStyle('mixed')).toEqual({ color: STUDIO_COLORS.inkMuted })
  })

  it('inkMuted is #6b6d76 (Sprint 046 v2 palette)', () => {
    // Sprint 046 — v2 palette migration. The old Studio value was
    // #666666; the new handoff-spec value is #6b6d76 (muted tier).
    expect(STUDIO_COLORS.inkMuted).toBe('#6b6d76')
  })

  it('ink is #0a0a0b (Sprint 046 v2 palette)', () => {
    // Sprint 046 — near-black ink from the handoff palette, swapped
    // from #0A0A0A.
    expect(STUDIO_COLORS.ink).toBe('#0a0a0b')
  })
})
