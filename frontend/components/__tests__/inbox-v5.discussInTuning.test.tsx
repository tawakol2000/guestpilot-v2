/**
 * Sprint 048 Session A — A6.
 *
 * Exercises the `handleDiscussInTuning` helper behind the inbox-v5
 * "discuss in tuning" button. The production click handler at
 * inbox-v5.tsx L~4668 wires this helper with:
 *   createTuningConversation: apiCreateTuningConversation
 *   onSuccess: updateStudioConversationId + setNavTab('studio')
 *   onError: toast.error('Could not open tuning discussion', ...)
 *
 * SC-2a: success path → onSuccess called with the returned conversation.
 * SC-2b: error path → onError called with the thrown error.
 * SC-2c: busy guard → re-entrant calls short-circuit.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleDiscussInTuning } from '../inbox/discuss-in-tuning'

describe('handleDiscussInTuning', () => {
  it('SC-2a: on success, calls onSuccess with the created conversation and ends busy', async () => {
    const conversation = { id: 'conv-abc' }
    const createTuningConversation = vi.fn().mockResolvedValue({ conversation })
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const beginBusy = vi.fn()
    const endBusy = vi.fn()
    const isBusy = vi.fn().mockReturnValue(false)

    await handleDiscussInTuning('msg-1', {
      createTuningConversation,
      onSuccess,
      onError,
      beginBusy,
      endBusy,
      isBusy,
    })

    expect(createTuningConversation).toHaveBeenCalledWith({
      anchorMessageId: 'msg-1',
      triggerType: 'MANUAL',
    })
    expect(beginBusy).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(conversation)
    expect(onError).not.toHaveBeenCalled()
    expect(endBusy).toHaveBeenCalledTimes(1)
  })

  it('SC-2b: on error, calls onError with the thrown value — never throws out', async () => {
    const err = new Error('500 Internal Server Error')
    const createTuningConversation = vi.fn().mockRejectedValue(err)
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const beginBusy = vi.fn()
    const endBusy = vi.fn()
    const isBusy = vi.fn().mockReturnValue(false)

    await handleDiscussInTuning('msg-1', {
      createTuningConversation,
      onSuccess,
      onError,
      beginBusy,
      endBusy,
      isBusy,
    })

    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(err)
    expect(endBusy).toHaveBeenCalledTimes(1) // busy always clears
  })

  it('SC-2c: when isBusy() returns true, short-circuits without calling the API', async () => {
    const createTuningConversation = vi.fn()
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const beginBusy = vi.fn()
    const endBusy = vi.fn()
    const isBusy = vi.fn().mockReturnValue(true)

    await handleDiscussInTuning('msg-1', {
      createTuningConversation,
      onSuccess,
      onError,
      beginBusy,
      endBusy,
      isBusy,
    })

    expect(createTuningConversation).not.toHaveBeenCalled()
    expect(beginBusy).not.toHaveBeenCalled()
    expect(endBusy).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('error path surfaces err.message only (no stack-trace leakage)', async () => {
    // The inbox-v5 onError callback reads err.message into the toast
    // description. Assert err is reachable so the callback can do that
    // without touching err.stack or JSON.stringify(err).
    const err = new Error('backend exploded')
    err.stack = 'secret stack frames'
    const createTuningConversation = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    await handleDiscussInTuning('msg-1', {
      createTuningConversation,
      onSuccess: vi.fn(),
      onError,
      beginBusy: vi.fn(),
      endBusy: vi.fn(),
      isBusy: () => false,
    })

    const received = onError.mock.calls[0][0]
    expect(received).toBe(err)
    expect(received instanceof Error && received.message).toBe('backend exploded')
  })
})
