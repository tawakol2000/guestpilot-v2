# Implementation Plan: Status-Aware SOP Variants

**Branch**: `015-sop-variants` | **Date**: 2026-03-22 | **Spec**: [spec.md](./spec.md)

## Summary

Move SOP content from hardcoded TypeScript into the database with per-tenant ownership, status-specific variants (INQUIRY/CONFIRMED/CHECKED_IN), property-level overrides, and editable tool descriptions. Rebuild the frontend SOP page as a full management interface with inline editing, variant tabs, enable/disable toggles, and a property dropdown.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 18+ (backend), Next.js 16 + React 19 (frontend)
**Primary Dependencies**: OpenAI Node.js SDK, Express 4.x, Prisma ORM
**Storage**: PostgreSQL + Prisma ORM (new SopDefinition + SopVariant models)
**Testing**: Manual verification via sandbox + SOP management page
**Target Platform**: Railway (backend), Vercel (frontend)
**Project Type**: Web service (multi-tenant SaaS)
**Performance Goals**: SOP page loads <2s, content changes take effect <60s
**Constraints**: Classification enum stays at 22. Tool schema regenerated dynamically from DB.
**Scale/Scope**: New Prisma models, rewrite sop.service.ts, rebuild sop-editor-v5.tsx, update ai.service.ts

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Graceful Degradation | PASS | If DB SOPs missing → seed from hardcoded defaults. If variant missing → fall back to default. |
| II. Multi-Tenant Isolation | PASS | All SOP data scoped by tenantId. Property overrides scoped to tenant's properties. |
| III. Guest Safety | PASS | Access codes still gated by reservation status in system prompt — SOP variants don't affect safety. |
| IV. Structured AI Output | PASS | Tool schema regenerated dynamically with strict:true. Same 22-enum constraint. |
| V. Escalate When In Doubt | PASS | Escalation SOPs preserved. Variant system doesn't affect escalation logic. |
| VI. Observability | PASS | ragContext already logs sopCategories. Variant used can be logged additionally. |
| VII. Self-Improvement | PASS | Judge still evaluates classification quality. Variant selection is app-level, not AI-level. |

## Project Structure

### Source Code Changes

```text
backend/
├── prisma/
│   └── schema.prisma                    # ADD: SopDefinition, SopVariant, SopPropertyOverride models
├── src/
│   ├── services/
│   │   ├── sop.service.ts               # REWRITE: load from DB, getSopContent(cat, amenities, status), dynamic tool schema
│   │   └── ai.service.ts                # MODIFY: pass reservationStatus to getSopContent()
│   ├── routes/
│   │   └── knowledge.ts                 # MODIFY: replace sop-data endpoint with full CRUD
│   └── controllers/
│       └── knowledge.controller.ts      # ADD: SOP CRUD methods

frontend/
├── components/
│   └── sop-editor-v5.tsx                # REWRITE: full management page with variant tabs, inline editing
├── lib/
│   └── api.ts                           # ADD: SOP CRUD API functions
```

## Key Implementation Details

### Database Schema

```prisma
model SopDefinition {
  id              String    @id @default(uuid())
  tenantId        String
  category        String    // e.g., "sop-amenity-request"
  toolDescription String    @db.Text  // lean description for AI classification
  enabled         Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  tenant          Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  variants        SopVariant[]
  propertyOverrides SopPropertyOverride[]

  @@unique([tenantId, category])
  @@index([tenantId])
}

model SopVariant {
  id              String    @id @default(uuid())
  sopDefinitionId String
  status          String    // 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN'
  content         String    @db.Text
  enabled         Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  sopDefinition   SopDefinition @relation(fields: [sopDefinitionId], references: [id], onDelete: Cascade)

  @@unique([sopDefinitionId, status])
}

model SopPropertyOverride {
  id              String    @id @default(uuid())
  sopDefinitionId String
  propertyId      String
  status          String    // 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN'
  content         String    @db.Text
  enabled         Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  sopDefinition   SopDefinition @relation(fields: [sopDefinitionId], references: [id], onDelete: Cascade)
  property        Property  @relation(fields: [propertyId], references: [id], onDelete: Cascade)

  @@unique([sopDefinitionId, propertyId, status])
}
```

### SOP Content Resolution Order

```
1. Property override for (category + status) → if exists and enabled, use it
2. Tenant variant for (category + status) → if exists and enabled, use it
3. Tenant default variant for (category + 'DEFAULT') → if exists and enabled, use it
4. Empty string → AI responds from general knowledge
```

### getSopContent() Updated Signature

```typescript
async function getSopContent(
  tenantId: string,
  category: string,
  reservationStatus: string,  // 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN'
  propertyId?: string,
  propertyAmenities?: string,
  prisma?: PrismaClient
): Promise<string>
```

### Dynamic Tool Schema

When tool descriptions change, the SOP_TOOL_DEFINITION is regenerated from DB:

```typescript
async function buildToolDefinition(tenantId: string, prisma: PrismaClient): Promise<any> {
  const sops = await prisma.sopDefinition.findMany({
    where: { tenantId, enabled: true },
    select: { category: true, toolDescription: true },
  });
  // Build the enum + description string from DB data
  // Cache for 5 minutes per tenant
}
```

### SOPs Needing Status Variants (Seed Data)

| SOP | INQUIRY | CONFIRMED | CHECKED_IN |
|-----|---------|-----------|------------|
| sop-amenity-request | Availability only | Ready for arrival | Delivery scheduling |
| sop-early-checkin | Not applicable | Can we arrive early? | Already here |
| sop-late-checkout | Not applicable | Not applicable | Leaving late today |
| sop-cleaning | Not applicable | Not applicable | Schedule cleaning |
| sop-wifi-doorcode | Don't share codes | Share codes | Share codes |
| sop-visitor-policy | Ask about policy | Visitor for stay | Visitor coming now |
| sop-booking-modification | Change before booking | Change dates/unit | Extend current stay |
| pre-arrival-logistics | Not applicable | Coordinate arrival | Already here |

The other 12 SOPs use DEFAULT only (same content for all statuses).
