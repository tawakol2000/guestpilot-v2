# Quickstart: 029 Inquiry Accept/Reject

## Prerequisites

- Backend running (`cd backend && npm run dev`)
- Frontend running (`cd frontend && npm run dev`)
- Database with at least one tenant with Hostaway credentials
- Access to a Hostaway dashboard account

## Setup Steps

### 1. Apply Schema Changes

```bash
cd backend && npx prisma db push
```

This adds the dashboard connection fields to Tenant and creates the InquiryActionLog model.

### 2. Connect Hostaway Dashboard

1. Log into GuestPilot → Settings
2. Click "Connect Hostaway Dashboard"
3. Follow the bookmarklet instructions:
   - Drag the bookmarklet to your bookmark bar
   - Open `dashboard.hostaway.com` and log in
   - Click the bookmarklet
4. You'll be redirected back to GuestPilot with "Connected" status

### 3. Test Approve/Reject/Cancel

1. Create a test inquiry via the Hostaway booking engine
2. Open the reservation in GuestPilot inbox
3. Click "Approve" in the right panel action block
4. Verify status changes in both GuestPilot and Hostaway dashboard

## Key Files

| Component | File |
|-----------|------|
| Encryption utility | `backend/src/lib/encryption.ts` |
| Dashboard API service | `backend/src/services/hostaway-dashboard.service.ts` |
| Connect routes | `backend/src/routes/hostaway-connect.ts` |
| Reservation action routes | `backend/src/routes/reservations.ts` (extended) |
| Settings UI (connect) | `frontend/components/settings-v5.tsx` (extended) |
| Inbox action buttons | `frontend/components/inbox-v5.tsx` (extended) |

## Environment Variables

No new environment variables required. Uses existing `JWT_SECRET` for token encryption key derivation.
