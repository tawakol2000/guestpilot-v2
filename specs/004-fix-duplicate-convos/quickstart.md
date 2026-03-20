# Quickstart: Fix Duplicate Conversations

**Branch**: `004-fix-duplicate-convos`
**Date**: 2026-03-19

---

## What this fix does

Prevents duplicate conversation entries in the inbox when Hostaway fires `reservation.created` and `message.received` events simultaneously for the same booking. Adds a DB-level uniqueness constraint and hardens the webhook handler against concurrent creation races.

---

## Local Development

```bash
# From project root
cd backend

# Install (if needed)
npm install

# Run migrations (after schema change is applied)
npx prisma migrate dev --name add-conversation-unique-constraint

# Start backend
npm run dev
```

---

## Deployment Sequence (Production)

This fix must be deployed in two steps to avoid a failed migration on existing duplicate data.

### Step 1 — Deploy code changes (no schema migration yet)

Deploy the following code changes to Railway:
- `webhooks.controller.ts` — P2002 handling in `handleNewReservation()`
- `routes/knowledge.ts` — `POST /api/knowledge/dedup-conversations` endpoint

At this point the unique constraint does NOT exist yet. The P2002 handling is a no-op but the cleanup endpoint is live.

### Step 2 — Run the cleanup

```bash
# Call the cleanup endpoint (replace with your actual backend URL and token)
curl -X POST https://guestpilot-v2-production.up.railway.app/api/knowledge/dedup-conversations \
  -H "Authorization: Bearer <your-jwt-token>" \
  -H "Content-Type: application/json"
```

Review the response — it will list all duplicate conversations removed.

### Step 3 — Deploy schema migration

Add the unique constraint to `schema.prisma` and deploy. The migration runs automatically on container start via `npx prisma migrate deploy`.

After this step, duplicate conversations are impossible at the database level.

---

## Verifying the Fix

1. Create a test booking in Hostaway
2. Watch the Railway deploy logs for `[Webhook] ... Reservation X created/updated`
3. Open the inbox — confirm exactly ONE conversation entry for the new guest
4. Send a message as the guest in Hostaway — confirm the message appears in the correct conversation

---

## Checking for Remaining Duplicates

```bash
# Re-run the dedup endpoint — should return duplicatesFound: 0
curl -X POST .../api/knowledge/dedup-conversations \
  -H "Authorization: Bearer <token>"
```
