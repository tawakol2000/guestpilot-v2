# Phase 0 Research — 042-translation-toggle

All four clarifications from `/speckit.clarify` already resolved the major unknowns (storage location, render pattern, provider strategy, outbound scope). This phase consolidates those decisions with their rationale + rejected alternatives, and adds small research items that came up during planning (lazy vs eager backfill, concurrency cap, error-state UX).

---

## Decision 1 — Translation storage location

**Decision**: Add a nullable `contentTranslationEn String?` column directly on the existing `Message` Prisma model. Populated lazily on first request. Shared across web + iOS, all managers on a tenant, all future sessions.

**Rationale**:
- Mirrors the Airbnb / Messenger / Booking.com pattern: translate once, cache server-side, every client (every manager, every device, iOS + web) sees the identical cached translation without recomputing.
- Plays cleanly with the project's existing convention of attaching derived/computed fields directly to `Message` — see `compactedContent`, `originalAiText`, `editMagnitudeScore`, `confidenceScore` already on the same model. Adding one more nullable column is the least disruptive schema change.
- Survives server restarts (a pure in-memory cache would not; Redis would but would require wiring the optional Redis path per Constitution §I).
- Automatically multi-tenant scoped: `Message.tenantId` already exists, no extra indexing needed.

**Alternatives considered & rejected**:
- *Redis / server-ephemeral cache*: shared across managers but lost on restart; iOS app can't read it; would require wiring through the optional-Redis code path.
- *Client-side localStorage only*: easiest to ship, but does not help the iOS app, does not share across managers on the same tenant, and means every manager re-hits the provider for every message they open.
- *Separate `MessageTranslation` table keyed `(messageId, targetLang)`*: more flexible for future multi-target languages, but premature. Spec explicitly scopes launch to English-only. Can migrate to a side table later by backfilling if multi-target is needed.

**Impact on schema**: one new nullable column, no migration of existing rows needed. `null` semantics: "not yet translated OR the source is already English and was skipped" (see Decision 5).

---

## Decision 2 — Render pattern (inline stacked, always visible)

**Decision**: When the Translate toggle is on, each inbound (`GUEST` role) bubble renders the original text followed by a subtle divider / label and the English translation directly below — both always visible, no click-to-expand.

**Rationale**:
- Matches what Airbnb, Messenger, and Booking.com do. Managers can scan both quickly; if the translation is off (e.g., mistranslated slang), the original is right there.
- No interaction cost per message, which matters when opening a long conversation (SC-004: "does not degrade perceived responsiveness").
- Keeps the bubble as the single unit of meaning — no separate translation UI to track.

**Alternatives considered & rejected**:
- *Click-to-reveal per message*: adds friction; the whole point of toggling translation on is that you want to read everything at once.
- *Replace original with translation*: loses the source text. Violates FR-014 ("UI MUST NOT hide or replace the original text").
- *Side-by-side columns*: breaks on narrow screens / iOS; bubble widths are already constrained.

**Visual treatment** (to be finalized during implementation, not requiring further research):
- Divider: a thin horizontal rule or small "Translated" label in `T.text.tertiary`.
- Translation text: same font family, slightly smaller (or same size with lighter weight / lower opacity), italic optional.
- Keeps the existing bubble background; does not expand the bubble beyond natural content height.

---

## Decision 3 — Provider strategy

**Decision**: Keep the existing unofficial Google Translate endpoint (`translate.googleapis.com/translate_a/single?client=gtx`) at launch, but wrap it behind a `TranslationProvider` interface in a new `backend/src/services/translation.service.ts`. The controller depends only on the interface.

**Rationale**:
- Translation *quality* is identical to Google Cloud Translation API (same underlying model).
- With server-side caching (Decision 1), each message is translated exactly once in its lifetime — provider volume is very low, so the free endpoint's rate limits are unlikely to be hit in practice.
- The abstraction makes a provider swap a one-file change if we do hit rate limits or want to clean up the ToS posture. Mirrors the project's pattern of isolating external integrations (e.g., `hostaway.service.ts`).

**Alternatives considered & rejected**:
- *Switch to official Google Cloud Translation now*: paid, requires setup of `GOOGLE_TRANSLATE_API_KEY` and billing, zero quality improvement, and per-message cost is negligible anyway given the cache. Deferred until there's a reason.
- *Use gpt-5-nano via OpenAI*: would reuse existing OpenAI infra but is 10–100× more expensive per call than a dedicated translation API, and quality on short transactional messages is not meaningfully better. Rejected on cost.
- *DeepL*: arguably better quality for European languages; worse coverage for Arabic (which is a top language for GuestPilot). Rejected on language coverage.

**Shape of the interface**:

```ts
export interface TranslationProvider {
  translate(
    text: string,
    opts: { targetLang: 'en' }
  ): Promise<{ translated: string; detectedSourceLang?: string }>;
}

export class GoogleFreeTranslationProvider implements TranslationProvider { /* ... */ }

export const translationService: TranslationProvider = new GoogleFreeTranslationProvider();
```

Swapping the provider later = change the last line only.

---

## Decision 4 — No outbound translation (send path unchanged)

