# Implementation Plan: FAQ Knowledge System

**Branch**: `027-faq-knowledge` | **Date**: 2026-04-02 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/027-faq-knowledge/spec.md`

## Summary

Add a per-property and global FAQ system that the AI checks before escalating `info_request`. New `get_faq` tool, new `FaqEntry` Prisma model, auto-suggest pipeline from manager replies using GPT-5 Nano, dedicated FAQs page in the frontend, and Markdown output format for text-heavy tools (SOP + FAQ).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+
**Primary Dependencies**: Express 4.x, Prisma ORM 5.22, OpenAI SDK (gpt-5-nano for auto-suggest classification/extraction)
**Frontend**: Next.js 16 + React 19 + Tailwind 4 + shadcn/ui
**Storage**: PostgreSQL + Prisma ORM (new FaqEntry model)
**Testing**: Manual integration testing
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service + web application
**Performance Goals**: get_faq tool < 500ms, auto-suggest extraction < 5s
**Constraints**: 15 fixed FAQ categories, max ~100 entries per property + 50 global, GPT-5 Nano for lightweight classification
**Scale/Scope**: Multi-tenant, ~100 properties × ~50 FAQs = ~5,000 entries total

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| §I Graceful Degradation | PASS | If get_faq returns empty or fails, AI falls back to info_request escalation — identical to current behavior. Auto-suggest failure is non-fatal (fire-and-forget). |
| §II Multi-Tenant Isolation | PASS | FaqEntry has tenantId. All queries scoped by tenant. Property-level entries scoped by propertyId. |
| §III Guest Safety & Access Control | PASS | FAQ content is manager-approved. No auto-publishing. Access codes should NOT be stored as FAQ entries (already handled by reservation-status gating in the AI prompt). |
| §IV Structured AI Output | PASS | get_faq returns Markdown text, not part of the JSON schema response. The AI's final output still follows the structured JSON schema. |
| §V Escalate When In Doubt | PASS | If get_faq returns no match, the AI escalates as info_request — the FAQ system never suppresses escalation, it only provides answers. |
| §VI Observability by Default | PASS | FAQ usage count tracked per entry. Auto-suggest classification logged. Tool calls logged in AiApiLog. |
| §VII Self-Improvement with Guardrails | PASS | Auto-suggest pipeline has human-in-the-loop (manager approval). Never auto-publishes. Suggestions expire after 4 weeks. |
| Security & Data Protection | PASS | No new public endpoints. FAQ management behind auth middleware. No secrets stored in FAQ entries. |

**Gate Result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/027-faq-knowledge/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── faq-api.md       # FAQ CRUD + management endpoints
│   └── faq-tool.md      # get_faq tool contract
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── prisma/
│   └── schema.prisma                        # MODIFY: add FaqEntry model
├── src/
│   ├── services/
│   │   ├── faq.service.ts                   # NEW: FAQ CRUD, retrieval, usage tracking
│   │   ├── faq-suggest.service.ts           # NEW: auto-suggest pipeline (classify + extract Q&A)
│   │   └── ai.service.ts                    # MODIFY: add get_faq tool handler, switch SOP output to Markdown
│   ├── controllers/
│   │   └── faq.controller.ts                # NEW: FAQ management endpoints
│   ├── routes/
│   │   └── faq.ts                           # NEW: FAQ routes
│   └── app.ts                               # MODIFY: mount FAQ router

frontend/
├── components/
│   ├── faq-v5.tsx                            # NEW: dedicated FAQs page
│   └── inbox-v5.tsx                          # MODIFY: add inline "Save as FAQ?" prompt after info_request replies
├── app/
│   └── (may need new route for FAQs page)
└── lib/
    └── api.ts                                # MODIFY: add FAQ API functions
```

**Structure Decision**: New dedicated service + controller for FAQ (following the pattern of existing services). The auto-suggest pipeline is a separate service since it has its own LLM call. The frontend gets a new top-level page component.

## Key Architecture Decisions

### 1. Separate `get_faq` Tool (Not Merged with `get_sop`)

The AI calls `get_sop` on every message for SOP routing. `get_faq` is only called when the AI is about to escalate `info_request` — different trigger, different frequency. Keeping them separate avoids unnecessary FAQ lookups on 80% of messages.

### 2. Markdown Output for Text-Heavy Tools

```markdown
## FAQ: Local Recommendations

Q: Is there a gym nearby?
A: Yes, O1 Mall has a full gym — 1 minute walk from Building 8. Open 6AM-midnight daily.

Q: What's the nearest pharmacy?
A: Seif Pharmacy, 3 minutes walk from Building 8. Open 24/7.
```

vs current JSON: `{"category":"local-recommendations","content":"..."}`

Markdown scores 60.7% accuracy vs 52.3% JSON on LLM comprehension benchmarks, uses 16-34% fewer tokens.

### 3. Auto-Suggest Pipeline with GPT-5 Nano

```
Manager replies to info_request
  → GPT-5 Nano classifies: REUSABLE | BOOKING_SPECIFIC | ALREADY_EXISTS
  → If REUSABLE: extract clean Q&A pair
  → Create SUGGESTED FaqEntry
  → Show inline "Save as FAQ?" in chat
  → Manager approves/edits/rejects
```

Cost: ~$0.0001 per classification+extraction. At 20 escalations/week: ~$0.01/month.

### 4. Property Override Pattern

Global FAQs (propertyId = null) apply to all properties. Property-specific FAQs override globals on the same category+topic. Resolution: query property entries first, then fill gaps with globals.

### 5. Fixed 15 Categories

Categories are constants, not DB-configurable. This ensures consistent classification, pooled analytics, and instant onboarding. The 15 categories cover 95% of serviced apartment guest questions (validated by industry research).

### 6. Staleness Detection

A scheduled check (or on-demand) marks entries unused for 90 days as STALE. Stale entries remain active (AI can still use them) but are flagged for manager review. Manager can re-activate, update, or archive.

### 7. Inline Chat Suggestion

After a manager replies to an info_request escalation, the frontend shows a card below their message:
```
💡 Save as FAQ?
Q: Is there a gym nearby?
A: Yes, O1 Mall has a full gym — 1 minute walk...
[Approve] [Edit] [Reject]  ○ Global  ● This property
```

This is a frontend-only UI element triggered by an SSE/Socket.IO event from the auto-suggest pipeline.
