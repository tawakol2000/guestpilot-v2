# Data Model: 029 Inquiry Accept/Reject

## Schema Changes

### Tenant Model (extend existing)

Add fields to store the encrypted dashboard session token:

| Field | Type | Description |
|-------|------|-------------|
| `dashboardJwt` | `String?` | Encrypted dashboard session token (AES-256-GCM format: `iv:authTag:ciphertext`) |
| `dashboardJwtIssuedAt` | `DateTime?` | When the token was issued (from JWT `iat` claim) |
| `dashboardJwtExpiresAt` | `DateTime?` | When the token expires (from JWT `exp` claim) |
| `dashboardConnectedBy` | `String?` | Email of the user who last connected |

### InquiryActionLog Model (new)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `Int @id @default(autoincrement())` | Primary key |
| `tenantId` | `Int` | Tenant FK |
| `reservationId` | `Int` | Reservation FK |
| `actionType` | `InquiryActionType` | APPROVE, REJECT, CANCEL |
| `initiatedBy` | `String` | Email or name of the user who initiated |
| `status` | `InquiryActionStatus` | PENDING, SUCCESS, FAILED |
| `errorMessage` | `String?` | Error details if failed |
| `hostawayResponse` | `Json?` | Raw Hostaway API response for debugging |
| `createdAt` | `DateTime @default(now())` | Timestamp |

### New Enums

```
enum InquiryActionType {
  APPROVE
  REJECT
  CANCEL
}

enum InquiryActionStatus {
  PENDING
  SUCCESS
  FAILED
}
```

## State Transitions

### Reservation Status (via Hostaway action)

```
inquiry → (approve) → inquiryPreapproved → (guest confirms) → new/confirmed
inquiry → (reject)  → inquiryDenied
pending → (approve) → new/confirmed
pending → (reject)  → declined
any active status → (cancel) → cancelled
```

Note: Status transitions happen on the Hostaway side. GuestPilot syncs the updated status after the action succeeds (via existing reservation sync or by re-fetching the reservation).

### Dashboard Connection Lifecycle

```
disconnected → (user completes bookmarklet flow) → connected
connected → (90 days pass) → expired
connected → (user reconnects) → connected (token overwritten)
connected → (user disconnects) → disconnected
connected → (password change on Hostaway) → invalid (detected on next action attempt)
```

## Relationships

- `Tenant` 1:1 Dashboard Connection (fields on Tenant model)
- `Tenant` 1:N `InquiryActionLog`
- `Reservation` 1:N `InquiryActionLog`
- Most recent `InquiryActionLog` per reservation displayed to users

## Indexes

- `InquiryActionLog`: composite index on `(tenantId, reservationId, createdAt DESC)` for efficient "last action" lookup
