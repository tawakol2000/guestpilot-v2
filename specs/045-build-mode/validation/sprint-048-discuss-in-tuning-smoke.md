# Sprint 048 Session A — Discuss-in-tuning staging smoke

A7 one-liner curl to verify the `POST /api/tuning/conversations`
endpoint for Abdelrahman's tenant after deploy. Code-path audit at
session start came back clean (route exists, controller resolves,
frontend handler wires toast+busy), so the curl serves as the
runtime ground-truth: either the endpoint 201s and the UX polish in
A5 does its job, or it 500s and the toast surfaces the reason.

## The call

Replace `<staging>` with your deployed host and `<real-msg-id>`
with any `Message.id` owned by the caller's tenant (any AI role
message works — the conversation anchor is informational).

```bash
curl -sS -X POST https://<staging>/api/tuning/conversations \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"triggerType":"MANUAL","anchorMessageId":"<real-msg-id>"}'
```

## Expected

- **201** with JSON body `{ "conversation": { "id": "...", ... } }`.
  Frontend: updateStudioConversationId + setNavTab('studio').
- **401** → auth token expired; refresh JWT and retry.
- **4xx** from zod validation → body shape drift; inspect error
  flatten output.
- **500** → backend-side failure; treat as P1 per
  sprint-048-session-a.md §7. The A5 toast-on-error pattern now
  surfaces the error message in the UI, but a 500 on this endpoint
  means the toast-polish work is worthless until the backend is fixed.

## If it 500s

1. Check backend logs for the tenant id + timestamp — the tuning
   chat controller logs errors under `[TuningChat]` prefix.
2. Confirm the `TuningConversation` + `TuningConversationMessage`
   tables exist against the staging DB (`\d tuning_conversation`
   in psql). The sprint-046 stack added them via `prisma db push`.
3. Confirm the anchor `Message.id` resolves to the same tenant as
   the JWT (cross-tenant anchor is a 404, not a 500).

Leave the result of this smoke in this file's "Run log" section
below so the next session doesn't re-run it blind.

## Run log

> Replace this stanza each time the smoke is run.

- **Date:** _not yet run_
- **Environment:** _staging / production_
- **Result:** _201 / 500 / …_
- **Notes:** _any caveats_
