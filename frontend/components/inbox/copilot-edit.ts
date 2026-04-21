// Sprint 048 Session A — gated diagnostic signal helpers for legacy Copilot.
//
// `shouldSendAsFromDraft` is the pure predicate `sendReply()` consults before
// tagging `{ fromDraft: true }` on `apiSendMessage`. Mirrors the gate the
// backend applies in `messages.controller.ts`: diagnostic fire only when a
// Copilot draft was actually edited, never when a fresh reply was typed.
//
// `seedReplyFromDraft` is the click handler for the edit affordance on the
// suggestion pill. Centralised so the unit test can drive it without mounting
// the full inbox tree.

export function shouldSendAsFromDraft(
  aiMode: string | null | undefined,
  seededFromDraft: string | null,
  sentText: string,
): boolean {
  if (aiMode !== 'copilot') return false
  if (!seededFromDraft) return false
  return sentText.trim() !== seededFromDraft.trim()
}

export function seedReplyFromDraft(
  draft: string,
  setReplyText: (v: string) => void,
  setAiSuggestion: (v: string | null) => void,
  setSeededFromDraft: (v: string | null) => void,
): void {
  setReplyText(draft)
  setAiSuggestion(null)
  setSeededFromDraft(draft)
}
