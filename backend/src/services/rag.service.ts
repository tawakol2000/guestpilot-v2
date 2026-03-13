/**
 * RAG (Retrieval-Augmented Generation) service.
 * Ingests property knowledge as vector chunks and retrieves relevant context.
 * Grounds AI responses in verified property data — prevents hallucination.
 *
 * Note: The `embedding` vector column is NOT in the Prisma schema (pgvector
 * requires raw SQL). Use $executeRaw / $queryRaw for all embedding operations.
 */
import { PrismaClient } from '@prisma/client';
import { embedText, embedBatch } from './embeddings.service';

function generateId(): string {
  // Simple cuid-like ID without external dependency
  return `ck${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

// Cache pgvector availability per process lifetime
let _pgvectorAvailable: boolean | null = null;

async function isPgvectorAvailable(prisma: PrismaClient): Promise<boolean> {
  if (_pgvectorAvailable !== null) return _pgvectorAvailable;
  try {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM information_schema.columns
      WHERE table_name = 'PropertyKnowledgeChunk' AND column_name = 'embedding'
    `;
    _pgvectorAvailable = Number(rows[0]?.count ?? 0) > 0;
  } catch {
    _pgvectorAvailable = false;
  }
  if (!_pgvectorAvailable) {
    console.warn('[RAG] embedding column not found — vector search unavailable (run add_pgvector.sql to enable)');
  }
  return _pgvectorAvailable;
}

function inferCategory(key: string): string {
  const k = key.toLowerCase();
  if (/wifi|password|network|internet/.test(k)) return 'access';
  if (/door|code|entry|key|lock/.test(k)) return 'access';
  if (/clean|cleaning|housekeeping/.test(k)) return 'service';
  if (/check.?in|check.?out|arrival|departure/.test(k)) return 'policy';
  if (/pool|gym|amenity|parking|spa/.test(k)) return 'amenity';
  if (/contact|phone|emergency|support/.test(k)) return 'contact';
  return 'general';
}

export async function ingestPropertyKnowledge(
  tenantId: string,
  propertyId: string,
  property: { customKnowledgeBase?: unknown; listingDescription?: string },
  prisma: PrismaClient
): Promise<number> {
  // 1. Delete all existing chunks for this property (clean slate)
  await prisma.$executeRaw`
    DELETE FROM "PropertyKnowledgeChunk"
    WHERE "propertyId" = ${propertyId} AND "tenantId" = ${tenantId}
  `;

  const chunks: { content: string; category: string; sourceKey: string }[] = [];

  // 2a. Build chunks from customKnowledgeBase key-value pairs
  const customKb = property.customKnowledgeBase as Record<string, unknown> | null;
  if (customKb && typeof customKb === 'object') {
    for (const [key, val] of Object.entries(customKb)) {
      const strVal = String(val ?? '').trim();
      if (!strVal || strVal === 'N/A' || strVal === 'null') continue;
      chunks.push({
        content: `Q: What is the ${key}?\nA: ${strVal}`,
        category: inferCategory(key),
        sourceKey: key,
      });
    }
  }

  // 2b. Chunk listingDescription by paragraph
  if (property.listingDescription) {
    const paragraphs = property.listingDescription
      .split(/\n\n|\.\n/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length >= 50);
    for (const para of paragraphs) {
      chunks.push({ content: para, category: 'description', sourceKey: 'listing_description' });
    }
  }

  if (chunks.length === 0) return 0;

  const vectorEnabled = await isPgvectorAvailable(prisma);

  // 3. Embed all chunks in batches (only if vector column exists)
  let embeddings: number[][] = [];
  if (vectorEnabled) {
    try {
      embeddings = await embedBatch(chunks.map(c => c.content));
    } catch (err) {
      console.warn('[RAG] embedBatch failed:', err);
    }
  }

  // 4. Insert each chunk with or without embedding
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const id = generateId();
    const embedding = embeddings[i];

    try {
      if (vectorEnabled && embedding && embedding.length > 0) {
        const embeddingStr = `[${embedding.join(',')}]`;
        await prisma.$executeRaw`
          INSERT INTO "PropertyKnowledgeChunk"
            (id, "tenantId", "propertyId", content, category, "sourceKey", embedding, "createdAt", "updatedAt")
          VALUES (
            ${id}, ${tenantId}, ${propertyId},
            ${chunks[i].content}, ${chunks[i].category}, ${chunks[i].sourceKey},
            ${embeddingStr}::vector, now(), now()
          )
        `;
      } else {
        await prisma.$executeRaw`
          INSERT INTO "PropertyKnowledgeChunk"
            (id, "tenantId", "propertyId", content, category, "sourceKey", "createdAt", "updatedAt")
          VALUES (
            ${id}, ${tenantId}, ${propertyId},
            ${chunks[i].content}, ${chunks[i].category}, ${chunks[i].sourceKey},
            now(), now()
          )
        `;
      }
      inserted++;
    } catch (err) {
      console.error(`[RAG] Failed to insert chunk ${i} for property ${propertyId}:`, err);
    }
  }

  console.log(`[RAG] Ingested ${inserted}/${chunks.length} chunks for property ${propertyId}`);
  return inserted;
}

