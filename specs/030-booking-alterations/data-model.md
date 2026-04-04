# Data Model: Booking Alteration Accept/Reject

## New Models

### BookingAlteration

Stores the fetched alteration details for a reservation. Created when the Hostaway alteration system message is detected by the webhook handler.

```prisma
model BookingAlteration {
  id                    String            @id @default(cuid())
  tenantId              String
  reservationId         String            @unique   // one active alteration per reservation
  hostawayAlterationId  String                      // Hostaway's alteration ID (from GET /alterations)

  // Original booking values
  originalCheckIn       DateTime
  originalCheckOut      DateTime
  originalGuestCount    Int

  // Proposed new values
  proposedCheckIn       DateTime
  proposedCheckOut      DateTime
  proposedGuestCount    Int

  status                AlterationStatus  @default(PENDING)
  fetchError            String?           // set if Hostaway detail fetch failed
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt

  tenant                Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  reservation           Reservation       @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  actionLogs            AlterationActionLog[]

  @@index([tenantId])
  @@index([tenantId, reservationId])
}

enum AlterationStatus {
  PENDING
  ACCEPTED
  REJECTED
  EXPIRED
}
```

**Notes**:
- `@unique` on `reservationId` enforces one alteration record per reservation. When a new alteration arrives, upsert on `reservationId` resets status to PENDING.
- `fetchError` is non-null when the Hostaway API call to get alteration details failed. The UI displays a fallback error state in this case.
- `hostawayAlterationId` is required for the accept/reject API calls.

---

### AlterationActionLog

Audit record of every accept or reject action taken by a host. Mirrors the existing `InquiryActionLog` pattern.

```prisma
model AlterationActionLog {
  id                String                @id @default(cuid())
  tenantId          String
  reservationId     String
  alterationId      String
  actionType        AlterationActionType
  status            AlterationActionStatus @default(PENDING)
  initiatedBy       String                // user email from JWT
  errorMessage      String?
  hostawayResponse  Json?
  createdAt         DateTime              @default(now())

  tenant            Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  reservation       Reservation         @relation(fields: [reservationId], references: [id], onDelete: Cascade)
  alteration        BookingAlteration   @relation(fields: [alterationId], references: [id], onDelete: Cascade)

  @@index([tenantId, reservationId, createdAt(sort: Desc)])
}

enum AlterationActionType {
  ACCEPT
  REJECT
}

enum AlterationActionStatus {
  PENDING
  SUCCESS
  FAILED
}
```

---

## Modified Models

### Reservation

Add relation fields for the new models:

```prisma
// Add to Reservation model:
alteration            BookingAlteration?
alterationActionLogs  AlterationActionLog[]
```

### Tenant

Add cascade relations:

```prisma
// Add to Tenant model:
bookingAlterations    BookingAlteration[]
alterationActionLogs  AlterationActionLog[]
```

---

## State Transitions

```
BookingAlteration.status:

  [webhook fires]
       │
       ▼
    PENDING ──── host clicks Accept ──► ACCEPTED
       │
       └──────── host clicks Reject ──► REJECTED
       │
       └──────── channel expires it ──► EXPIRED  (future: set on 422 response)
```

---

## Entity Relationships

```
Tenant
  ├── Reservation
  │     ├── BookingAlteration (0..1)   ← one per reservation
  │     │     └── AlterationActionLog (0..*)
  │     └── (existing) InquiryActionLog
  └── (existing models unchanged)
```
