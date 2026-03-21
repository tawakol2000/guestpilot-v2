# AI Post-Implementation Test Checklist: System Audit & Cleanup

**Purpose**: Automated verification after all fixes are deployed — Claude runs these tests via curl + Playwright
**Created**: 2026-03-21
**Feature**: [spec.md](../spec.md)

## Security Tests (curl)

- [ ] CHK001 - Generate JWT for fake tenant → `PATCH /api/conversations/:realConvId { starred: true }` returns 404, not 200 [Spec §SC-001]
- [ ] CHK002 - Generate JWT for fake tenant → `PATCH /api/tasks/:realTaskId { status: "completed" }` returns 404, not 200 [Spec §SC-001]
- [ ] CHK003 - Generate JWT for fake tenant → `DELETE /api/knowledge/suggestions/:realId` returns 404, not 200 [Spec §SC-001]
- [ ] CHK004 - `POST /webhooks/hostaway/:tenantId` WITHOUT Basic Auth when tenant has webhookSecret → returns 401 [Spec §FR-002a]
- [ ] CHK005 - `GET /auth/settings` with valid JWT → returns 200, not 401 [Spec §SC-009]

## API Performance Tests (curl)

- [ ] CHK006 - `GET /api/ai-config` responds in <500ms (measure with `time curl`) [Spec §SC-011]
- [ ] CHK007 - `GET /health` returns 200 with `{"status":"ok"}` [Spec §FR-016]

## Frontend Tests (Playwright)

- [ ] CHK008 - Open Classifier tab → wait 60s → verify tab has NOT changed (SSE reconnection test) [Spec §SC-008]
- [ ] CHK009 - Open Analytics tab → verify AI Resolution Rate is ≤ 100% [Spec §FR-012a]
- [ ] CHK010 - Open Sandbox → set INQUIRY → send "do you have a pool" → verify tool badge appears on response [Spec §SC-010]
- [ ] CHK011 - Open Sandbox → set CONFIRMED → send "can I stay 2 more nights" → verify tool badge appears [Spec §SC-010]
- [ ] CHK012 - All 14 tabs still load without blank screens or JS errors [Regression]

## Startup Tests (Railway logs)

- [ ] CHK013 - Verify Railway deployment succeeded without crashes [Regression]
- [ ] CHK014 - Check logs for `[Server] Database connected` (startup validation working) [Spec §FR-017]
- [ ] CHK015 - Check logs for CORS warning if applicable [Spec §FR-019]

## Debounce Test (live conversation)

- [ ] CHK016 - Send 3 messages 2s apart on a real INQUIRY conversation → verify exactly 1 AI response [Spec §SC-002]

## Notes

- 16 items — all require deployed code to verify
- CHK001-CHK005 are the most critical (security)
- CHK008 requires patience (60s wait for SSE cycle)
- CHK016 requires a live Hostaway conversation