export async function retrieveRelevantKnowledge(
  tenantId: string,
  propertyId: string,
  query: string,
  prisma: PrismaClient,
  topK = 8
): Promise<Array<{ content: string; category: string; similarity: number }>> {
  try {
    if (!(await isPgvectorAvailable(prisma))) return [];
    const embedding = await embedText(query);
    if (!embedding || embedding.length === 0) return [];

    const embeddingStr = `[${embedding.join(',')}]`;

    const results = await prisma.$queryRaw<
      Array<{ id: string; content: string; category: string; similarity: number }>
    >`
      SELECT id, content, category,
        1 - (embedding <=> ${embeddingStr}::vector) as similarity
      FROM "PropertyKnowledgeChunk"
      WHERE ("propertyId" = ${propertyId} OR "propertyId" IS NULL)
        AND "tenantId" = ${tenantId}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${topK}
    `;

    return results
      .filter(r => Number(r.similarity) > 0.5)
      .map(r => ({
        content: r.content,
        category: r.category,
        similarity: Number(r.similarity),
      }));
  } catch (err) {
    console.error('[RAG] retrieveRelevantKnowledge failed:', err);
    return [];
  }
}

// ─── SOP Seeding — tenant-level procedure chunks ──────────────────────────────

const SOP_CHUNKS = [
  {
    category: 'sop-service-requests',
    sourceKey: 'sop-service-requests',
    content: `## SERVICE REQUESTS & SCHEDULING — Cleaning, Amenities, Deliveries

**Working hours:** 10:00 AM – 5:00 PM (housekeeping/maintenance)

**Cleaning ($20/session):**
- Working hours only. Recurring OK ($20 each).
- Flow: Ask preferred time → Guest confirms → Mention $20 fee → Escalate as "scheduled"
- Mention fee on confirmation, NOT on first ask.

**Free Amenities:**
- Full list is in PROPERTY & GUEST INFO. Only confirm items listed there.
- Item NOT on list → "Let me check" → escalate as "info_request"
- Ask for delivery time during working hours → escalate as "scheduled"

**Scheduling:**
- During working hours: Ask preferred time. "Now" → confirmed, escalate immediately. Specific time → confirm and escalate.
- After hours (after 5 PM): Arrange for tomorrow. Ask for preferred time between 10am–5pm → confirm → escalate.
- Multiple requests: Assume one time slot unless guest explicitly wants separate visits.

**Examples:**

Guest: "Can we get cleaning today?"
{"guest_message":"Sure, what time works for you? We do visits between 10am and 5pm.","escalation":null}

Guest: "Around 1pm"
{"guest_message":"Got it, housekeeping at 1pm. Just so you know, cleaning is $20 per session.","escalation":{"title":"cleaning-scheduled","note":"Guest [Name] in [Unit] — cleaning at 1pm. $20 confirmed.","urgency":"scheduled"}}

Guest: "Can someone clean?" (8pm)
{"guest_message":"I can arrange cleaning for tomorrow. What time works between 10am and 5pm?","escalation":null}

Guest: "Do you have a phone charger?"
{"guest_message":"Let me check on that and get back to you.","escalation":{"title":"amenity-unlisted","note":"Guest [Name] in [Unit] asking for phone charger. Not on standard list.","urgency":"info_request"}}`,
  },
  {
    category: 'sop-maintenance',
    sourceKey: 'sop-maintenance',
    content: `## MAINTENANCE & TECHNICAL ISSUES

**WiFi & Door Code:** Details in PROPERTY & GUEST INFO — give directly. Problem? → escalate immediately.

**Broken/malfunctioning items:** Acknowledge, assure someone will look into it, escalate immediately.

**All maintenance/technical issues → urgency: "immediate"**

**Examples:**

Guest: "There's no hot water"
{"guest_message":"Sorry about that — I'm getting someone to look into it now.","escalation":{"title":"maintenance-no-hot-water","note":"Guest [Name] in [Unit] — no hot water. Needs ASAP.","urgency":"immediate"}}

Guest: "The AC isn't cooling"
{"guest_message":"Sorry about that, I'll have someone check it right away.","escalation":{"title":"maintenance-ac","note":"Guest [Name] in [Unit] — AC not cooling. Needs maintenance.","urgency":"immediate"}}

OPEN TASKS: [abc123] maintenance-no-hot-water (immediate)
Guest: "Hot water is working now, thanks!"
{"guest_message":"","escalation":null,"resolveTaskId":"abc123"}`,
  },
  {
    category: 'sop-house-rules',
    sourceKey: 'sop-house-rules',
    content: `## HOUSE RULES

- Family-only property
- No smoking indoors
- No parties or gatherings
- Quiet hours apply

**Visitor Policy:**
- ONLY immediate family members allowed
- Guest must send visitor's passport through chat
- Family names must match guest's family name
- Collect passport image → escalate for verification
- Non-family visitors = NOT allowed

**Any pushback on rules → escalate immediately**

**Examples:**

Guest: "Can my friend come over for dinner?"
{"guest_message":"We only allow immediate family members as visitors. If they're family, please send their passport through the chat and we'll arrange access.","escalation":null}

Guest: "That's unfair, it's just one friend"
{"guest_message":"I understand, but this is a strict policy we need to follow. I'll pass your feedback along.","escalation":{"title":"house-rule-pushback","note":"Guest [Name] in [Unit] pushing back on visitor policy. Wants non-family friend. Needs manager.","urgency":"immediate"}}`,
  },
  {
    category: 'sop-checkin-checkout',
    sourceKey: 'sop-checkin-checkout',
    content: `## EARLY CHECK-IN & LATE CHECKOUT

Check-in: 3:00 PM | Check-out: 11:00 AM
Back-to-back bookings mean early/late can only be confirmed 2 days before.

**>2 days before:** Do NOT escalate. Tell guest:
"We can only confirm 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."

**Within 2 days:** Tell guest you'll check → escalate as "info_request"

**Never confirm early check-in or late checkout yourself.**

**Examples:**

Guest: "Can I check in at noon?" (check-in far away)
{"guest_message":"We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab something at O1 Mall — it's a 1-minute walk.","escalation":null}

Guest: "I arrive tomorrow at 10am, early check-in?" (within 2 days)
{"guest_message":"Let me check on that for you and get back to you shortly.","escalation":{"title":"early-checkin","note":"Guest [Name] in [Unit] — early check-in tomorrow 10am. Within 2-day window.","urgency":"info_request"}}`,
  },
  {
    category: 'sop-escalation',
    sourceKey: 'sop-escalation',
    content: `## ESCALATION GUIDE — When & How to Escalate

**escalation: null** — No manager action:
- Answering from PROPERTY & GUEST INFO
- Asking guest for time preference (before confirmation)
- Explaining fees or policies
- Early check-in/checkout >2 days out
- Conversation-ending messages → also guest_message: ""

**urgency: "immediate"** — Needs attention NOW:
- Emergencies (fire, gas, flood, medical, safety)
- Technical issues (WiFi down, door code, broken items)
- Noise complaints, guest dissatisfaction
- House rule violations or pushback
- Guest sends image
- Anything you're unsure about

**urgency: "scheduled"** — Action at a specific time:
- Cleaning after time + $20 confirmed
- Amenity/maintenance after time confirmed
- After-hours next-day arrangements

**urgency: "info_request"** — Manager provides info:
- Local recommendations
- Reservation changes
- Early check-in/checkout within 2 days
- Refund/discount requests (NEVER authorize yourself)
- Any question you can't answer

**Examples:**

Guest: "Can you recommend a restaurant?"
{"guest_message":"Let me check and get back to you.","escalation":{"title":"local-recommendation","note":"Guest [Name] in [Unit] wants restaurant recommendation.","urgency":"info_request"}}

Guest: "I want a discount"
{"guest_message":"I'll pass that along to the team.","escalation":{"title":"discount-request","note":"Guest [Name] in [Unit] requesting discount. Needs manager decision.","urgency":"info_request"}}`,
  },
];

