# Data Model — 042-translation-toggle

## Overview

One new nullable column on the existing `Message` model. No new tables, no enum changes, no relational changes. Applied via `npx prisma db push` per constitution §Development Workflow.

## Modified entity: `Message`

The only schema change this feature makes.

### New field

| Field | Type | Nullable | Default | Purpose |
|---|---|---|---|---|
| `contentTranslationEn` | `String?` (`@db.Text` recommended for long messages) | ✅ | `null` | The English translation of `content` for inbound (`role = GUEST`) messages. Populated lazily on first client request. `null` = not yet translated. |

### Prisma snippet (conceptual — actual patch goes in `backend/prisma/schema.prisma`)

```prisma
model Message {
  // ... existing fields unchanged ...

  // ─── Feature 042: inbound translation cache ───
  // English translation of `content`, computed on first demand by the
  // translate endpoint and persisted here so every client (web + iOS)
  // and every manager sees the same translation without recomputing.
  // Only inbound (role = GUEST) messages are translated; null for
  // outbound/system/AI messages and for untouched inbound messages.
  // If the source is already English, this field is set to the
  // translator's returned value (which equals the source); the client
  // suppresses the translation block on source==translation equality.
  contentTranslationEn String?              @db.Text
}
```

### Semantics of `null`

- **Inbound message (`GUEST`), `null`**: translation has not been computed yet. The next render with translation toggled on will call `POST /api/messages/:id/translate`.
- **Inbound message (`GUEST`), equal to `content` (case-insensitively)**: the source was already in English; the client suppresses the translation block (FR-006).
- **Inbound message (`GUEST`), different from `content`**: the translation. Rendered below the original when translation toggle is on.
- **Outbound message (`HOST`, `AI`, `MANAGER_PRIVATE`, `SYSTEM`)**: always `null`. The endpoint refuses to translate non-`GUEST` messages (HTTP 400).

### Indexing

No new index. Reads happen via the existing `@@index([conversationId, sentAt])` on `Message`. The translate endpoint looks up by primary key (`id`) which is already the default unique index.

### Migration path

- **Forward**: `npx prisma db push` adds the nullable column. No data backfill. Existing rows keep `null`; they translate on first demand.
- **Rollback**: drop the column. The feature is read-only over this field from the application perspective; removing it breaks the translate endpoint only. All other code paths are unaffected.

## Client-side state (not persisted in DB)

| State | Shape | Scope | Storage |
|---|---|---|---|
| Translate toggle on/off | `boolean` per `conversationId` | Per-device, per-conversation, per-browser session | `localStorage` key `gp-translate-on:{conversationId}` → `'1'` or absent (FR-003) |
| In-flight translation requests | `Set<messageId>` | Per-conversation, per-tab | React state in `inbox-v5.tsx` |
| Per-message error state | `Map<messageId, 'failed'>` | Per-conversation, per-tab | React state in `inbox-v5.tsx`; cleared on successful retry |

## Entities in the spec → model mapping

| Spec entity | Persistence | Source of truth |
|---|---|---|
| **Translation Preference** | Client-side `localStorage` | Frontend only; not synced across devices |
| **Message Translation** | `Message.contentTranslationEn` | Server (Prisma). Single row per message; shared across all managers + clients of a tenant. |

## Invariants

- **INV-1**: A `Message` with `role != GUEST` has `contentTranslationEn = null`. Enforced by controller (translate endpoint rejects non-`GUEST` with 400).
- **INV-2**: `contentTranslationEn` is either `null` or a non-empty trimmed string. Enforced by controller (empty provider responses are surfaced as errors, not persisted).
- **INV-3**: `contentTranslationEn` is always tenant-scoped via `Message.tenantId` (Constitution §II). Enforced by every query being `prisma.message.findFirst({ where: { id, tenantId } })`.
