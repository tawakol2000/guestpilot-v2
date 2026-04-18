# Data Model — 043-checkin-checkout-actions

## Overview

Five existing models extended, two new models added. All changes are additive + nullable. Applied via `npx prisma db push` per constitution §Development Workflow. No destructive migration.

## Modified: `Property`

Add per-property auto-accept thresholds for time requests.

| Field | Type | Nullable | Default | Purpose |
|---|---|---|---|---|
| `autoAcceptLateCheckoutUntil` | `String?` | ✅ | `null` | HH:MM (24h). If set, the AI auto-approves late-checkout requests at or before this time. `null` = never auto-accept for this property (fall through to tenant default). |
| `autoAcceptEarlyCheckinFrom` | `String?` | ✅ | `null` | HH:MM (24h). If set, the AI auto-approves early-check-in requests at or after this time. `null` = fall through to tenant default. |

## Modified: `Tenant`

Tenant-level defaults for the above thresholds — used when a property's value is null.

| Field | Type | Nullable | Default | Purpose |
|---|---|---|---|---|
| `defaultAutoAcceptLateCheckoutUntil` | `String?` | ✅ | `null` | Fallback when the property's value is null. |
| `defaultAutoAcceptEarlyCheckinFrom` | `String?` | ✅ | `null` | Fallback when the property's value is null. |

**Resolution rule** (implemented in `scheduled-time.service.ts`):
```
effectiveLateCheckoutUntil = property.autoAcceptLateCheckoutUntil
                             ?? tenant.defaultAutoAcceptLateCheckoutUntil
                             ?? null  // null = no auto-accept
```

## Modified: `Reservation`

Add per-reservation time overrides. When set, they represent the *agreed* time for this specific stay; when null, the property-level default applies (via the template-variable resolver).

| Field | Type | Nullable | Default | Purpose |
|---|---|---|---|---|
| `scheduledCheckInAt` | `String?` | ✅ | `null` | HH:MM override of the property's default check-in time for this specific reservation. Written by manager Accept-Send OR auto-accept. |
| `scheduledCheckOutAt` | `String?` | ✅ | `null` | HH:MM override of the property's default check-out time. Same semantics. |

**Semantics of null**: no override agreed; property default applies. When overridden, the Property details card in the inbox renders the override with a "Modified" pill (FR-025).

**No index needed** — these fields are always read via the reservation's primary key.

## Modified: `Task`

Generalize the task record to support typed escalations with per-type structured payload.

| Field | Type | Nullable | Default | Purpose |
|---|---|---|---|---|
| `metadata` | `Json?` | ✅ | `null` | Type-specific payload. For `type='late_checkout_request'` / `'early_checkin_request'`: `{ requestedTime: "HH:MM", kind: "check_in"|"check_out" }`. Other types: additional structured data as needed. |

Existing `type String` column is reused — new values `'late_checkout_request'` and `'early_checkin_request'` join the current values (e.g., `'other'`, `'alteration'`).

## New: `AutomatedReplyTemplate`

Per-tenant, per-(escalationType, decision) editable message templates. System defaults live in code (`backend/src/config/reply-template-defaults.ts`) and are used when the tenant has no row for that combination.

```prisma
model AutomatedReplyTemplate {
  id             String   @id @default(cuid())
  tenantId       String
  escalationType String   // 'late_checkout_request' | 'early_checkin_request' | ...
  decision       String   // 'approve' | 'reject'
  body           String   @db.Text
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, escalationType, decision])
  @@index([tenantId])
}
```

**Variable substitution** (identical syntax to the existing `template-variable.service.ts`):
- `{GUEST_FIRST_NAME}` — resolved from `conversation.guest.name` (first word).
- `{REQUESTED_TIME}` — human-readable form of the HH:MM request (e.g., `13:00` → `1:00 PM`).
- `{PROPERTY_NAME}` — `property.name`.
- `{CHECK_IN_TIME}` / `{CHECK_OUT_TIME}` — resolved from reservation override first, property default second (FR-023).
- Unknown variables render as empty string — never block send (FR-017).

**Default templates** (conceptual — actual copy ships in `config/reply-template-defaults.ts`):

