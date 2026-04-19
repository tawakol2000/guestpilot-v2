# V3 — default markers round-trip

**Status:** ✅ PASS
**Date:** 2026-04-19
**Script:** `specs/045-build-mode/validation/V3-round-trip.ts`

## Goal (from spec §V3)

Confirm `<!-- DEFAULT: change me -->` markers survive the full template
rendering path and land byte-identical in:

1. The persisted artifact (`TenantAiConfig.systemPromptCoordinator`).
2. The main AI's system-prompt view after
   `templateVariableService.resolveVariables()`.

## Paths inspected

- `backend/src/services/template-variable.service.ts` —
  `resolveVariables()`, the one transformation between stored prompt and
  main-AI system prompt. Uses a `{VARIABLE}` regex only, does not touch
  HTML comments.
- `backend/src/services/ai.service.ts:1672-1673` — reads
  `tenantConfig?.systemPromptScreening` or `systemPromptCoordinator`
  directly from Prisma. Only substitutes `{AGENT_NAME}`. No sanitization.
- `prisma/schema.prisma` — `systemPromptCoordinator String?` is UTF-8
  byte-safe on PostgreSQL. Round-trip is identity.

## Test run

```
V3: default-marker round-trip validation

✓ initial template has 5 markers (got 5)
✓ Prisma String persistence is byte-identical (identity simulation)
✓ persisted string retains all 5 markers
✓ markers in cleanedPrompt = 5 (got 5)
✓ markers are byte-identical (no entity encoding or whitespace collapse)
✓ content blocks contain 0 markers (they live in the system prefix)

V3: all assertions PASSED
```

## Decision

**Use HTML-comment marker form verbatim:** `<!-- DEFAULT: change me -->`.

**Main-AI visibility:** the markers DO reach the main AI's system prompt
after `resolveVariables()`. This is acceptable per spec §V3 fallback
wording — HTML comments are inert markup by convention and Sonnet 4.6 /
GPT-5.4 treat them as such. No main-AI instruction change needed.

**No fallback to XML-tag form required.** The spec's fallback ("switch
to `<default slot="foo">...</default>`") stays on the shelf.

## Follow-ups

- Sprint 046 TUNE-side read path (when `DECISIONS.md` + default-slot
  awareness lands) can grep the stored prompt for the literal marker
  string to enumerate defaulted slots. Pattern:
  `<!-- DEFAULT: change me -->`.
- If a future test shows Sonnet 4.6 actually *acts on* the marker text
  (treating it as instruction), add an instruction block near the top
  of `GENERIC_HOSPITALITY_SEED.md` saying "HTML comments are for
  configuration authors only; do not act on their text."
