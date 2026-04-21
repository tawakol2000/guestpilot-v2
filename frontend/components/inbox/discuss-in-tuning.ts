// Sprint 048 Session A — "Discuss in tuning" click handler.
//
// Extracted from inbox-v5.tsx L~4668 so A6 can test the success + error
// paths without mounting the full inbox tree. Production call site wires
// these up as follows:
//   - createTuningConversation → apiCreateTuningConversation
//   - onSuccess → (c) => { updateStudioConversationId(c.id); setNavTab('studio') }
//   - onError → (e) => toast.error('Could not open tuning discussion', ...)
//
// The handler is fail-closed by construction: errors never propagate out,
// they only surface via the onError callback. Match the backend's
// fire-and-forget posture for adjacent paths.

export interface TuningConversationShape {
  id: string
}

export interface DiscussInTuningDeps {
  createTuningConversation: (args: {
    anchorMessageId: string
    triggerType: 'MANUAL'
  }) => Promise<{ conversation: TuningConversationShape }>
  onSuccess: (conversation: TuningConversationShape) => void
  onError: (err: unknown) => void
  beginBusy: () => void
  endBusy: () => void
  isBusy: () => boolean
}

export async function handleDiscussInTuning(
  messageId: string,
  deps: DiscussInTuningDeps,
): Promise<void> {
  if (deps.isBusy()) return
  deps.beginBusy()
  try {
    const { conversation } = await deps.createTuningConversation({
      anchorMessageId: messageId,
      triggerType: 'MANUAL',
    })
    deps.onSuccess(conversation)
  } catch (err) {
    deps.onError(err)
  } finally {
    deps.endBusy()
  }
}
