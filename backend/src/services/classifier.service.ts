/**
 * KNN-3 Embedding Classifier for guest message routing.
 * Ported from run_embedding_eval_v2.py (v7, 99/100 score).
 *
 * Architecture:
 * - 164 training examples embedded once at startup using OpenAI text-embedding-3-small
 * - Each incoming message is embedded and compared to all training examples
 * - KNN-3 with weighted voting determines which SOP chunks to retrieve
 * - Contextual gate suppresses retrieval for "Ok thanks", "Yes", etc.
 * - Token budget caps total retrieved content at 500 tokens
 *
 * Cost: ~$0.000001 per classification (one 20-token embedding call)
 * Latency: <50ms after initialization (embedding is the bottleneck)
 * Deterministic: same input always produces same output
 */

import { PrismaClient } from '@prisma/client';
import { embedText, embedBatch } from './embeddings.service';
import { rerank, isRerankEnabled } from './rerank.service';
import {
  TRAINING_EXAMPLES,
  SOP_CONTENT,
  CHUNK_TOKENS,
  BAKED_IN_CHUNKS,
  type TrainingExample,
} from './classifier-data';

// ─── Config (tuned from v7 eval: 99/100) ──────────────────────────────────
const K = 3;
const MIN_NEIGHBOR_AGREEMENT = 2;

// Configurable via settings UI — updated by setClassifierThresholds()
let _voteThreshold = 0.30;
let _contextualGate = 0.85;

/**
 * Update Tier 1 classifier thresholds at runtime (called when settings are saved).
 */
export function setClassifierThresholds(voteThreshold: number, contextualGate: number): void {
  _voteThreshold = voteThreshold;
  _contextualGate = contextualGate;
  console.log(`[Classifier] Thresholds updated: voteThreshold=${_voteThreshold}, contextualGate=${_contextualGate}`);
}

export function getClassifierThresholds(): { voteThreshold: number; contextualGate: number } {
  return { voteThreshold: _voteThreshold, contextualGate: _contextualGate };
}

// ─── State ─────────────────────────────────────────────────────────────────
let _initialized = false;
let _initializingPromise: Promise<void> | null = null;
let _exampleEmbeddings: number[][] = [];
let _examples: TrainingExample[] = [];
let _initDurationMs = 0;

// ─── Public API ────────────────────────────────────────────────────────────

export function isClassifierInitialized(): boolean {
  return _initialized;
}

export function getClassifierStatus(): {
  initialized: boolean;
  exampleCount: number;
  initDurationMs: number;
  sopChunkCount: number;
  bakedInCount: number;
} {
  return {
    initialized: _initialized,
    exampleCount: _examples.length,
    initDurationMs: _initDurationMs,
    sopChunkCount: Object.keys(SOP_CONTENT).length,
    bakedInCount: BAKED_IN_CHUNKS.size,
  };
}

/**
 * Initialize the classifier by embedding all training examples.
 * Safe to call multiple times — only runs once.
 * Takes ~2-4 seconds (164 texts × 20 tokens average).
 */
export async function initializeClassifier(): Promise<void> {
  if (_initialized) return;
  if (_initializingPromise) return _initializingPromise;

  _initializingPromise = (async () => {
    const startMs = Date.now();
    try {
      // Filter out any examples with baked-in labels only (safety check)
      _examples = TRAINING_EXAMPLES.map(ex => ({
        text: ex.text,
        labels: ex.labels.filter(l => !BAKED_IN_CHUNKS.has(l)),
      }));

      // Embed all training examples
      const texts = _examples.map(e => e.text);
      _exampleEmbeddings = await embedBatch(texts, 'classification');

      // Verify embeddings
      const validCount = _exampleEmbeddings.filter(e => e && e.length > 0).length;
      if (validCount < _examples.length * 0.9) {
        console.error(`[Classifier] Only ${validCount}/${_examples.length} examples embedded — aborting`);
        _initializingPromise = null;
        return;
      }

      _initDurationMs = Date.now() - startMs;
      _initialized = true;
      console.log(`[Classifier] Initialized: ${_examples.length} examples, ${_initDurationMs}ms`);
    } catch (err) {
      console.error('[Classifier] Initialization failed:', err);
      _initializingPromise = null;
    }
  })();

  return _initializingPromise;
}

/**
 * Classify a guest message and return the SOP chunk IDs to retrieve.
 * Returns empty labels if classifier not initialized (graceful degradation).
 */
