# Quickstart — 042-translation-toggle

How to verify the feature end-to-end after implementation. Intended for the developer finishing the work and for a reviewer confirming the PR.

## Prerequisites

- Backend running: `cd backend && npm run dev`
- Frontend running: `cd frontend && npm run dev`
- Database: `npx prisma db push` applied after the schema change (adds `Message.contentTranslationEn`).
- A tenant with at least one conversation containing non-English guest messages. (If you don't have one, use Prisma Studio to update any GUEST-role message's `content` to a Spanish or Arabic phrase — e.g., `"¿Puedo hacer el check-in temprano?"`.)

## Golden path (Story 1)

1. Log into the inbox.
2. Open a conversation where the guest wrote in a non-English language.
3. Confirm the Translate button in the conversation header is off (default state). Guest messages render as originals only.
4. Click the Translate button. Expect:
   - Button visually flips to its active state within 200ms (FR-015).
   - For every inbound guest message, the original stays on top and an English translation appears directly below it inside the same bubble, visually de-emphasized (FR-011, FR-012).
   - Translations appear progressively — a 50-message conversation should not block the thread from rendering (FR-016); newest messages should translate first.
5. Click the Translate button again. Expect all translation blocks to disappear; only originals remain.
6. With Translate on, have a new inbound guest message arrive (trigger via a Hostaway webhook in dev, or use Prisma Studio to insert a new `GUEST` message on the conversation and broadcast a Socket.IO event if your dev setup supports it). Expect the new bubble to render with its translation below, automatically (FR-005).

## Caching verification (SC-005)

1. In Conversation A with Translate on, let ~5 messages translate.
2. In a DB client, note the `contentTranslationEn` values on those rows are now populated.
3. Reload the page. Reopen Conversation A. Expect:
   - Toggle is still on (FR-003; `localStorage` key `gp-translate-on:{conversationId}` present).
   - All 5 translations render instantly (served from `Message.contentTranslationEn`, no provider call).
   - Backend logs show `cached=true` for those messages.
4. Open a second browser (or a second manager account on the same tenant). Open the same conversation. Expect the same translations to render instantly from the cache — i.e., the second manager does not re-hit the provider. This proves the server-side share.

## Scope isolation (FR-002)

1. With Translate on for Conversation A, switch to Conversation B (never toggled before).
2. Expect: Conversation B opens with Translate off. Originals only. No translation blocks.

## Already-English message (FR-006)

1. Make sure the conversation has at least one inbound message whose `content` is already English.
2. With Translate on, confirm that bubble renders the original only — no duplicate "Translated" block.
3. In the DB, its `contentTranslationEn` will likely equal `content` after the first call; the client suppresses rendering when they're equal.

## Failure path (FR-008)

Easiest way to force an error during dev:
- Temporarily edit `backend/src/services/translation.service.ts` to throw on one specific message id, OR
- Disconnect from the internet and trigger a translation of a message whose `contentTranslationEn` is still `null`.

Expect:
- The affected bubble renders the original normally.
- A small inline chip appears below it: "Translation unavailable — retry".
- Clicking retry re-calls the endpoint.
- The rest of the conversation is unaffected — other messages still render and translate (FR-007).

## Constitution gates (sanity checks)

- **§I Graceful degradation**: Turn Translate off, send a normal reply in the conversation — the main messaging flow is unaffected. Take the translation endpoint offline (stop backend's network briefly) — the inbox stays usable; only translation retry chips appear.
- **§II Multi-tenant isolation**: With a JWT from Tenant A, attempt `POST /api/messages/<id-from-tenant-B>/translate`. Expect 404 (not 200, not 500).
- **§III Guest safety**: Confirm the guest side (Hostaway / Airbnb) never sees a translated message — translations are only shown in our inbox UI.

## Send path unchanged (FR-010)

1. With Translate on, type "ok, no problem" in the composer and send.
2. Open the outbound bubble. Expect: the message delivered to the guest is exactly `"ok, no problem"` — no AI rewriting, no language swap. The Airbnb/Booking side auto-translates for the guest.
3. With Translate off, send another reply. Same behavior.

## What NOT to verify in this feature

- The existing `translateAndSend` controller (`POST /api/conversations/:id/messages/translate`) composes an AI translation for outbound. It is orthogonal and is not wired to the Translate toggle by this feature. Don't test it as part of this PR.