**Decision**: The Translate toggle does not alter the send path at all. Manager-typed replies go out verbatim whether the toggle is on or off. The existing `translateAndSend` controller (which composes a translated reply via the `managerTranslator` AI persona) stays in the codebase but is not wired to this toggle and is not exercised by this feature.

**Rationale**:
- Airbnb and Booking.com auto-translate both directions on the guest's side — guests see replies in their language regardless of what the host typed. WhatsApp users have in-app translation (Android native; iOS via third-party).
- Doing outbound translation on our side would be redundant, carries risk (AI rewriting short messages into paragraphs — see the clarification Q4 example), and roughly doubles the feature's surface area.
- Keeps Story 2 out of scope; reduces Constitution §I exposure (no additional AI call in the critical send path).

**Alternatives considered & rejected**:
- *Translate outbound with preview*: closer to what the existing `translateAndSend` endpoint does, but requires a preview/edit UX that the spec explicitly puts out of scope.
- *Silent outbound translation*: the confusing variant — manager types English, a paragraph goes out in Spanish without visibility. Rejected as a trust/auditability hazard.

**Codebase implication**: `backend/src/controllers/messages.controller.ts::translateAndSend` and its route `POST /api/conversations/:id/messages/translate` are left in place but orphaned from the UI. A future cleanup task can remove them if they stay unused; not part of this feature's scope.

---

## Decision 5 — Already-English messages (skip translation)

**Decision**: When the provider returns a translation equal (case-insensitively, after trim) to the source, persist the source unchanged as `contentTranslationEn = content` **and** mark the message as "no translation block needed" via a sentinel check on the client. Alternative: persist `null` and add a second boolean column `translationChecked`.

**Chosen sentinel**: Persist `contentTranslationEn` with the translated value whenever the provider successfully returns. On the client, when rendering the translation block, skip rendering if `message.contentTranslationEn?.trim().toLowerCase() === message.content.trim().toLowerCase()`. This keeps the schema to a single column and is self-healing if a source gets edited.

**Rationale**:
- Avoids a second "translationChecked" column.
- Handles the mixed-language thread case (FR-006) without server-side language detection.
- Free Google endpoint returns the source text unchanged when `sl=auto&tl=en` and the detected language is already English, so the equality check reliably fires.

**Alternatives considered & rejected**:
- *Server-side language detection before calling provider*: adds a dependency (fast-lang-detect or similar), saves ~0 provider calls in practice since the cache already covers the second visit.
- *Boolean `translationSameAsSource`*: extra column for minor benefit.

---

## Decision 6 — Concurrency cap for initial backfill

**Decision**: When the user first flips the toggle on for a conversation with N untranslated inbound messages, the frontend issues translation requests with a concurrency cap of 4 in-flight. Ordering: render already-translated messages instantly; for the rest, prioritize the most recent visible messages first, then older.

**Rationale**:
- A fresh conversation with 150 non-English messages would otherwise fire 150 parallel requests and risk tripping the free Google endpoint's per-IP rate limit.
- 4 is a reasonable default — low enough to be gentle, high enough that a visible viewport (usually 5–10 messages) fills in within a second or two.
- Prioritizing newest-first matches manager reading behavior (they scroll from bottom).

**Alternatives considered & rejected**:
- *Serial (1-at-a-time)*: too slow for a 50-message conversation — takes 15+ seconds to finish.
- *Batch endpoint* (`POST /api/messages/translate` with an array of ids): nice optimization, but adds complexity and the 4-parallel pattern is sufficient for expected volumes. Deferred.
- *Unbounded*: risk of 429s from Google's free endpoint.

---

## Decision 7 — Error-state UX per message

**Decision**: If a translate call fails (network, provider error, rate limit), the bubble shows the original text normally and a small inline chip below it reading "Translation unavailable — retry" with a click-to-retry action. The main conversation remains fully readable; the error is scoped to that one message.

**Rationale**:
- Satisfies FR-007 (one failure must not block other messages) and FR-008 (inline, non-blocking, retryable).
- Matches existing inbox patterns for failed sends (`deliveryStatus === 'failed'` chip on host bubbles).

**Retry behavior**: click re-calls the same endpoint. On success, the chip is replaced by the translation. No exponential backoff client-side — managers retry manually. If retries become a pain point post-launch, add a silent one-shot retry on transient failures; not worth building now.

---

## Decision 8 — Toggle persistence (per-conversation, per-device)

**Decision**: Persist the toggle state in `localStorage` under the key `gp-translate-on:{conversationId}`. Value: `'1'` or absent. Read on conversation open; write on toggle click.

**Rationale**:
- Spec says persist across page reloads on the same device (FR-003), not across devices — no server-side sync required.
- `localStorage` is the existing pattern in the inbox (see `sessionStorage.getItem('gp-nav-tab', tab)` for nav state; same style).
- Keyed per-conversation so enabling translation on one does not bleed into another (FR-002).

**Alternatives considered & rejected**:
- *Server-side per-manager preference*: cross-device sync not required by spec; would need a new Prisma model and an API.
- *Global toggle for all conversations*: simpler but violates FR-002.

---

## Unknowns remaining

None. All `NEEDS CLARIFICATION` from the spec template were resolved in `/speckit.clarify`. All research items above are resolved. Phase 1 can proceed.
