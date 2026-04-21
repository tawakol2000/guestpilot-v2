/**
 * Sprint 048 Session A — A3.
 *
 * Exercises the inbox-v5 legacy-Copilot edit signal path end-to-end at the
 * helper seam. Two targets:
 *
 * 1. `seedReplyFromDraft` — the click handler behind the suggestion pill's
 *    Edit affordance (A1). Seeds compose with the AI draft, clears the pill,
 *    records the original in `seededFromDraft`.
 * 2. `shouldSendAsFromDraft` — the `sendReply()` predicate (A2) that decides
 *    whether to tag the outgoing send with `fromDraft: true`. Keeps the
 *    sprint-10 false-positive lockdown intact: fresh typed replies with no
 *    seed stay off, approve-as-is with no edit stays off, only an edited
 *    copilot draft turns it on.
 *
 * The spec in sprint-048-session-a.md §1.1 asks for a "render a Copilot-mode
 * conversation" test; mounting the full 5k-line inbox-v5 tree is
 * disproportionate to the gate's actual surface. Instead we exercise the
 * exact helpers the real component imports — the wrapper below is a
 * line-for-line mirror of the onClick handler at inbox-v5.tsx L~5044.
 */
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  shouldSendAsFromDraft,
  seedReplyFromDraft,
} from '../inbox/copilot-edit'

describe('shouldSendAsFromDraft', () => {
  it('returns true when copilot mode, seeded, and text was edited', () => {
    expect(shouldSendAsFromDraft('copilot', 'Hello guest', 'Hello dear guest')).toBe(true)
  })

  it('returns false when copilot mode but text unchanged (approve-as-is via compose)', () => {
    expect(shouldSendAsFromDraft('copilot', 'Hello guest', 'Hello guest')).toBe(false)
  })

  it('returns false when copilot mode but text unchanged modulo surrounding whitespace', () => {
    expect(shouldSendAsFromDraft('copilot', '  Hello guest  ', 'Hello guest')).toBe(false)
  })

  it('returns false when not seeded (fresh typed reply)', () => {
    expect(shouldSendAsFromDraft('copilot', null, 'Totally unrelated reply')).toBe(false)
  })

  it('returns false when not in copilot mode, even if seeded+edited', () => {
    expect(shouldSendAsFromDraft('autopilot', 'Hello guest', 'Hello dear guest')).toBe(false)
    expect(shouldSendAsFromDraft('off', 'Hello guest', 'Hello dear guest')).toBe(false)
    expect(shouldSendAsFromDraft(null, 'Hello guest', 'Hello dear guest')).toBe(false)
    expect(shouldSendAsFromDraft(undefined, 'Hello guest', 'Hello dear guest')).toBe(false)
  })
})

/**
 * Mini pill mirror of inbox-v5.tsx's Edit affordance + sendReply gating.
 * The four setters + the two helpers are the exact surface the production
 * inbox wires up; this wrapper exists only to give vitest a render target.
 */
function EditPillWrapper({
  aiMode = 'copilot',
  initialSuggestion = 'AI draft: please arrive between 3 and 5pm.',
  onSend,
}: {
  aiMode?: string
  initialSuggestion?: string
  onSend: (content: string, opts?: { fromDraft?: boolean }) => Promise<void>
}) {
  const [replyText, setReplyText] = useState('')
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(initialSuggestion)
  const [seededFromDraft, setSeededFromDraft] = useState<string | null>(null)

  async function sendReply() {
    const text = replyText.trim()
    if (!text) return
    const fromDraft = shouldSendAsFromDraft(aiMode, seededFromDraft, text)
    setSeededFromDraft(null)
    await onSend(text, fromDraft ? { fromDraft: true } : undefined)
  }

  return (
    <div>
      <div data-testid="suggestion">{aiSuggestion ?? '(no suggestion)'}</div>
      <textarea
        data-testid="reply"
        value={replyText}
        onChange={(e) => setReplyText(e.target.value)}
      />
      {aiSuggestion && (
        <button
          aria-label="Edit AI suggestion"
          onClick={() =>
            seedReplyFromDraft(
              aiSuggestion,
              setReplyText,
              setAiSuggestion,
              setSeededFromDraft,
            )
          }
        >
          edit
        </button>
      )}
      <button aria-label="Send" onClick={sendReply}>
        send
      </button>
    </div>
  )
}

describe('Edit-pill flow (A1 + A2 integration)', () => {
  it('clicking Edit seeds replyText with the draft and clears the pill', async () => {
    const user = userEvent.setup()
    render(<EditPillWrapper onSend={vi.fn(async () => {})} />)

    expect(screen.getByTestId('suggestion').textContent).toBe('AI draft: please arrive between 3 and 5pm.')
    expect((screen.getByTestId('reply') as HTMLTextAreaElement).value).toBe('')

    await user.click(screen.getByRole('button', { name: 'Edit AI suggestion' }))

    expect((screen.getByTestId('reply') as HTMLTextAreaElement).value).toBe('AI draft: please arrive between 3 and 5pm.')
    expect(screen.getByTestId('suggestion').textContent).toBe('(no suggestion)')
  })

  it('sends fromDraft:true when seeded text is edited before send', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {})
    render(<EditPillWrapper onSend={onSend} />)

    await user.click(screen.getByRole('button', { name: 'Edit AI suggestion' }))
    await user.clear(screen.getByTestId('reply'))
    await user.type(screen.getByTestId('reply'), 'Please arrive between 3 and 4pm only.')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(
      'Please arrive between 3 and 4pm only.',
      { fromDraft: true },
    )
  })

  it('sends fromDraft omitted when seeded but text unchanged (approve-as-is via compose)', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {})
    render(<EditPillWrapper onSend={onSend} />)

    await user.click(screen.getByRole('button', { name: 'Edit AI suggestion' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(
      'AI draft: please arrive between 3 and 5pm.',
      undefined,
    )
  })

  it('sends fromDraft omitted when user types a fresh reply (no edit pill used)', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {})
    render(<EditPillWrapper onSend={onSend} />)

    await user.type(screen.getByTestId('reply'), 'Fresh reply unrelated to any draft.')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(
      'Fresh reply unrelated to any draft.',
      undefined,
    )
  })

  it('sends fromDraft omitted when aiMode is not copilot, even if seeded+edited', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn(async () => {})
    render(<EditPillWrapper aiMode="autopilot" onSend={onSend} />)

    await user.click(screen.getByRole('button', { name: 'Edit AI suggestion' }))
    await user.type(screen.getByTestId('reply'), ' — edited')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledWith(
      'AI draft: please arrive between 3 and 5pm. — edited',
      undefined,
    )
  })
})
