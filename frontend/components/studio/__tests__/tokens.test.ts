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

  it('inkMuted is approximately #666666 (not the old #52525B from prior spec)', () => {
    // The token file uses #666666 — this test pins the actual value so
    // a rebase that silently changes it surfaces here.
    expect(STUDIO_COLORS.inkMuted).toBe('#666666')
  })

  it('ink is #0A0A0A', () => {
    expect(STUDIO_COLORS.ink).toBe('#0A0A0A')
  })
})