| escalationType | decision | default body |
|---|---|---|
| `late_checkout_request` | `approve` | `Hi {GUEST_FIRST_NAME} — confirmed, you can check out at {REQUESTED_TIME}. Safe travels!` |
| `late_checkout_request` | `reject` | `Hi {GUEST_FIRST_NAME} — unfortunately we're unable to accommodate a late checkout this time. Standard checkout remains {CHECK_OUT_TIME}. Let us know if we can help make your departure smoother.` |
| `early_checkin_request` | `approve` | `Hi {GUEST_FIRST_NAME} — confirmed, you can check in from {REQUESTED_TIME}. Looking forward to hosting you!` |
| `early_checkin_request` | `reject` | `Hi {GUEST_FIRST_NAME} — unfortunately we can't offer an earlier check-in this time. Standard check-in is {CHECK_IN_TIME}. Feel free to drop off luggage if helpful.` |

## New: `TaskActionLog`

Audit log for every manager or auto-accept action taken on a Task. Parallels the existing `AlterationActionLog` model. Gives us immutable history: who approved / rejected which task with what body and when.

```prisma
model TaskActionLog {
  id              String   @id @default(cuid())
  tenantId        String
  taskId          String
  action          String   // 'accepted' | 'rejected' | 'auto_accepted'
  actorKind       String   // 'manager' | 'ai_autoaccept'
  actorUserId     String?  // populated for manager actions (future: when multi-user is added)
  deliveredBody   String   @db.Text
  requestedTime   String?  // HH:MM — for time-request types, echo of what the guest asked for
  appliedTime     String?  // HH:MM — what we actually wrote (accept only)
  createdAt       DateTime @default(now())
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([taskId])
}
```

## AI structured-output schema extension

The coordinator's existing JSON output schema (enforced via OpenAI strict json_schema) gains one optional field:

```json
"scheduledTime": {
  "type": ["object", "null"],
  "properties": {
    "kind": { "type": "string", "enum": ["check_in", "check_out"] },
    "time": { "type": "string", "pattern": "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" }
  },
  "required": ["kind", "time"],
  "additionalProperties": false
}
```

Semantics:
- `null` (or omitted) → no time request detected in this turn; existing escalation path handles the conversation normally.
- `{ kind, time }` → AI parsed a specific time request. The pipeline evaluates policy: if within threshold → auto-accept; else → create a Task with `type='{kind}_request'` and `metadata.requestedTime=time`.

**Backward compatibility**: the field is nullable-optional — existing replay-test JSON responses continue to validate.

## Invariants

- **INV-1**: `Reservation.scheduledCheckInAt` and `scheduledCheckOutAt` are either null or match regex `^([01]?[0-9]|2[0-3]):[0-5][0-9]$`. Enforced at write-time by the scheduled-time service.
- **INV-2**: `AutomatedReplyTemplate` has at most one row per `(tenantId, escalationType, decision)` — enforced by the DB unique index.
- **INV-3**: A resolved (`status='resolved'`) Task cannot be re-accepted or re-rejected. The controller returns 409 Conflict if called on an already-resolved task.
- **INV-4**: `TaskActionLog` rows are never updated or deleted — they are immutable audit records.
- **INV-5**: Auto-accept never creates a `Task` row. The `TaskActionLog` entry with `actorKind='ai_autoaccept'` references no task (`taskId=null` is not allowed — we use a sentinel or a zero-width task). Decision: create a minimal resolved Task in the auto-accept path too, so audit log always points at a task. Avoids null handling and keeps the UI consistent (the auto-accept event appears in the conversation's task history without a pending card — just a record that "AI auto-approved 1pm at 14:23").

Adjusted INV-5: Auto-accept creates a `Task` with `status='resolved'` and immediately logs a `TaskActionLog` pointing at it. The Actions card skips resolved tasks (FR-002 filter), so the manager sees no pending card — but the audit trail is uniform.

## State transitions

### Task lifecycle (for time-request types)

```
(created by AI escalation)
    status='open' ──────────┐
           │                │
           │ manager Accept │ manager Reject
           ▼                ▼
    status='resolved'    status='resolved'
    + reservation       + NO reservation
      updated             update
    + TaskActionLog     + TaskActionLog
      (accepted)          (rejected)

(auto-accept path — no open state exists)
    (created + resolved atomically)
    status='resolved'
    + reservation updated
    + TaskActionLog(auto_accepted)
```

### Reservation scheduled override

```
scheduledCheckOutAt: null  ──(Accept or auto-accept sets it)──▶  scheduledCheckOutAt: 'HH:MM'
                       ◀─────(currently only reset via DB)─────
```

V1 has no UI to clear an override; the only writes come from Accept/auto-accept. Manager manual-override in the UI is out of scope (spec Out of Scope section).