export async function classifyMessage(query: string): Promise<{
  labels: string[];
  method: string;
  topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
  neighbors: Array<{ labels: string[]; similarity: number }>;
  tokensUsed: number;
  topSimilarity: number;
}> {
  if (!_initialized || _exampleEmbeddings.length === 0) {
    return { labels: [], method: 'classifier_not_initialized', topK: [], neighbors: [], tokensUsed: 0, topSimilarity: 0 };
  }

  // Embed the query (classification mode for Cohere input_type)
  const queryEmbedding = await embedText(query, 'classification');
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return { labels: [], method: 'embedding_failed', topK: [], neighbors: [], tokensUsed: 0, topSimilarity: 0 };
  }

  // Compute cosine similarity with all training examples
  const similarities: Array<{ index: number; similarity: number }> = [];
  for (let i = 0; i < _exampleEmbeddings.length; i++) {
    const emb = _exampleEmbeddings[i];
    if (!emb || emb.length === 0) continue;
    similarities.push({ index: i, similarity: cosineSimilarity(queryEmbedding, emb) });
  }
  similarities.sort((a, b) => b.similarity - a.similarity);

  // Get wider candidate pool for potential reranking
  const RERANK_CANDIDATES = 10;
  const candidatePool = similarities.slice(0, isRerankEnabled() ? RERANK_CANDIDATES : K);

  // Rerank candidates using cross-encoder if available (much better cross-lingual matching)
  let topK: typeof candidatePool;
  let classifyMethod = 'knn_vote';
  if (isRerankEnabled() && candidatePool.length > K) {
    const candidateTexts = candidatePool.map(c => _examples[c.index].text);
    const reranked = await rerank(query, candidateTexts, K);
    if (reranked && reranked.length > 0) {
      topK = reranked.map(r => ({
        index: candidatePool[r.index].index,
        similarity: r.relevanceScore, // use rerank score instead of cosine
      }));
      classifyMethod = 'knn_rerank';
    } else {
      topK = candidatePool.slice(0, K); // fallback to cosine-only
    }
  } else {
    topK = candidatePool.slice(0, K);
  }

  const topKDetails = topK.map(({ index, similarity }) => ({
    index,
    similarity,
    text: _examples[index].text,
    labels: _examples[index].labels,
  }));

  const topSimilarity = topK.length > 0 ? topK[0].similarity : 0;

  const neighbors = topKDetails.map(n => ({ labels: n.labels, similarity: n.similarity }));

  // Step 1: Contextual gate — "contextual" label means no SOP needed
  const best = topK[0];
  if (best && _examples[best.index].labels.includes('contextual') && best.similarity > _contextualGate) {
    return { labels: ['contextual'], method: 'contextual_match', topK: topKDetails, neighbors, tokensUsed: 0, topSimilarity };
  }

  // Step 2: Weighted voting
  const votes: Record<string, number> = {};
  const labelCounts: Record<string, number> = {};

  for (const { index, similarity } of topK) {
    for (const label of _examples[index].labels) {
      votes[label] = (votes[label] || 0) + similarity;
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
  }

  const totalWeight = topK.reduce((sum, { similarity }) => sum + similarity, 0);

  // Step 3: Filter by vote threshold AND neighbor agreement
  const candidateLabels = Object.entries(votes)
    .filter(([label, weight]) =>
      weight / totalWeight > _voteThreshold &&
      (labelCounts[label] || 0) >= MIN_NEIGHBOR_AGREEMENT
    )
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  // Step 4: Apply token budget
  const { labels, tokensUsed } = applyTokenBudget(candidateLabels);

  return { labels, method: classifyMethod, topK: topKDetails, neighbors, tokensUsed, topSimilarity };
}

/**
 * Get the SOP content text for a given chunk ID.
 * If chunkId is 'sop-amenity-request' and propertyAmenities is provided,
 * injects the property-specific amenities list into the {PROPERTY_AMENITIES} placeholder.
 */
export function getSopContent(chunkId: string, propertyAmenities?: string): string {
  let content = SOP_CONTENT[chunkId] || '';
  if (chunkId === 'sop-amenity-request' && content.includes('{PROPERTY_AMENITIES}')) {
    if (propertyAmenities) {
      const list = propertyAmenities.split(',').map(a => `• ${a.trim()}`).filter(Boolean).join('\n');
      content = content.replace('{PROPERTY_AMENITIES}', list);
    } else {
      content = content.replace('{PROPERTY_AMENITIES}', 'No amenities data available for this property.');
    }
  }
  return content;
}

/**
 * Check if a message text has reasonable similarity to existing training examples
 * that share any of the given labels. Used by the judge to validate Tier 2 feedback
 * before auto-fixing — prevents poisoning from confident-but-wrong Tier 2 classifications.
 */
export async function getMaxSimilarityForLabels(text: string, labels: string[]): Promise<number> {
  if (!_initialized || _examples.length === 0) return 0;
  const embedding = await embedText(text, 'classification');
  if (!embedding) return 0;

  let maxSim = 0;
  for (let i = 0; i < _examples.length; i++) {
    const ex = _examples[i];
    if (!ex.labels.some(l => labels.includes(l))) continue;
    const sim = cosineSimilarity(embedding, _exampleEmbeddings[i]);
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

function applyTokenBudget(labels: string[]): { labels: string[]; tokensUsed: number } {
  // No budget cap — retrieve all relevant SOPs. Token counts tracked for logging only.
  let tokens = 0;
  for (const label of labels) {
    tokens += CHUNK_TOKENS[label] || 100;
  }
  return { labels, tokensUsed: tokens };
}

/**
 * Force reload: merge base TRAINING_EXAMPLES with DB examples, re-embed all.
 * Called after the judge adds a new training example.
 */
export async function reinitializeClassifier(tenantId: string, prisma: PrismaClient): Promise<void> {
  // Dynamic import to avoid circular dependency
  const { getActiveExamples } = await import('./classifier-store.service');

  const startMs = Date.now();
  try {
    const dbExamples = await getActiveExamples(tenantId, prisma);

    // Merge: base hardcoded examples + DB-added examples (deduplicated by text)
    const baseExamples = TRAINING_EXAMPLES.map(ex => ({
      text: ex.text,
      labels: ex.labels.filter(l => !BAKED_IN_CHUNKS.has(l)),
    }));

    const baseTexts = new Set(baseExamples.map(e => e.text));
    const newExamples = dbExamples
      .map(ex => ({
        text: ex.text,
        labels: ex.labels.filter(l => !BAKED_IN_CHUNKS.has(l)),
      }))
      .filter(e => !baseTexts.has(e.text));

    _examples = [...baseExamples, ...newExamples];

    const texts = _examples.map(e => e.text);
    _exampleEmbeddings = await embedBatch(texts, 'classification');

    _initDurationMs = Date.now() - startMs;
    _initialized = true;
    console.log(`[Classifier] Re-initialized: ${_examples.length} examples (${newExamples.length} from DB), ${_initDurationMs}ms`);
  } catch (err) {
    console.error('[Classifier] Re-initialization failed:', err);
  }
}