export async function seedTenantSops(
  tenantId: string,
  prisma: PrismaClient
): Promise<number> {
  // 1. Delete existing SOP chunks for this tenant (propertyId IS NULL, category LIKE 'sop-%')
  await prisma.$executeRaw`
    DELETE FROM "PropertyKnowledgeChunk"
    WHERE "propertyId" IS NULL
      AND "tenantId" = ${tenantId}
      AND category LIKE 'sop-%'
  `;

  const vectorEnabled = await isPgvectorAvailable(prisma);

  // 2. Embed all SOP chunks (only if vector column exists)
  let embeddings: number[][] = [];
  if (vectorEnabled) {
    try {
      embeddings = await embedBatch(SOP_CHUNKS.map(c => c.content));
    } catch (err) {
      console.warn('[RAG] SOP embedding failed, storing without embeddings:', err);
    }
  }

  // 3. Insert each SOP chunk
  let inserted = 0;
  for (let i = 0; i < SOP_CHUNKS.length; i++) {
    const chunk = SOP_CHUNKS[i];
    const id = generateId();
    const embedding = embeddings[i];

    try {
      if (vectorEnabled && embedding && embedding.length > 0) {
        const embeddingStr = `[${embedding.join(',')}]`;
        await prisma.$executeRaw`
          INSERT INTO "PropertyKnowledgeChunk"
            (id, "tenantId", "propertyId", content, category, "sourceKey", embedding, "createdAt", "updatedAt")
          VALUES (
            ${id}, ${tenantId}, NULL,
            ${chunk.content}, ${chunk.category}, ${chunk.sourceKey},
            ${embeddingStr}::vector, now(), now()
          )
        `;
      } else {
        // Store without embedding — chunks exist in DB but won't be retrieved via vector search
        // System degrades gracefully: minimal prompt + property info + hard boundaries
        await prisma.$executeRaw`
          INSERT INTO "PropertyKnowledgeChunk"
            (id, "tenantId", "propertyId", content, category, "sourceKey", "createdAt", "updatedAt")
          VALUES (
            ${id}, ${tenantId}, NULL,
            ${chunk.content}, ${chunk.category}, ${chunk.sourceKey},
            now(), now()
          )
        `;
      }
      inserted++;
    } catch (err) {
      console.error(`[RAG] Failed to insert SOP chunk ${chunk.category}:`, err);
    }
  }

  console.log(`[RAG] Seeded ${inserted}/${SOP_CHUNKS.length} SOP chunks for tenant ${tenantId}`);
  return inserted;
}
