# Quickstart: Perfect AI Mix

## Prerequisites

- Node.js 18+
- PostgreSQL database (Railway or local)
- OpenAI API key
- Current branch: `037-perfect-ai-mix`

## Setup

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend (separate terminal)
cd frontend && npm install && npm run dev

# Apply schema changes
cd backend && npx prisma db push
```

## Key Files to Modify

| File | What Changes |
|------|-------------|
| `backend/src/services/ai.service.ts` | Schema, prompts, pipeline (MAIN FILE — most changes) |
| `backend/src/services/screening-state.service.ts` | NEW file — code-tracked screening state |
| `backend/src/services/sop.service.ts` | WiFi SOP content, maintenance triage |
| `backend/src/services/template-variable.service.ts` | Register SCREENING_STATE, PRE_COMPUTED_CONTEXT |
| `backend/src/routes/sandbox.ts` | Sandbox parity |
| `backend/prisma/schema.prisma` | showAiReasoning field |
| `frontend/components/inbox-v5.tsx` | Reasoning display |
| `frontend/components/configure-ai-v5.tsx` | Reasoning toggle |
| `frontend/components/sandbox-chat-v5.tsx` | Meta forwarding |
| `frontend/lib/api.ts` | Type updates |

## Testing

```bash
# Run battle test (after deployment)
cd backend && railway run npx ts-node scripts/battle-test/turn.ts turn \
  --conversationId=<id> --message="test message" --jwt=<token>

# Check AI logs
cd backend && railway run npx ts-node scripts/battle-test/turn.ts ailog \
  --conversationId=<id>
```

## Verification Checklist

1. Sandbox: Send "Hi, is parking available?" as INQUIRY → should ask for nationality/composition
2. Sandbox: Send Arabic message → should respond in Egyptian Arabic
3. Sandbox: After screening, send follow-up → should NOT re-screen
4. Sandbox: Send "The AC stopped working" as CHECKED_IN → should escalate as immediate
5. Sandbox: Send "ok thanks" → should produce empty message, no escalation
6. Settings: Toggle showAiReasoning → verify reasoning appears/disappears in inbox
7. AI Logs: Verify ragContext contains derived action, sopStep, screeningPhase
