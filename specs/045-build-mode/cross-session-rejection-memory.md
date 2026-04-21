# Cross-session rejection memory — design doc

> Sprint 047 Session C deliverable. Companion to the session-scoped
> rejection memory shipped in sprint 046 Session D (plan §4.4).
>
> Scope: a fix rejected in conversation A is detectably suppressed
> (or surfaced with a prior-rejection advisory) when proposed again
> in conversation B, same tenant, within the TTL.

---

## 1. Problem

The session-scoped memory at
`session/{conversationId}/rejected/{fixHash}` stops the agent from
re-proposing a fix the manager just dismissed — but only within a
single conversation. Open a fresh conversation and the same
semantically-equivalent suggestion re-appears, fully re-armed.

Managers experience this as "the agent doesn't remember," which
erodes trust in the whole suggestion stream. We need durable memory
that survives a new conversation while still decaying eventually
(nothing is forever — the underlying artifact evolves, and a
rejection from six months ago shouldn't block a genuinely-improved
fix).

## 2. Decisions

| Dimension        | Decision                                          | Reasoning                                                                                                                                                                  |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cardinality**  | per-(tenantId, artifact, fixHash)                 | Mirrors the session-scoped shape exactly, just lifted to durable storage. Finer-grained than tenant-only; a single bad rejection doesn't poison future suggestions at a different target.            |
| **TTL**          | 90 days, stamped at write time into `expiresAt`   | Matches the `BuildToolCallLog` retention window so a later sweep job reuses the same mental model. "Never decay" risks stale rejections blocking genuinely-improved fixes. |
| **Storage**      | Dedicated `RejectionMemory` Prisma table          | Clean FK cascade on `Tenant` delete, indexed columns for the lookup path, owns its own retention sweep later. `AgentMemory` key-prefix reuse would have muddled the shape. |
| **Agent signal** | `SKIPPED_PRIOR_REJECTION` with rationale          | The agent learns *why* the fix was hated, when a rationale was captured. Missing rationale → "weak signal, avoid exact re-propose without new context."                    |
| **Degradation**  | Lookup errors fall through to emit                | `NEXT.md §3`: missing memory ≠ no-suggestion. A DB blip must not hard-silence future suggestions.                                                                          |

## 3. Schema (Prisma)

```prisma
model RejectionMemory {
  id                   String   @id @default(cuid())
  tenantId             String
  artifact             String   // FixTarget.artifact — 'sop' | 'faq' | 'system_prompt' | 'tool_definition' | 'property_override' | '' when untargeted
  fixHash              String
  artifactId           String   @default("")
  sectionOrSlotKey     String   @default("")
  semanticIntent       String
  rationale            String?  @db.Text
  category             String?
  subLabel             String?
  sourceConversationId String?
  rejectedAt           DateTime @default(now())
  expiresAt            DateTime

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, artifact, fixHash])
  @@index([tenantId, expiresAt])
  @@index([tenantId, artifact, fixHash, expiresAt])
}
```

`fixHash` is computed via the existing `computeRejectionFixHash`:
`sha1(artifactId | sectionOrSlotKey | semanticIntent)`. `artifact`
(the FixTarget type enum) is added to the composite key so that
semantically-overlapping rejections on different artifact *types*
(e.g. an SOP vs a system-prompt rewrite that happen to hash alike)
don't shadow each other.

Applied via `prisma db push` per project constitution.

## 4. Write path

`POST /api/build/suggested-fix/:fixId/reject` now writes **both**:

1. The session-scoped `AgentMemory` upsert under
   `session/{conversationId}/rejected/{fixHash}` (unchanged — still
   drives the same-conversation skip).
2. A durable `RejectionMemory` upsert keyed on
   `(tenantId, artifact, fixHash)`.

The durable write is best-effort — any failure logs a warning and
the response still succeeds. Missing cross-session memory is less
bad than a dropped session-scoped rejection (which would let the
agent re-propose seconds later in the same conversation).

Re-rejecting the same fix in a later conversation **refreshes**
`rejectedAt` + `expiresAt` — manager frustration compounds, so
extending the silence window is the intended behaviour. The new
`rationale` / `sourceConversationId` also overwrite the previous
values so the most recent context is what the agent sees on the
next proposal.

## 5. Read path

`propose_suggestion` consults the durable layer **after** the
session-scoped `listRejectionHashes` check:

```
session hit  → SKIPPED_REJECTED
  ↓  (miss)
durable hit  → SKIPPED_PRIOR_REJECTION
  ↓  (miss)
emit data-suggested-fix + return PREVIEWED
```

A durable hit returns a `skipPayload` with:

- `status: 'SKIPPED_PRIOR_REJECTION'`
- `priorRejection.{rejectedAt, expiresAt, sourceConversationId, rationale, category, subLabel}`
- `hint` — human-readable guidance differentiated by rationale
  presence. With rationale: quoted back to the agent verbatim.
  Without: "treat as a weak signal, avoid exact re-propose."

The agent sees this as a tool result and can react on the next
turn — typically by proposing a different target, rephrasing the
intent, or asking the manager whether the prior objection still
stands.

## 6. Alternatives considered

**`AgentMemory` with a `durable/` prefix.** Simpler — no new table,
no new back-relation. Rejected because the read path would need a
`findMany` + scan (AgentMemory has no per-row TTL column), and the
retention sweep would be a string-matching mess instead of an
indexed range query.

**Per-tenant only.** Coarser — one bad rejection would suppress
every future proposal on that tenant. Rejected because the failure
mode is silently losing useful suggestions, which is harder to
debug than "the agent re-proposed something I already said no to."

**Per-(tenant, artifact, sectionOrSlot).** Finer — different
sections of the same artifact keyed independently. Rejected because
`fixHash` already incorporates `sectionOrSlotKey` via the SHA-1
input, so we'd be denormalising without additional selectivity.

**30d TTL** (matches `BuildToolCallLog`). Reasonable, but 90d gives
a genuine quarter of suppression on a stable rejection — long
enough to feel durable, short enough that a reworked artifact gets
a fresh chance. If production telemetry shows 30–90d rejections are
rarely re-attempted, the TTL can be shortened without a schema
migration (it's a write-time stamp, not a column default).

**Block the response on durable-write failure.** Safer in theory,
but in practice the session-scoped write is the load-bearing path
(next-tick suppression). A 500 on the reject endpoint because the
durable DB flickered would feel worse than a silent fallback.

## 7. Open questions for a later sprint

- **Retention sweep.** Row-count pressure is low (one row per
  unique rejection per tenant), so the sweep is not urgent. When
  it lands, mirror `build-tool-call-log-retention.job.ts`: daily
  at 03:00 UTC, batched `WHERE expiresAt < now()` deletes.
- **Manager-visible "cleared rejections" UI.** If a rejection
  becomes stale ("that was the old SOP, propose again"), the
  manager has no way to clear it short of letting 90d expire.
  Product decision — defer until operators ask.
- **Rationale prompt in the reject card.** The schema captures
  `rationale`, but the Studio reject button currently sends `null`.
  A future UI change can add an optional free-text field; the
  backend already round-trips it.

## 8. Success criteria (from NEXT.md §5)

- **SC-1** ✅ A fix rejected in conversation A is suppressed or
  advisory-surfaced when proposed in conversation B, same tenant,
  within the TTL. Verified by the integration-test case 6b in
  `build-controller.integration.test.ts`.
- **SC-2** ✅ This document.

End of design doc.
