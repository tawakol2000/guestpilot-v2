# Quickstart: Full System Audit Verification

**Date**: 2026-03-19
**Feature**: 001-system-audit

## Prerequisites

- Node.js 18+
- PostgreSQL with pgvector extension
- Redis (optional — rate limiting falls back to in-memory)
- Backend running: `cd backend && npm run dev`

## 1. Verify Security Headers

```bash
curl -I http://localhost:3000/health
```

Expected headers in response:
- `x-frame-options: SAMEORIGIN`
- `x-content-type-options: nosniff`
- `strict-transport-security: max-age=31536000; includeSubDomains`
- No `x-powered-by` header

## 2. Verify JWT Secret Enforcement

```bash
# Unset JWT_SECRET and start server — should fail
JWT_SECRET="" npm run dev
# Expected: startup error, process exits with non-zero code
```

## 3. Verify Webhook Authentication

```bash
# Without auth — should be rejected (or warned)
curl -X POST http://localhost:3000/webhooks/hostaway/test-tenant-id \
  -H "Content-Type: application/json" \
  -d '{"event":"message.received","data":{}}'

# With valid Basic Auth — should process
curl -X POST http://localhost:3000/webhooks/hostaway/TENANT_ID \
  -u "webhook:WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"event":"message.received","data":{}}'
```

## 4. Verify Rate Limiting

```bash
# Hit login endpoint 6 times rapidly
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}'
done
# Expected: first 5 return 401, 6th returns 429
```

## 5. Verify No Credentials in Logs

```bash
# Trigger an AI reply and check logs
npm run dev 2>&1 | grep -i -E "(doorcode|wifi.*pass|door.*code)"
# Expected: no matches
```

## 6. Verify Embedding Provider Switching

```bash
# In the settings UI or via API:
curl -X PUT http://localhost:3000/api/tenant-config \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"embeddingProvider":"cohere"}'

# Then test classification:
curl -X POST http://localhost:3000/api/knowledge/test-classify \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"can I get extra towels?"}'
# Expected: valid classification result with Cohere embeddings
```

## 7. Verify Database Constraints

```bash
# Connect to PostgreSQL and check constraints
npx prisma studio
# Or via psql:
# \d "PendingAiReply" — should show unique on conversationId
# \d "ClassifierExample" — should show unique on (tenantId, text)
# \di "Message_conv_hostaway_msg_unique" — should exist
# \d "PropertyKnowledgeChunk" — should show embedding_cohere column
```

## 8. Verify No Silent Failures

Trigger a JSON parse failure by temporarily modifying the AI response
(or using the `/api/ai-config/test` endpoint with a malformed prompt).
Verify that an escalation task is created and visible in the dashboard.
