/**
 * Sprint 058-A F9f — unit tests for the pure auto-naming helpers.
 */
import { describe, it, expect } from 'vitest'
import {
  autoTitleFromFirstMessage,
  autoTitleFromFirstArtifact,
  isDefaultTitle,
  isFirstMessageTooShortForTitle,
} from '../session-autoname'

describe('autoTitleFromFirstMessage (058-A F9f)', () => {
  it('returns null for empty / whitespace input', () => {
    expect(autoTitleFromFirstMessage('')).toBeNull()
    expect(autoTitleFromFirstMessage(null)).toBeNull()
    expect(autoTitleFromFirstMessage(undefined)).toBeNull()
    expect(autoTitleFromFirstMessage('   ')).toBeNull()
  })

  it('capitalises the first letter and strips trailing punctuation', () => {
    expect(autoTitleFromFirstMessage('please review the check-in sop.')).toBe(
      'Please review the check-in sop',
    )
    expect(autoTitleFromFirstMessage('write a cancellation policy!!!')).toBe(
      'Write a cancellation policy',
    )
  })

  it('truncates to 50 chars and appends an ellipsis', () => {
    const input =
      'please look at the check in sop its not great make it better and also tighten the tone'
    const result = autoTitleFromFirstMessage(input)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(50)
    expect(result!.endsWith('…')).toBe(true)
    expect(result!.startsWith('Please look at the check in sop')).toBe(true)
  })

  it('collapses internal whitespace to single spaces', () => {
    expect(autoTitleFromFirstMessage('  rewrite   the  greeting   message  ')).toBe(
      'Rewrite the greeting message',
    )
  })

  it('leaves short already-well-formed messages alone (sans trailing punctuation)', () => {
    expect(autoTitleFromFirstMessage('Fix the late-checkout SOP')).toBe(
      'Fix the late-checkout SOP',
    )
  })

  it('preserves non-leading casing (acronyms, code identifiers)', () => {
    expect(autoTitleFromFirstMessage('edit the FAQ for ABCD units')).toBe(
      'Edit the FAQ for ABCD units',
    )
  })
})

describe('autoTitleFromFirstArtifact (058-A F9f)', () => {
  it('formats a create/sop/name triple into "Create sop · Name"', () => {
    expect(
      autoTitleFromFirstArtifact({
        operation: 'CREATE',
        artifactType: 'SOP',
        artifactName: 'Late check-in handoff',
      }),
    ).toBe('Create sop · Late check-in handoff')
  })

  it('defaults the verb to "Edit" when operation is missing', () => {
    expect(
      autoTitleFromFirstArtifact({
        artifactType: 'FAQ',
        artifactName: 'Pool hours',
      }),
    ).toBe('Edit faq · Pool hours')
  })

  it('truncates long artifact names to 50 chars with an ellipsis', () => {
    const longName = 'x'.repeat(80)
    const result = autoTitleFromFirstArtifact({
      operation: 'UPDATE',
      artifactType: 'SOP',
      artifactName: longName,
    })
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(50)
    expect(result!.endsWith('…')).toBe(true)
  })

  it('returns null when both type and name are missing', () => {
    expect(autoTitleFromFirstArtifact({})).toBeNull()
    expect(autoTitleFromFirstArtifact({ operation: 'CREATE' })).toBeNull()
  })
})

describe('isDefaultTitle (058-A F9f)', () => {
  it('recognises the generic bootstrap titles as default', () => {
    expect(isDefaultTitle('Studio session')).toBe(true)
    expect(isDefaultTitle('Studio — initial setup')).toBe(true)
    expect(isDefaultTitle('Studio - initial setup')).toBe(true)
    expect(isDefaultTitle('Untitled session')).toBe(true)
    expect(isDefaultTitle('')).toBe(true)
    expect(isDefaultTitle(null)).toBe(true)
    expect(isDefaultTitle(undefined)).toBe(true)
    expect(isDefaultTitle('  Studio session  ')).toBe(true)
  })

  it('treats operator-written titles as non-default', () => {
    expect(isDefaultTitle('Fix late-checkout SOP')).toBe(false)
    expect(isDefaultTitle('A')).toBe(false)
  })
})

describe('isFirstMessageTooShortForTitle (058-A F9f)', () => {
  it('flags obvious filler as too short', () => {
    expect(isFirstMessageTooShortForTitle('hi')).toBe(true)
    expect(isFirstMessageTooShortForTitle('test')).toBe(true)
    expect(isFirstMessageTooShortForTitle('ok')).toBe(true)
    expect(isFirstMessageTooShortForTitle('')).toBe(true)
    expect(isFirstMessageTooShortForTitle(null)).toBe(true)
  })

  it('treats substantive first messages as title-worthy', () => {
    expect(
      isFirstMessageTooShortForTitle('Please review the check-in SOP'),
    ).toBe(false)
  })
})
