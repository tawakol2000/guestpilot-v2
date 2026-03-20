/**
 * RAG (Retrieval-Augmented Generation) service.
 * Ingests property knowledge as vector chunks and retrieves relevant context.
 * Grounds AI responses in verified property data — prevents hallucination.
 *
 * Note: The `embedding` vector column is NOT in the Prisma schema (pgvector
 * requires raw SQL). Use $executeRaw / $queryRaw for all embedding operations.
 */
import { PrismaClient } from '@prisma/client';
import { embedText, embedBatch, getEmbeddingProvider } from './embeddings.service';
import { classifyMessage, isClassifierInitialized, getSopContent, initializeClassifier, type ClassificationResult } from './classifier.service';
import { BAKED_IN_CHUNKS } from './classifier-data';
import { rerank, isRerankEnabled } from './rerank.service';
import { getTenantAiConfig } from './tenant-config.service';
import { extractIntent } from './intent-extractor.service';

/** Returns the DB column name for the active embedding provider. */
function embCol(): string {
  return getEmbeddingProvider() === 'cohere' ? 'embedding_cohere' : 'embedding';
}

/** Returns the vector dimension for the active embedding provider. */
function embDim(): number {
  return getEmbeddingProvider() === 'cohere' ? 1024 : 1536;
}

