# Feature Suggestions / Suggested Edits — 2026-04-22 → 2026-04-23

> Ideas surfaced during the autonomous bug-fix run. Each entry includes
> rationale + estimated effort + risk. **Do not build without user
> approval.** Review when the user wakes up.

## Format

```
### [Severity-of-impact] Title
**Where:** file path / area
**Idea:** what to build/change
**Why:** the operator-visible win
**Effort:** XS / S / M / L
**Risk:** low / med / high (and why)
**Depends on:** prerequisites if any
```

## Suggestions

### [LOW-impact] Centralize TenantAiConfig save into `buildTenantConfigPatch` helper
**Where:** `frontend/components/configure-ai-v5.tsx` (TenantConfigSection, SystemPromptsSection, ImageHandlingSection)
**Idea:** Each save handler currently passes a hand-curated subset of fields. Extract a `buildTenantConfigPatch(local: TenantAiConfig): Partial<TenantAiConfig>` helper that returns the complete patch shape, OR flip to passing `local` whole and let the server reconcile.
**Why:** Prevents the silent-dropped-field class of bug we already saw twice in this run (`property_ai_changed` no-op, `availableStatuses` write gap). New TenantAiConfig fields will Just Work without remembering to add them to all three section save buttons.
**Effort:** S (~30 min for the helper extraction; or M if we go to whole-object save with server-side ALLOWLIST validation)
**Risk:** low — shrinking the surface area, not expanding it
**Depends on:** none

### [LOW-impact] Add a `WebhookLog` retention sweep job
**Where:** `backend/src/jobs/webhookLogRetention.job.ts` (new)
**Idea:** Daily job mirroring `buildToolCallLogRetention.job.ts`. Default 30-day retention; configurable via env.
**Why:** WebhookLog grows unbounded today. High-volume tenants accumulate hundreds of rows/day. Other log tables already have retention.
**Effort:** XS (10 min — copy buildToolCallLogRetention.job.ts shape)
**Risk:** low (deletion is by-age, not by-content; safe)
**Depends on:** user decision on retention window (30d default sane?)

(Appended as encountered.)

---
