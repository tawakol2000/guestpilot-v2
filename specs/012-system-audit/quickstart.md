# Quickstart: System Audit Validation

**Feature**: 012-system-audit
**Date**: 2026-03-21

## Validation Steps

### 1. Tenant Isolation
Generate a JWT for a fake tenant. Try to update a real conversation:
```
PATCH /api/conversations/:realId { starred: true }
```
Expected: 404 (not 200)

### 2. SSE Tab Switching
Open Classifier tab. Wait 60s. If SSE reconnects, verify tab doesn't change.

### 3. Sandbox Tools
- Set INQUIRY, send "do you have a pool" → tool badge should appear
- Set CONFIRMED, send "can I stay 2 more nights" → extend-stay tool should fire

### 4. Auth Settings
```
GET /auth/settings (with valid JWT)
```
Expected: 200 (not 401)

### 5. Health Check
```
GET /health
```
Expected: 200 with `{"status":"ok"}`

### 6. Analytics
Check Analytics tab — AI Resolution Rate should be ≤ 100%