function generateId(): string {
  // Simple cuid-like ID without external dependency
  return `ck${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

// Cache pgvector availability per process lifetime
let _pgvectorAvailable: boolean | null = null;

// Last classifier result — stashed for judge service evaluation
// Per-request classifier result — captured immediately after classification, consumed by the same request.
// NOTE: This is a module-global for backward compat. For thread safety, callers MUST snapshot
// via getAndClearLastClassifierResult() immediately after retrieveRelevantKnowledge() returns.
let _lastClassifierResult: {
  method: string;
  labels: string[];
  topSimilarity: number;
  confidence: number;
  neighbors: Array<{ labels: string[]; similarity: number }>;
  tier: 'high' | 'medium' | 'low';
  topCandidates: Array<{ label: string; confidence: number }>;
  queryEmbedding?: number[];
} | null = null;

/**
 * Atomically get and clear the last classifier result.
 * Prevents a concurrent request from reading stale data.
 */
export function getAndClearLastClassifierResult(): typeof _lastClassifierResult {
  const result = _lastClassifierResult;
  _lastClassifierResult = null;
  return result;
}

/** @deprecated Use getAndClearLastClassifierResult() for thread safety */
export function getLastClassifierResult(): typeof _lastClassifierResult {
  return _lastClassifierResult;
}

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
      AND category IN ('property-info', 'property-description')
  `;

  const chunks: { content: string; category: string; sourceKey: string }[] = [];

  // 2a. Build property-info chunk: clean key-value format
  // Amenities are NOT stored as a pgvector chunk — they're injected dynamically
  // into the sop-amenity-request SOP via the {PROPERTY_AMENITIES} placeholder.
  const customKb = property.customKnowledgeBase as Record<string, unknown> | null;
  if (customKb && typeof customKb === 'object') {
    const lines: string[] = [];
    if (property.address) lines.push(`Address: ${property.address}`);
    for (const [key, val] of Object.entries(customKb)) {
      if (key === 'amenities') continue; // handled via sop-amenity-request SOP
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
      embeddings = await embedBatch(chunks.map(c => c.content), 'search_document');
    } catch (err) {
      console.warn('[RAG] embedBatch failed:', err);
    }
  }

  // 4. Insert each chunk with or without embedding
  const col = embCol();
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const id = generateId();
    const embedding = embeddings[i];

    try {
      if (vectorEnabled && embedding && embedding.length > 0) {
        const embeddingStr = `[${embedding.join(',')}]`;
        await (prisma.$executeRawUnsafe as any)(
          `INSERT INTO "PropertyKnowledgeChunk"
            (id, "tenantId", "propertyId", content, category, "sourceKey", "${col}", "createdAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7::vector(${embDim()}), now(), now())`,
          id, tenantId, propertyId,
          chunks[i].content, chunks[i].category, chunks[i].sourceKey,
          embeddingStr
        );
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
        const embedding = await embedText(updatedContent, 'search_document');
        if (embedding && embedding.length > 0) {
          const embeddingStr = `[${embedding.join(',')}]`;
          await (prisma.$executeRawUnsafe as any)(
            `UPDATE "PropertyKnowledgeChunk"
            SET content = $1, "${embCol()}" = $2::vector(${embDim()}), "updatedAt" = now()
            WHERE id = $3 AND "tenantId" = $4`,
            updatedContent, embeddingStr, existing[0].id, tenantId
          );
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
        const embedding = await embedText(newLine, 'search_document');
        if (embedding && embedding.length > 0) {
          const embeddingStr = `[${embedding.join(',')}]`;
          await (prisma.$executeRawUnsafe as any)(
            `INSERT INTO "PropertyKnowledgeChunk"
              (id, "tenantId", "propertyId", content, category, "sourceKey", "${embCol()}", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, 'learned-answers', 'learned-answers', $5::vector(${embDim()}), now(), now())`,
            id, tenantId, propertyId, newLine, embeddingStr
          );
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

async function retrievePropertyChunks(
  tenantId: string,
  propertyId: string,
  query: string,
  prisma: PrismaClient,
  topK = 3
): Promise<Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>> {
  try {
    if (!(await isPgvectorAvailable(prisma))) return [];
    const embedding = await embedText(query, 'search_query');
    if (!embedding || embedding.length === 0) return [];

    const embeddingStr = `[${embedding.join(',')}]`;
    const col = embCol();
    const results = await (prisma.$queryRawUnsafe as any)(
      `SELECT id, content, category, "sourceKey", "propertyId",
        1 - ("${col}" <=> $1::vector(${embDim()})) as similarity
      FROM "PropertyKnowledgeChunk"
      WHERE "propertyId" = $2
        AND "tenantId" = $3
        AND "${col}" IS NOT NULL
        AND category IN ('property-info', 'property-description', 'learned-answers')
      ORDER BY "${col}" <=> $1::vector(${embDim()})
      LIMIT $4`,
      embeddingStr, propertyId, tenantId, topK
    ) as Array<{ id: string; content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>;

    return results
      .filter(r => Number(r.similarity) > 0.3)
      .map(r => ({
        content: r.content,
        category: r.category,
        similarity: Number(r.similarity),
        sourceKey: r.sourceKey,
        propertyId: r.propertyId,
      }));
  } catch (err) {
    console.error('[RAG] retrievePropertyChunks failed:', err);
    return [];
  }
}

export async function retrieveRelevantKnowledge(
  tenantId: string,
  propertyId: string,
  query: string,
  prisma: PrismaClient,
  topK = 8,
  agentType?: 'guestCoordinator' | 'screeningAI',
  conversationId?: string,
  recentMessages?: Array<{ role: string; content: string }>,
  propertyAmenities?: string
): Promise<{
  chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>;
  topSimilarity: number;
  tier: 'tier1' | 'tier2_needed' | 'tier3_cache';
  confidenceTier?: 'high' | 'medium' | 'low';
  topCandidates?: Array<{ label: string; confidence: number }>;
  intentExtractorRan?: boolean;
}> {
  // Three-tier confidence thresholds — configurable per tenant via UI
  let HIGH_CONFIDENCE_THRESHOLD = 0.85;
  let LOW_CONFIDENCE_THRESHOLD = 0.55;
  try {
    const cfg = await getTenantAiConfig(tenantId, prisma);
    if (cfg.highConfidenceThreshold !== undefined && cfg.highConfidenceThreshold !== null) {
      HIGH_CONFIDENCE_THRESHOLD = cfg.highConfidenceThreshold;
    }
    if (cfg.lowConfidenceThreshold !== undefined && cfg.lowConfidenceThreshold !== null) {
      LOW_CONFIDENCE_THRESHOLD = cfg.lowConfidenceThreshold;
    }
  } catch { /* use default */ }

  // For guestCoordinator: use LR classifier for SOPs + pgvector for property chunks only
  if (agentType === 'guestCoordinator' && isClassifierInitialized()) {
    try {
      const classifierResult = await classifyMessage(query);
      _lastClassifierResult = {
        method: classifierResult.method,
        labels: classifierResult.labels,
        topSimilarity: classifierResult.topSimilarity,
        confidence: classifierResult.confidence,  // LR sigmoid confidence
        neighbors: classifierResult.neighbors,
        tier: classifierResult.tier,
        topCandidates: classifierResult.topCandidates,
        queryEmbedding: classifierResult.queryEmbedding,
      };
      console.log(`[RAG] Classifier: "${query.substring(0, 60)}" → [${classifierResult.labels.join(', ')}] (${classifierResult.method}, confidence=${classifierResult.confidence.toFixed(3)}, tier=${classifierResult.tier})`);

      // ─── Three-tier confidence routing (T013) ─────────────────────────
      // Determine confidence tier using LR sigmoid confidence (NOT cosine similarity)
      const lrConfidence = classifierResult.confidence;
      const confidenceTier: 'high' | 'medium' | 'low' =
        lrConfidence >= HIGH_CONFIDENCE_THRESHOLD ? 'high' :
        lrConfidence >= LOW_CONFIDENCE_THRESHOLD ? 'medium' : 'low';

      let sopChunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }> = [];

      if (confidenceTier === 'high') {
        // HIGH tier: inject single top SOP
        sopChunks = classifierResult.labels
          .map(label => {
            const content = getSopContent(label, propertyAmenities);
            return content ? {
              content,
              category: label,
              similarity: 1.0,
              sourceKey: label,
              propertyId: null as string | null,
            } : null;
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

      } else if (confidenceTier === 'medium') {
        // MEDIUM tier: inject top 3 candidates with verification context
        const top3 = classifierResult.topCandidates.slice(0, 3);
        sopChunks = top3
          .map((candidate, idx) => {
            const content = getSopContent(candidate.label, propertyAmenities);
            if (!content) return null;
            return {
              content: `CANDIDATE ${idx + 1} (classifier confidence: ${candidate.confidence.toFixed(2)}): ${content}`,
              category: candidate.label,
              similarity: candidate.confidence,
              sourceKey: candidate.label,
              propertyId: null as string | null,
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

        if (sopChunks.length > 0) {
          // Add verification instruction as a preamble chunk
          sopChunks.unshift({
            content: 'VERIFICATION REQUIRED: The classifier was not fully confident. Multiple SOP candidates are provided below. Read all candidates carefully and choose the most relevant one based on the guest message context. If none fit, respond with general courtesy.',
            category: 'verification-instruction',
            similarity: 1.0,
            sourceKey: 'verification-instruction',
            propertyId: null,
          });
        }
        console.log(`[RAG] Medium confidence — injected ${top3.length} candidate SOPs: [${top3.map(c => `${c.label}(${c.confidence.toFixed(2)})`).join(', ')}]`);

      } else {
        // LOW tier: fire intent extractor as fallback
        console.log(`[RAG] Low confidence (${lrConfidence.toFixed(3)}) — firing Tier 2 intent extractor`);
        let intentResult = null;
        try {
          if (conversationId && recentMessages && recentMessages.length > 0) {
            intentResult = await extractIntent(recentMessages, tenantId, conversationId);
          }
        } catch (err) {
          console.warn('[RAG] Intent extractor failed in low-tier fallback (non-fatal):', err);
        }

        if (intentResult && intentResult.sops.length > 0) {
          // Intent extractor returned SOPs — look them up
          sopChunks = intentResult.sops
            .map(label => {
              const content = getSopContent(label, propertyAmenities);
              return content ? {
                content,
                category: label,
                similarity: 1.0,
                sourceKey: label,
                propertyId: null as string | null,
              } : null;
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);
          console.log(`[RAG] Low tier — intent extractor resolved: [${intentResult.sops.join(', ')}]`);
        } else {
          // Both classifier and intent extractor failed — return empty (baked-in SOPs still present)
          console.log(`[RAG] Low tier — both classifier and intent extractor failed. No dynamic SOPs.`);
          const propertyChunks = await retrievePropertyChunks(tenantId, propertyId, query, prisma, 3);
          return {
            chunks: propertyChunks,
            topSimilarity: classifierResult.topSimilarity,
            tier: 'tier2_needed' as const,
            confidenceTier: 'low',
            topCandidates: classifierResult.topCandidates,
            intentExtractorRan: true,
          };
        }
      }

      // Apply per-tenant SOP overrides (skip/replace) — baked-in SOPs are exempt
      try {
        const tenantConfig = await getTenantAiConfig(tenantId, prisma);
        const sopOverrides = tenantConfig.sopOverrides as Record<string, { enabled?: boolean; override?: string }> | null;
        if (sopOverrides && typeof sopOverrides === 'object') {
          sopChunks = sopChunks.filter(chunk => {
            // Baked-in SOPs are never affected by tenant overrides
            if (BAKED_IN_CHUNKS.has(chunk.category)) return true;
            // Verification instruction is not a real SOP — skip override checks
            if (chunk.category === 'verification-instruction') return true;

            const override = sopOverrides[chunk.category];
            if (!override) return true; // no override configured — keep default

            // Tenant disabled this SOP entirely
            if (override.enabled === false) {
              console.log(`[RAG] SOP "${chunk.category}" disabled by tenant override`);
              return false;
            }

            // Tenant provided replacement content
            if (override.override) {
              chunk.content = override.override;
              console.log(`[RAG] SOP "${chunk.category}" replaced by tenant override`);
            }

            return true;
          });
        }
      } catch (err) {
        console.warn('[RAG] Failed to load tenant SOP overrides, using defaults:', err);
      }

      // Deduplicate sopChunks by sourceKey (guards against LLM returning duplicate labels)
      const seenKeys = new Set<string>();
      sopChunks = sopChunks.filter(c => {
        if (seenKeys.has(c.sourceKey)) return false;
        seenKeys.add(c.sourceKey);
        return true;
      });

      // Also get property-specific chunks via pgvector
      const propertyChunks = await retrievePropertyChunks(tenantId, propertyId, query, prisma, 3);

      const combined = [...sopChunks, ...propertyChunks];
      const topSimilarity = classifierResult.confidence;
      // Map confidence tiers to the existing tier system for backward compatibility
      const tier = confidenceTier === 'high' ? 'tier1' as const : 'tier2_needed' as const;
      console.log(`[RAG] Classifier result: ${sopChunks.length} SOP chunks + ${propertyChunks.length} property chunks, tier=${tier} confidenceTier=${confidenceTier} topSim=${topSimilarity.toFixed(3)}`);
      return { chunks: combined, topSimilarity, tier, confidenceTier, topCandidates: classifierResult.topCandidates };
    } catch (err) {
      console.warn('[RAG] Classifier failed, falling back to pgvector:', err);
      // Fall through to existing pgvector logic below
    }
  }

  try {
    if (!(await isPgvectorAvailable(prisma))) return { chunks: [], topSimilarity: 0, tier: 'tier2_needed' as const };
    const embedding = await embedText(query, 'search_query');
    if (!embedding || embedding.length === 0) return { chunks: [], topSimilarity: 0, tier: 'tier2_needed' as const };

    const embeddingStr = `[${embedding.join(',')}]`;
    const col = embCol();

    type ChunkRow = { id: string; content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null };
    let results: ChunkRow[];

    if (agentType === 'guestCoordinator') {
      results = await (prisma.$queryRawUnsafe as any)(
        `SELECT id, content, category, "sourceKey", "propertyId",
          1 - ("${col}" <=> $1::vector(${embDim()})) as similarity
        FROM "PropertyKnowledgeChunk"
        WHERE ("propertyId" = $2 OR "propertyId" IS NULL)
          AND "tenantId" = $3
          AND "${col}" IS NOT NULL
          AND category NOT LIKE 'sop-screening-%'
          AND category NOT IN ('sop-scheduling', 'sop-house-rules', 'sop-escalation-immediate', 'sop-escalation-scheduled')
        ORDER BY "${col}" <=> $1::vector(${embDim()})
        LIMIT $4`,
        embeddingStr, propertyId, tenantId, topK
      ) as ChunkRow[];
    } else if (agentType === 'screeningAI') {
      results = await (prisma.$queryRawUnsafe as any)(
        `SELECT id, content, category, "sourceKey", "propertyId",
          1 - ("${col}" <=> $1::vector(${embDim()})) as similarity
        FROM "PropertyKnowledgeChunk"
        WHERE ("propertyId" = $2 OR "propertyId" IS NULL)
          AND "tenantId" = $3
          AND "${col}" IS NOT NULL
          AND category NOT IN ('sop-service-requests', 'sop-maintenance', 'sop-house-rules', 'sop-checkin-checkout', 'sop-escalation')
          AND category NOT IN ('sop-scheduling', 'sop-house-rules', 'sop-escalation-immediate', 'sop-escalation-scheduled')
        ORDER BY "${col}" <=> $1::vector(${embDim()})
        LIMIT $4`,
        embeddingStr, propertyId, tenantId, topK
      ) as ChunkRow[];
    } else {
      results = await (prisma.$queryRawUnsafe as any)(
        `SELECT id, content, category, "sourceKey", "propertyId",
          1 - ("${col}" <=> $1::vector(${embDim()})) as similarity
        FROM "PropertyKnowledgeChunk"
        WHERE ("propertyId" = $2 OR "propertyId" IS NULL)
          AND "tenantId" = $3
          AND "${col}" IS NOT NULL
          AND category NOT IN ('sop-scheduling', 'sop-house-rules', 'sop-escalation-immediate', 'sop-escalation-scheduled')
        ORDER BY "${col}" <=> $1::vector(${embDim()})
        LIMIT $4`,
        embeddingStr, propertyId, tenantId, topK
      ) as ChunkRow[];
    }

    // Log ALL results with scores for diagnostics
    console.log(`[RAG] raw results for "${query.substring(0, 60)}": ${results.map(r => `${r.sourceKey}(${Number(r.similarity).toFixed(3)})`).join(', ') || 'empty'}`);

    const MAX_CHUNKS = 3;
    const MIN_SIMILARITY = 0.3;
    let filtered = results.filter(r => Number(r.similarity) > MIN_SIMILARITY);

    // Rerank: cross-encoder re-scoring for better relevance ordering
    if (isRerankEnabled() && filtered.length > MAX_CHUNKS) {
      const reranked = await rerank(query, filtered.map(r => r.content), MAX_CHUNKS);
      if (reranked && reranked.length > 0) {
        filtered = reranked.map(r => ({
          ...filtered[r.index],
          similarity: r.relevanceScore as any, // use rerank score
        }));
        console.log(`[RAG] reranked: ${filtered.map(r => `${r.sourceKey}(${Number(r.similarity).toFixed(3)})`).join(', ')}`);
      } else {
        filtered = filtered.slice(0, MAX_CHUNKS);
      }
    } else {
      filtered = filtered.slice(0, MAX_CHUNKS);
    }

    console.log(`[RAG] retrieved ${filtered.length} chunks: ${filtered.map(r => `${r.sourceKey}(${Number(r.similarity).toFixed(3)})`).join(', ') || 'none'}`);
    const mappedChunks = filtered.map(r => ({
        content: r.content,
        category: r.category,
        similarity: Number(r.similarity),
        sourceKey: r.sourceKey,
        propertyId: r.propertyId,
      }));
    const topSimilarity = mappedChunks.length > 0 ? Math.max(...mappedChunks.map(r => r.similarity)) : 0;
    const tier = topSimilarity > HIGH_CONFIDENCE_THRESHOLD ? 'tier1' as const : 'tier2_needed' as const;
    console.log(`[RAG] tier=${tier} topSim=${topSimilarity.toFixed(3)} chunks=${mappedChunks.length}`);
    return { chunks: mappedChunks, topSimilarity, tier };
  } catch (err) {
    console.error('[RAG] retrieveRelevantKnowledge failed:', err);
    return { chunks: [], topSimilarity: 0, tier: 'tier2_needed' as const };
  }
}

// ─── SOP Seeding — tenant-level procedure chunks ──────────────────────────────

const SOP_CHUNKS = [
  // ─── Service: Cleaning ──────────────────────────────────────────────────────
  {
    category: 'sop-cleaning',
    sourceKey: 'sop-cleaning',
    content: `Guest asks for cleaning, housekeeping, maid service, tidying up, or mopping.

## CLEANING REQUESTS

Cleaning costs $20 per session. Available during working hours only (10am–5pm). Recurring cleaning is OK ($20 each session).

**Flow:**
1. Ask guest for preferred time (between 10am–5pm)
2. Guest confirms time → mention the $20 fee
3. Escalate as "scheduled" with time and fee confirmed

Mention the fee on confirmation, NOT on the first ask.

**After hours (after 5 PM):** Arrange for tomorrow. Ask for preferred time between 10am–5pm.

**Examples:**

Guest: "Can we get cleaning today?"
{"guest_message":"Sure, what time works for you? We do visits between 10am and 5pm.","escalation":null}

Guest: "Around 1pm"
{"guest_message":"Got it, housekeeping at 1pm. Just so you know, cleaning is $20 per session.","escalation":{"title":"cleaning-scheduled","note":"Guest [Name] in [Unit] — cleaning at 1pm. $20 confirmed.","urgency":"scheduled"}}

Guest: "Can someone clean?" (8pm)
{"guest_message":"I can arrange cleaning for tomorrow. What time works between 10am and 5pm?","escalation":null}`,
  },
  // ─── Service: Amenity Requests ──────────────────────────────────────────────
  {
    category: 'sop-amenity-request',
    sourceKey: 'sop-amenity-request',
    content: `Guest requests towels, extra towels, pillows, blankets, baby crib, extra bed, hair dryer, blender, kids dinnerware, espresso machine, hangers, or any item/amenity.

## AMENITY REQUESTS

Check the property amenities list for available items. Only confirm items explicitly listed there.
- Item on the amenities list → confirm availability, ask for delivery time during working hours (10am–5pm), then escalate as "scheduled"
- Item NOT on the list → say "Let me check on that" → escalate as "info_request"

**Examples:**

Guest: "Can I get extra towels?"
{"guest_message":"Of course, I'll arrange that for you. What time works between 10am and 5pm?","escalation":null}

Guest: "Do you have a phone charger?"
{"guest_message":"Let me check on that and get back to you.","escalation":{"title":"amenity-unlisted","note":"Guest [Name] in [Unit] asking for phone charger. Not on standard list.","urgency":"info_request"}}`,
  },
  // ─── Maintenance ────────────────────────────────────────────────────────────
  {
    category: 'sop-maintenance',
    sourceKey: 'sop-maintenance',
    content: `Guest reports something broken, not working, or needing repair — AC not cooling, no hot water, plumbing, leak, water damage, appliance broken, electricity issue, insects, bugs, pests, cockroach, mold, smell, noise from neighbors.

## MAINTENANCE & TECHNICAL ISSUES

Broken or malfunctioning items: Acknowledge the problem, assure guest someone will look into it, and escalate immediately.

**All maintenance/technical issues → urgency: "immediate"**

**Examples:**

Guest: "There's no hot water"
{"guest_message":"Sorry about that — I'm getting someone to look into it now.","escalation":{"title":"maintenance-no-hot-water","note":"Guest [Name] in [Unit] — no hot water. Needs ASAP.","urgency":"immediate"}}

Guest: "The AC isn't cooling"
{"guest_message":"Sorry about that, I'll have someone check it right away.","escalation":{"title":"maintenance-ac","note":"Guest [Name] in [Unit] — AC not cooling. Needs maintenance.","urgency":"immediate"}}

Guest: "There is a leak" / "Water is leaking"
{"guest_message":"I'm sorry about that. I'm escalating this to maintenance right away. Can you let me know where the leak is?","escalation":{"title":"maintenance-leak","note":"Guest [Name] in [Unit] — water leak reported. Needs immediate attention.","urgency":"immediate"}}

OPEN TASKS: [abc123] maintenance-no-hot-water (immediate)
Guest: "Hot water is working now, thanks!"
{"guest_message":"","escalation":null,"resolveTaskId":"abc123"}`,
  },
  // ─── WiFi & Door Code ──────────────────────────────────────────────────────
  {
    category: 'sop-wifi-doorcode',
    sourceKey: 'sop-wifi-doorcode',
    content: `Guest asks about WiFi password, WiFi network name, internet connection, door code, entry code, lock code, how to get in, or can't open the door.

## WIFI & DOOR CODE

WiFi credentials and door code are in PROPERTY & GUEST INFO under ACCESS & CONNECTIVITY. Give them directly.

If there's a **problem** (WiFi not working, code not working, can't connect, locked out) → escalate immediately.

**Examples:**

Guest: "What's the WiFi password?"
{"guest_message":"WiFi network is [name from info], password is [password from info].","escalation":null}

Guest: "The door code isn't working"
{"guest_message":"Sorry about that, let me get someone to help right away.","escalation":{"title":"door-code-issue","note":"Guest [Name] in [Unit] — door code not working. Needs immediate help.","urgency":"immediate"}}`,
  },
  // ─── Visitor Policy ─────────────────────────────────────────────────────────
  {
    category: 'sop-visitor-policy',
    sourceKey: 'sop-visitor-policy',
    content: `Guest wants to invite someone over, have a friend visit, bring a visitor, asks about visitor rules, or asks if someone can come to the apartment.

## VISITOR POLICY

- ONLY immediate family members allowed as visitors
- Guest must send visitor's passport through the chat
- Family names must match guest's family name
- Collect passport image → escalate for manager verification
- Non-family visitors (friends, colleagues, etc.) = NOT allowed

**Examples:**

Guest: "Can my friend come over for dinner?"
{"guest_message":"We only allow immediate family members as visitors. If they're family, please send their passport through the chat and we'll arrange access.","escalation":null}

Guest: "That's unfair, it's just one friend"
{"guest_message":"I understand, but this is a strict policy we need to follow. I'll pass your feedback along.","escalation":{"title":"house-rule-pushback","note":"Guest [Name] in [Unit] pushing back on visitor policy. Wants non-family friend. Needs manager.","urgency":"immediate"}}`,
  },
  // ─── Early Check-in ─────────────────────────────────────────────────────────
  {
    category: 'sop-early-checkin',
    sourceKey: 'sop-early-checkin',
    content: `Guest asks for early check-in, arriving early, wants to check in before 3pm, or asks if they can come earlier.

## EARLY CHECK-IN

Standard check-in: 3:00 PM. Back-to-back bookings mean early check-in can only be confirmed 2 days before.

**More than 2 days before check-in:** Do NOT escalate. Tell guest:
"We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab coffee at O1 Mall — it's a 1-minute walk."

**Within 2 days of check-in:** Tell guest you'll check → escalate as "info_request"

**Never confirm early check-in yourself.**

**Examples:**

Guest: "Can I check in at noon?" (check-in is far away)
{"guest_message":"We can only confirm early check-in 2 days before your date since there may be guests checking out. You're welcome to leave your bags with housekeeping and grab something at O1 Mall — it's a 1-minute walk.","escalation":null}

Guest: "I arrive tomorrow at 10am, early check-in?" (within 2 days)
{"guest_message":"Let me check on that for you and get back to you shortly.","escalation":{"title":"early-checkin","note":"Guest [Name] in [Unit] — early check-in tomorrow 10am. Within 2-day window.","urgency":"info_request"}}`,
  },
  // ─── Late Checkout ──────────────────────────────────────────────────────────
  {
    category: 'sop-late-checkout',
    sourceKey: 'sop-late-checkout',
    content: `Guest asks for late checkout, wants to leave later, stay longer on checkout day, check out after 11am, or extend their stay on the last day.

## LATE CHECKOUT

Standard check-out: 11:00 AM. Back-to-back bookings mean late checkout can only be confirmed 2 days before.

**More than 2 days before checkout:** Do NOT escalate. Tell guest the same 2-day rule.

**Within 2 days of checkout:** Tell guest you'll check → escalate as "info_request"

**Never confirm late checkout yourself.**

**Example:**

Guest: "Can I check out at 2pm instead of 11?"
{"guest_message":"Let me check on that for you and get back to you shortly.","escalation":{"title":"late-checkout","note":"Guest [Name] in [Unit] — wants late checkout at 2pm. Needs manager approval.","urgency":"info_request"}}`,
  },
  // ─── Escalation: Info Request ───────────────────────────────────────────────
  {
    category: 'sop-escalation-info',
    sourceKey: 'sop-escalation-info',
    content: `Guest asks something you can't answer — local recommendations, restaurants, pricing, discounts, refunds, reservation changes, or availability.

## ESCALATION — urgency: "info_request"

Use "info_request" when the manager needs to provide information:
- Local recommendations (restaurants, shops, activities)
- Reservation changes (dates, guest count)
- Early check-in/late checkout within 2-day window
- Refund or discount requests (NEVER authorize yourself)
- Any question not covered by your knowledge

**Examples:**

Guest: "Can you recommend a restaurant?"
{"guest_message":"Let me check and get back to you.","escalation":{"title":"local-recommendation","note":"Guest [Name] in [Unit] wants restaurant recommendation.","urgency":"info_request"}}

Guest: "I want a discount"
{"guest_message":"I'll pass that along to the team.","escalation":{"title":"discount-request","note":"Guest [Name] in [Unit] requesting discount. Needs manager decision.","urgency":"info_request"}}`,
  },
  // ─── New SOP Categories (11) — from v7_new_sop_chunks_and_seeds.json ──────
  {
    category: 'sop-booking-inquiry',
    sourceKey: 'sop-booking-inquiry',
    content: `BOOKING INQUIRY: Guest is asking about availability, unit options, or making a new reservation. Ask: dates, number of guests, any preferences (bedrooms, floor, view). Check if property/dates are available in your knowledge. If available, share rate and unit details. If not available or unsure, escalate as info_request with guest requirements. Never confirm a booking yourself — escalate with all details for manager to finalize. For urgent same-day requests, escalate as immediate.`,
  },
  {
    category: 'pricing-negotiation',
    sourceKey: 'pricing-negotiation',
    content: `PRICING/NEGOTIATION: Guest is asking about rates, requesting discounts, or expressing budget concerns. Share the standard rate from your knowledge if available. NEVER offer discounts, special rates, or price matches yourself. If guest asks for better price, weekly/monthly rate, or says it's too expensive, acknowledge and escalate as info_request with the guest's budget/request details. Don't apologize for pricing — present it neutrally. For long-term stay pricing, also tag with sop-long-term-rental.`,
  },
  {
    category: 'pre-arrival-logistics',
    sourceKey: 'pre-arrival-logistics',
    content: `PRE-ARRIVAL LOGISTICS: Guest is coordinating arrival — sharing ETA, asking for directions, requesting location pin, or arranging airport transfer. Share property address and location from your knowledge. If guest asks for directions from a specific location, share what you know. For airport transfer requests, escalate as info_request. If guest shares arrival time, confirm and escalate as scheduled so someone can meet them if needed. For late arrivals (after 10pm), escalate as immediate.`,
  },
  {
    category: 'sop-booking-modification',
    sourceKey: 'sop-booking-modification',
    content: `BOOKING MODIFICATION: Guest wants to change dates, add/remove nights, change unit, or update guest count. Acknowledge the request. NEVER confirm modifications yourself. Escalate as info_request with: current booking details, requested changes, and reason if provided. For date changes within 48 hours of check-in, escalate as immediate. For guest count changes that might affect unit assignment, note the new count clearly.`,
  },
  {
    category: 'sop-booking-confirmation',
    sourceKey: 'sop-booking-confirmation',
    content: `BOOKING CONFIRMATION: Guest is verifying their reservation exists, checking dates/details, or asking about booking status. Check reservation details in your knowledge and confirm what you can see — dates, unit, guest count. If the booking isn't in your system, ask which platform they booked through (Airbnb, Booking.com, direct) and escalate as info_request. For guests claiming they booked but no record found, escalate as immediate.`,
  },
  {
    category: 'payment-issues',
    sourceKey: 'payment-issues',
    content: `PAYMENT ISSUES: Guest has questions about payment methods, failed transactions, receipts, billing disputes, or refund status. NEVER process payments, confirm receipt of payment, or authorize refunds yourself. For payment link issues, escalate as immediate. For receipt requests, escalate as info_request. For billing disputes or refund requests, acknowledge and escalate as immediate with full details. For deposit return questions, escalate as info_request.`,
  },
  {
    category: 'post-stay-issues',
    sourceKey: 'post-stay-issues',
    content: `POST-STAY ISSUES: Guest has checked out and contacts about lost items, post-stay complaints, damage deposit questions, or feedback. For lost items: ask for description and location where they think they left it. Escalate as immediate so staff can check. For damage deposit questions, escalate as info_request. For post-stay complaints, acknowledge with empathy and escalate as immediate. Never promise items will be found or deposits returned.`,
  },
  {
    category: 'sop-long-term-rental',
    sourceKey: 'sop-long-term-rental',
    content: `LONG-TERM RENTAL: Guest is inquiring about monthly stays, corporate housing, or stays longer than 2 weeks. Ask: duration needed, move-in date, number of guests, any preferences. Share standard nightly rate if known, but note that monthly rates are different and need manager approval. Escalate as info_request with all details. For corporate stays, ask if they need a contract or invoice. Never quote monthly rates yourself.`,
  },
  {
    category: 'sop-booking-cancellation',
    sourceKey: 'sop-booking-cancellation',
    content: `BOOKING CANCELLATION: Guest wants to cancel their reservation or is asking about cancellation policy. Acknowledge the request. NEVER cancel bookings or confirm cancellation yourself. Ask which booking/dates they want to cancel if not clear. Escalate as info_request with booking details and reason for cancellation. For cancellation policy questions, escalate as info_request — policies vary by platform (Airbnb, Booking.com, direct). For refund-after-cancellation questions, also tag with payment-issues.`,
  },
  {
    category: 'sop-property-viewing',
    sourceKey: 'sop-property-viewing',
    content: `PROPERTY VIEWING: Guest wants to see the apartment before booking, requests photos/video, or asks about filming/photoshoot permission. For viewing requests: ask preferred date/time, escalate as info_request. Share existing photos from your knowledge if available. For video requests, escalate as info_request. For photoshoot/filming requests, ask about scope (how many people, duration, commercial or personal) and escalate as immediate — needs manager approval.`,
  },
  {
    category: 'non-actionable',
    sourceKey: 'non-actionable',
    content: `NON-ACTIONABLE: Message has no real intent — test messages, wrong chat, system messages, or greetings with no question. For greetings ('Hi', 'Hello'), respond with a friendly greeting and ask how you can help. For test messages, respond briefly. For wrong-chat messages, let them know politely. For system/automated messages, ignore (guest_message: '', escalation: null).`,
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
  // 1. Delete existing SOP chunks for this tenant (propertyId IS NULL, all seeded categories)
  await prisma.$executeRaw`
    DELETE FROM "PropertyKnowledgeChunk"
    WHERE "propertyId" IS NULL
      AND "tenantId" = ${tenantId}
      AND (category LIKE 'sop-%' OR category IN ('pricing-negotiation', 'pre-arrival-logistics', 'payment-issues', 'post-stay-issues', 'non-actionable', 'property-info', 'property-description'))
  `;

  const vectorEnabled = await isPgvectorAvailable(prisma);

  // 2. Embed all SOP chunks (only if vector column exists)
  let embeddings: number[][] = [];
  if (vectorEnabled) {
    try {
      embeddings = await embedBatch(SOP_CHUNKS.map(c => c.content), 'search_document');
    } catch (err) {
      console.warn('[RAG] SOP embedding failed, storing without embeddings:', err);
    }
  }

  // 3. Insert each SOP chunk
  const col = embCol();
  let inserted = 0;
  for (let i = 0; i < SOP_CHUNKS.length; i++) {
    const chunk = SOP_CHUNKS[i];
    const id = generateId();
    const embedding = embeddings[i];

    try {
      if (vectorEnabled && embedding && embedding.length > 0) {
        const embeddingStr = `[${embedding.join(',')}]`;
        await (prisma.$executeRawUnsafe as any)(
          `INSERT INTO "PropertyKnowledgeChunk"
            (id, "tenantId", "propertyId", content, category, "sourceKey", "${col}", "createdAt", "updatedAt")
          VALUES ($1, $2, NULL, $3, $4, $5, $6::vector(${embDim()}), now(), now())`,
          id, tenantId, chunk.content, chunk.category, chunk.sourceKey, embeddingStr
        );
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

  // Trigger classifier initialization (non-blocking)
  initializeClassifier().catch(err =>
    console.warn('[RAG] Classifier init failed (non-fatal):', err)
  );

  return inserted;
}
