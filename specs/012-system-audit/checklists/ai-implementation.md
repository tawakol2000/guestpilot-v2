# AI Implementation Checklist: System Audit & Cleanup

**Purpose**: Claude's self-check during implementation — verify each fix is correct before moving on
**Created**: 2026-03-21
**Feature**: [spec.md](../spec.md)

## Security Fixes (Phase A)

- [ ] CHK001 - Every `prisma.*.update({ where: { id } })` in conversations.controller.ts now includes `tenantId` in the where clause [Spec §FR-001, lines 75, 448, 488, 520]
- [ ] CHK002 - `prisma.task.update({ where: { id } })` in task.controller.ts now includes `tenantId` [Spec §FR-001, line 115]
- [ ] CHK003 - `prisma.knowledgeSuggestion.update/delete` in knowledge.controller.ts now includes `tenantId` [Spec §FR-001, lines 71, 102]
- [ ] CHK004 - `prisma.automatedMessage.update/delete` in automated-messages.controller.ts now includes `tenantId` [Spec §FR-001, lines 48, 72, 87]
- [ ] CHK005 - Verified NO other update/delete operations across ALL controllers are missing tenantId — full grep completed [Spec §FR-001]
- [ ] CHK006 - Webhook middleware rejects requests without Basic Auth when tenant has webhookSecret configured [Spec §FR-002a]
- [ ] CHK007 - `auth.controller.ts` line 133 changed from `req.user?.tenantId` to `(req as any).tenantId` or equivalent [Spec §FR-010]

## Frontend Bug Fixes (Phase B)

- [ ] CHK008 - SSE event handler in inbox-v5.tsx does NOT modify `navTab` state on reconnection or event receipt [Spec §FR-009]
- [ ] CHK009 - Traced the exact code path where SSE events cause tab switching — not just guessed [Feedback: verify before changing]
- [ ] CHK010 - Analytics resolution rate is capped at 100% or calculation formula is fixed [Spec §FR-012a]

## Backend Fixes (Phase C)

- [ ] CHK011 - Sandbox route passes tools array to createMessage() for INQUIRY (property search) and CONFIRMED (extend-stay) — same pattern as ai.service.ts [Spec §FR-011]
- [ ] CHK012 - Verified sandbox tools actually fire by checking tool_use in response (not just that code exists) [Spec §SC-010]
- [ ] CHK013 - ai-config GET endpoint responds in <500ms after fix (measured, not assumed) [Spec §FR-012, §SC-011]
- [ ] CHK014 - Deprecated `getLastClassifierResult()` removed from rag.service.ts AND no callers remain (grep verified) [Spec §FR-006]
- [ ] CHK015 - Debug URL logging removed from import.service.ts [Spec §FR-007]

## Database (Phase D)

- [ ] CHK016 - `@@index([tenantId, status])` added to Conversation model in schema.prisma [Spec §FR-004]
- [ ] CHK017 - `@@index([tenantId, category])` added to PropertyKnowledgeChunk model [Spec §FR-004]
- [ ] CHK018 - `@@index([tenantId, status])` added to Task model [Spec §FR-004]
- [ ] CHK019 - `npx prisma db push` runs without errors after index additions [Spec §FR-004]

## Frontend Hardening (Phase E)

- [ ] CHK020 - Error boundary component wraps main dashboard content — verified by intentionally throwing in a component [Spec §FR-014]
- [ ] CHK021 - Counted ALL `.catch(() => {})` in frontend before and after — zero remain without user feedback [Spec §FR-013]
- [ ] CHK022 - All icon-only buttons in inbox-v5.tsx have aria-label attributes [Spec §FR-015]

## Infrastructure (Phase F)

- [ ] CHK023 - `GET /health` returns 200 with `{"status":"ok"}` — tested with curl [Spec §FR-016]
- [ ] CHK024 - Server exits with clear error if DATABASE_URL or JWT_SECRET is missing — tested by unsetting each [Spec §FR-017]
- [ ] CHK025 - COHERE_API_KEY documented in .env.example with comment explaining it's optional [Spec §FR-018]
- [ ] CHK026 - CORS warning logged when NODE_ENV=production and CORS_ORIGINS not set [Spec §FR-019]

## Final Verification

- [ ] CHK027 - TypeScript compiles with zero errors (`npx tsc --noEmit`) [Spec §SC-004]
- [ ] CHK028 - No new files created that shouldn't exist — audit is fix-only
- [ ] CHK029 - Every removal was verified with full codebase grep before deleting [Feedback: verify before removing]

## Notes

- 29 items total
- CHK005 and CHK009 are the most critical — they require thorough verification, not just point fixes
- CHK012 and CHK013 require runtime testing, not just code review
