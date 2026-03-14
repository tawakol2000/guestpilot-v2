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

// ─── Key label mapping for clean property-info chunk ────────────────────────
const KEY_LABELS: Record<string, string> = {
  internalListingName: 'Unit Number',
  personCapacity: 'Person Capacity',
  roomType: 'Property Type',
  bedroomsNumber: 'Number of Bedrooms',
  bathroomsNumber: 'Number of Bathrooms',
  doorCode: 'Door Code',
  wifiName: 'WiFi Name',
  wifiPassword: 'WiFi Password',
  checkInTime: 'Check-in Time',
  checkOutTime: 'Check-out Time',
  houseRules: 'House Rules',
  specialInstruction: 'Special Instructions',
  keyPickup: 'Key Pickup',
  amenities: 'Amenities',
  cleaningFee: 'Cleaning Fee',
  squareMeters: 'Size (sqm)',
  bedTypes: 'Bed Types',
};

export async function ingestPropertyKnowledge(
  tenantId: string,
  propertyId: string,
  property: { customKnowledgeBase?: unknown; listingDescription?: string; name?: string; address?: string },
  prisma: PrismaClient
): Promise<number> {
  // 1. Delete existing property chunks (preserve learned-answers)
  await prisma.$executeRaw`
    DELETE FROM "PropertyKnowledgeChunk"
    WHERE "propertyId" = ${propertyId}
      AND "tenantId" = ${tenantId}
      AND category IN ('property-info', 'property-description', 'property-amenities')
  `;

  const chunks: { content: string; category: string; sourceKey: string }[] = [];

  // 2a. Build property-info chunk: clean key-value format (excludes amenities — separate chunk)
  const customKb = property.customKnowledgeBase as Record<string, unknown> | null;
  if (customKb && typeof customKb === 'object') {
    const lines: string[] = [];
    if (property.address) lines.push(`Address: ${property.address}`);
    for (const [key, val] of Object.entries(customKb)) {
      if (key === 'amenities') continue; // amenities go in their own chunk
      const strVal = String(val ?? '').trim();
      if (!strVal || strVal === 'N/A' || strVal === 'null') continue;
      const label = KEY_LABELS[key] || key;
      lines.push(`${label}: ${strVal}`);
    }
    if (lines.length > 0) {
      chunks.push({
        content: lines.join('\n'),
        category: 'property-info',
        sourceKey: 'property-info',
      });
    }

    // 2a-ii. Build property-amenities chunk: dedicated for amenity queries
    const amenitiesVal = String(customKb.amenities ?? '').trim();
    if (amenitiesVal && amenitiesVal !== 'N/A' && amenitiesVal !== 'null') {
      const amenitiesList = amenitiesVal.split(',').map((a: string) => a.trim()).filter(Boolean);
      const amenitiesContent = `## Available Amenities & Services\nThe following amenities are available at this property:\n${amenitiesList.map((a: string) => `• ${a}`).join('\n')}\n\nItems NOT on this list may not be available — check with manager before confirming.`;
      chunks.push({
        content: amenitiesContent,
        category: 'property-amenities',
        sourceKey: 'property-amenities',
      });
    }
  }

  // 2b. Build property-description chunk: full listing description as one chunk
  if (property.listingDescription && property.listingDescription.trim().length > 0) {
    chunks.push({
      content: property.listingDescription.trim(),
      category: 'property-description',
      sourceKey: 'property-description',
    });
  }

  if (chunks.length === 0) return 0;

  const vectorEnabled = await isPgvectorAvailable(prisma);

  // 3. Embed all chunks (only if vector column exists)
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

// ─── Learned Answers — append Q&A from manager approvals ────────────────────

export async function appendLearnedAnswer(
  tenantId: string,
  propertyId: string,
  question: string,
  answer: string,
  prisma: PrismaClient
): Promise<void> {
  const newLine = `Q: ${question}\nA: ${answer}`;

  // Find existing learned-answers chunk for this property
  const existing = await prisma.$queryRaw<
    Array<{ id: string; content: string }>
  >`
    SELECT id, content FROM "PropertyKnowledgeChunk"
    WHERE "propertyId" = ${propertyId}
      AND "tenantId" = ${tenantId}
      AND category = 'learned-answers'
    LIMIT 1
  `;

  const vectorEnabled = await isPgvectorAvailable(prisma);

  if (existing.length > 0) {
    // Append to existing chunk
    const updatedContent = existing[0].content + '\n\n' + newLine;
    if (vectorEnabled) {
      try {
        const embedding = await embedText(updatedContent);
        if (embedding && embedding.length > 0) {
          const embeddingStr = `[${embedding.join(',')}]`;
          await prisma.$executeRaw`
            UPDATE "PropertyKnowledgeChunk"
            SET content = ${updatedContent}, embedding = ${embeddingStr}::vector, "updatedAt" = now()
            WHERE id = ${existing[0].id} AND "tenantId" = ${tenantId}
          `;
          console.log(`[RAG] Updated learned-answers chunk for property ${propertyId}`);
          return;
        }
      } catch (err) {
        console.warn('[RAG] Failed to embed learned-answers update:', err);
      }
    }
    // Fallback: update without embedding
    await prisma.$executeRaw`
      UPDATE "PropertyKnowledgeChunk"
      SET content = ${updatedContent}, "updatedAt" = now()
      WHERE id = ${existing[0].id} AND "tenantId" = ${tenantId}
    `;
    console.log(`[RAG] Updated learned-answers chunk (no embedding) for property ${propertyId}`);
  } else {
    // Create new learned-answers chunk
    const id = generateId();
    if (vectorEnabled) {
      try {
        const embedding = await embedText(newLine);
        if (embedding && embedding.length > 0) {
          const embeddingStr = `[${embedding.join(',')}]`;
          await prisma.$executeRaw`
            INSERT INTO "PropertyKnowledgeChunk"
              (id, "tenantId", "propertyId", content, category, "sourceKey", embedding, "createdAt", "updatedAt")
            VALUES (
              ${id}, ${tenantId}, ${propertyId},
              ${newLine}, 'learned-answers', 'learned-answers',
              ${embeddingStr}::vector, now(), now()
            )
          `;
          console.log(`[RAG] Created learned-answers chunk for property ${propertyId}`);
          return;
        }
      } catch (err) {
        console.warn('[RAG] Failed to embed new learned-answers:', err);
      }
    }
    // Fallback: insert without embedding
    await prisma.$executeRaw`
      INSERT INTO "PropertyKnowledgeChunk"
        (id, "tenantId", "propertyId", content, category, "sourceKey", "createdAt", "updatedAt")
      VALUES (
        ${id}, ${tenantId}, ${propertyId},
        ${newLine}, 'learned-answers', 'learned-answers',
        now(), now()
      )
    `;
    console.log(`[RAG] Created learned-answers chunk (no embedding) for property ${propertyId}`);
  }
}

export async function retrieveRelevantKnowledge(
  tenantId: string,
  propertyId: string,
  query: string,
  prisma: PrismaClient,
  topK = 8,
  agentType?: 'guestCoordinator' | 'screeningAI'
): Promise<Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>> {
  try {
    if (!(await isPgvectorAvailable(prisma))) return [];
    const embedding = await embedText(query);
    if (!embedding || embedding.length === 0) return [];

    const embeddingStr = `[${embedding.join(',')}]`;

    let results: Array<{ id: string; content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>;

    if (agentType === 'guestCoordinator') {
      results = await prisma.$queryRaw<
        Array<{ id: string; content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>
      >`
        SELECT id, content, category, "sourceKey", "propertyId",
          1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM "PropertyKnowledgeChunk"
        WHERE ("propertyId" = ${propertyId} OR "propertyId" IS NULL)
          AND "tenantId" = ${tenantId}
          AND embedding IS NOT NULL
          AND category NOT LIKE 'sop-screening-%'
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${topK}
      `;
    } else if (agentType === 'screeningAI') {
      results = await prisma.$queryRaw<
        Array<{ id: string; content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>
      >`
        SELECT id, content, category, "sourceKey", "propertyId",
          1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM "PropertyKnowledgeChunk"
        WHERE ("propertyId" = ${propertyId} OR "propertyId" IS NULL)
          AND "tenantId" = ${tenantId}
          AND embedding IS NOT NULL
          AND category NOT IN ('sop-service-requests', 'sop-maintenance', 'sop-house-rules', 'sop-checkin-checkout', 'sop-escalation')
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${topK}
      `;
    } else {
      results = await prisma.$queryRaw<
        Array<{ id: string; content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>
      >`
        SELECT id, content, category, "sourceKey", "propertyId",
          1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM "PropertyKnowledgeChunk"
        WHERE ("propertyId" = ${propertyId} OR "propertyId" IS NULL)
          AND "tenantId" = ${tenantId}
          AND embedding IS NOT NULL
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${topK}
      `;
    }

    // Log ALL results with scores so we can diagnose retrieval quality
    console.log(`[RAG] raw results for "${query.substring(0, 60)}": ${results.map(r => `${r.sourceKey}[${r.category}](${Number(r.similarity).toFixed(3)})`).join(', ') || 'empty'}`);
    const filtered = results.filter(r => Number(r.similarity) > 0.3);
    console.log(`[RAG] retrieved ${filtered.length}/${results.length} above threshold`);
    return filtered.map(r => ({
        content: r.content,
        category: r.category,
        similarity: Number(r.similarity),
        sourceKey: r.sourceKey,
        propertyId: r.propertyId,
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
- Check the property amenities list in RELEVANT PROCEDURES & KNOWLEDGE for available items.
- Only confirm items explicitly listed. Item NOT on list → "Let me check" → escalate as "info_request"
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
  {
    category: 'sop-screening-workflow',
    sourceKey: 'sop-screening-workflow',
    content: `## SCREENING WORKFLOW

**Step 1:** Check conversation history — what do you already know? Never re-ask.

**Step 2:** If missing, gather in order:
1. Nationality — "Could you share your nationality?" (groups: "What are the nationalities of everyone in your party?")
2. Party composition — "Who will you be traveling with?"
3. Relationship (only for Arab couples) — "Are you married?"

Ask naturally. Don't fire all questions at once — infer what you can from context first.

**Step 3:** Once you have nationality + party composition, apply screening rules.

**Step 4:** Respond to guest + escalate as appropriate.

**Examples:**

Guest: "I want to book for 2 nights"
{"guest message":"Thanks for reaching out! Could you share your nationality and who you'll be traveling with?","manager":{"needed":false,"title":"","note":""}}

Guest: "I'm Egyptian, it's just me" (male name — Mohamed)
{"guest message":"Thanks. Just to confirm — will you be staying alone?","manager":{"needed":false,"title":"","note":""}}

Guest: "Yes, just me"
{"guest message":"Unfortunately, we're only able to host families or married couples at this property.","manager":{"needed":true,"title":"violation-arab-single-male","note":"Egyptian male, solo traveler. Violates house rules. Recommend rejection."}}`,
  },
  {
    category: 'sop-screening-escalation',
    sourceKey: 'sop-screening-escalation',
    content: `## SCREENING ESCALATION TITLES

**Set "needed": false** — still gathering info or answering basic questions.

**Set "needed": true** — use exact title below:

### ELIGIBLE — Recommend Acceptance:
- Non-Arab guest(s), any configuration → title: "eligible-non-arab"
- Arab female-only group or solo female → title: "eligible-arab-females"
- Arab family (cert + passports requested) → title: "eligible-arab-family-pending-docs"
- Arab married couple (cert requested) → title: "eligible-arab-couple-pending-cert"
- Lebanese or Emirati solo traveler → title: "eligible-lebanese-emirati-single"

### NOT ELIGIBLE — Recommend Rejection:
- Single Arab male → title: "violation-arab-single-male"
- All-male Arab group → title: "violation-arab-male-group"
- Unmarried Arab couple → title: "violation-arab-unmarried-couple"
- Mixed-gender Arab group (not family) → title: "violation-arab-mixed-group"
- Mixed nationality unmarried couple → title: "violation-mixed-unmarried-couple"
- Guest refuses/cannot provide required documents → title: "violation-no-documents"

### REQUIRES MANAGER:
- Guest argues or pushes back on rules → title: "escalation-guest-dispute"
- Guest asks about visitors → title: "visitor-policy-informed"
- Ambiguous or unclear situation → title: "escalation-unclear"
- Question beyond your knowledge → title: "escalation-unknown-answer"
- Conversation-ending message awaiting decision → title: "awaiting-manager-review"

**Note field:** Always include guest name, unit, nationality, party details, and your recommendation.

**Example:**

Guest (Egyptian married couple):
{"guest message":"We'd be happy to host you. Once the booking is accepted, please send your marriage certificate through the chat.","manager":{"needed":true,"title":"eligible-arab-couple-pending-cert","note":"Egyptian married couple. Eligible. Marriage cert requested after acceptance. Recommend acceptance."}}`,
  },
  {
    category: 'sop-screening-property-info',
    sourceKey: 'sop-screening-property-info',
    content: `## PROPERTY INFO FOR SCREENING

**Hours:**
- Check-in: 3:00 PM | Check-out: 11:00 AM

**Free Amenities (on request):**
- Baby crib, extra bed, hair dryer, kitchen blender, kids dinnerware, espresso machine
- Extra towels, extra pillows, extra blankets, hangers
- These are the ONLY available amenities. If a guest asks for an item NOT on this list → "Let me check on that" → escalate.

**House Rules (shareable with guest):**
- Family-only property
- No outside visitors at any time
- No smoking indoors
- No parties or gatherings
- Quiet hours apply

**You CANNOT answer — escalate to manager:**
- Pricing questions or discounts
- Availability changes or date modifications
- Refund or cancellation policy questions
- Location/neighborhood recommendations
- Special requests beyond listed amenities
- Anything you're unsure about

**Examples:**

Guest: "What time is check-in?"
{"guest message":"Check-in is at 3:00 PM and check-out is at 11:00 AM.","manager":{"needed":false,"title":"","note":""}}

Guest: "Do you have a crib for my baby?"
{"guest message":"Yes, we have a baby crib available on request — just let us know and we'll have it ready for you.","manager":{"needed":false,"title":"","note":""}}

Guest: "Can you give me a discount?"
{"guest message":"I'll pass that along to the team.","manager":{"needed":true,"title":"escalation-unknown-answer","note":"Guest requesting a discount. Needs manager decision."}}`,
  },
  {
    category: 'sop-screening-image-handling',
    sourceKey: 'sop-screening-image-handling',
    content: `## IMAGE HANDLING DURING SCREENING

During screening, guests cannot send documents before booking is accepted.

If an image comes through:
1. Check if it's a marriage certificate, passport, or ID.
2. If it's a document → tell guest you've received it and escalate for manager verification.
3. If unclear or unrelated → escalate: "Guest sent an image that requires manager review."

If guest asks where/how to send documents:
"Once the booking is accepted, you'll be able to send the documents through the chat."

**Examples:**

Guest sends image (looks like marriage certificate):
{"guest message":"Got it, thank you. I'll pass this to the team for review.","manager":{"needed":true,"title":"escalation-unclear","note":"Guest sent what appears to be a marriage certificate. Requires manager verification."}}

Guest: "Where should I send my marriage certificate?"
{"guest message":"Once the booking is accepted, you'll be able to send the documents through the chat.","manager":{"needed":false,"title":"","note":""}}`,
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
