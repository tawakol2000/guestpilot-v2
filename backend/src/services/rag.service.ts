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

  // 3. Embed all chunks in batches
  const texts = chunks.map(c => c.content);
  const embeddings = await embedBatch(texts);

  // 4. Insert each chunk with embedding via raw SQL
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding || embedding.length === 0) continue;

    const id = generateId();
    const embeddingStr = `[${embedding.join(',')}]`;

    try {
      await prisma.$executeRaw`
        INSERT INTO "PropertyKnowledgeChunk"
          (id, "tenantId", "propertyId", content, category, "sourceKey", embedding, "createdAt", "updatedAt")
        VALUES (
          ${id},
          ${tenantId},
          ${propertyId},
          ${chunks[i].content},
          ${chunks[i].category},
          ${chunks[i].sourceKey},
          ${embeddingStr}::vector,
          now(),
          now()
        )
      `;
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
  topK = 5
): Promise<Array<{ content: string; category: string; similarity: number }>> {
  try {
    const embedding = await embedText(query);
    if (!embedding || embedding.length === 0) return [];

    const embeddingStr = `[${embedding.join(',')}]`;

    const results = await prisma.$queryRaw<
      Array<{ id: string; content: string; category: string; similarity: number }>
    >`
      SELECT id, content, category,
        1 - (embedding <=> ${embeddingStr}::vector) as similarity
      FROM "PropertyKnowledgeChunk"
      WHERE "propertyId" = ${propertyId}
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
