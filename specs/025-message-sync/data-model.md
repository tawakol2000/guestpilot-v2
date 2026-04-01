# Data Model: Hostaway Message Sync

## Schema Changes

### Conversation (MODIFY)

| Field | Type | Change | Purpose |
|-------|------|--------|---------|
| `lastSyncedAt` | `DateTime?` | ADD | Tracks when messages were last fetched from Hostaway. Used by cooldown logic (FR-008: skip if < 30s ago) and background job (sync conversations not synced in > 2 min). |

### Message (MODIFY)

| Field | Type | Change | Purpose |
|-------|------|--------|---------|
| `hostawayMessageId` | `String` (default `""`) | ADD PARTIAL UNIQUE INDEX | Compound unique index on `(conversationId, hostawayMessageId)` WHERE `hostawayMessageId != ''`. Prevents duplicate messages from concurrent webhook + sync. Requires Prisma `partialIndexes` preview feature. |

### No New Models

No new database models are needed. The sync service works entirely with existing `Message`, `Conversation`, and `PendingAiReply` models.

## Entity Relationships (Unchanged)

```
Tenant → Property → Reservation → Conversation → Message
                                              ↘ PendingAiReply
```

## Key Queries

### Sync Service

1. **Get local message IDs for diff**:
   ```
   Message.findMany({ where: { conversationId }, select: { hostawayMessageId: true, role: true, content: true, sentAt: true } })
   ```

2. **Insert synced message**:
   ```
   Message.create({ data: { conversationId, tenantId, role, content, sentAt, channel, hostawayMessageId, imageUrls, communicationType } })
   ```

3. **Update conversation lastSyncedAt**:
   ```
   Conversation.update({ where: { id }, data: { lastSyncedAt: now } })
   ```

4. **Backfill AI message hostawayMessageId** (fuzzy match):
   ```
   Message.update({ where: { id: localAiMessageId }, data: { hostawayMessageId } })
   ```

### Background Job

5. **Find active conversations needing sync**:
   ```
   Conversation.findMany({
     where: {
       status: 'OPEN',
       reservation: { status: { in: ['INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
       lastMessageAt: { gte: now - 24h },
       OR: [
         { lastSyncedAt: null },
         { lastSyncedAt: { lt: now - 2min } }
       ]
     },
     orderBy: { lastSyncedAt: 'asc' },
     take: 5
   })
   ```

### Host-Already-Responded Check

6. **Find latest HOST message after sync**:
   ```
   Message.findFirst({
     where: { conversationId, role: 'HOST' },
     orderBy: { sentAt: 'desc' }
   })
   ```

7. **Cancel pending AI reply**:
   ```
   PendingAiReply.updateMany({
     where: { conversationId, fired: false },
     data: { fired: true, suggestion: null }
   })
   ```

## Indexes

| Index | Fields | Type | Condition |
|-------|--------|------|-----------|
| `Message_conv_hostaway_msg_unique` | `conversationId, hostawayMessageId` | Partial Unique | `hostawayMessageId != ''` |
| Existing: `Message_conversationId_idx` | `conversationId` | Index | — |
| Existing: `Message_tenantId_idx` | `tenantId` | Index | — |

No additional indexes needed. The existing `conversationId` index supports the sync diff query. The `lastSyncedAt` field on Conversation doesn't need its own index — the background job query filters primarily by status and `lastMessageAt` (both already indexed or small cardinality).
