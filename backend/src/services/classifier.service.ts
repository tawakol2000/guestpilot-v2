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

import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { embedText, embedBatch } from './embeddings.service';
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

// ─── State (atomic swap pattern — FR-007) ───────────────────────────────
interface ClassifierState {
  // Existing fields:
  examples: TrainingExample[];
  embeddings: number[][];
  initDurationMs: number;
  // LR classifier (T005):
  lrWeights: {
    classes: string[];
    coefficients: number[][];  // [n_classes x embedding_dim]
    intercepts: number[];      // [n_classes]
  } | null;
  lrThresholds: {
    global: number;
    perCategory: Record<string, number>;
  } | null;
  centroids: Record<string, number[]>;  // mean embedding per category
  calibration: {
    crossValAccuracy: number;
    perCategoryAccuracy: Record<string, number>;
  } | null;
  trainedAt: string | null;
}

// ─── Exported result types ──────────────────────────────────────────────

export interface ClassificationResult {
  // LR decision (primary)
  labels: string[];
  confidence: number;
  tier: 'high' | 'medium' | 'low';
  topCandidates: Array<{ label: string; confidence: number }>;
  method: string;  // 'lr_sigmoid'
  // KNN diagnostic (for pipeline display)
  knnDiagnostic: {
    topSimilarity: number;
    method: string;
    labels: string[];
    neighbors: Array<{ text: string; labels: string[]; similarity: number }>;
  };
  // Backward-compat surface (consumed by rag.service, knowledge routes, batchClassify)
  topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
  neighbors: Array<{ labels: string[]; similarity: number }>;
  tokensUsed: number;
  topSimilarity: number;
}

let _initialized = false;
let _initializingPromise: Promise<void> | null = null;
let _state: ClassifierState | null = null;
let _reinitPromise: Promise<void> | null = null;

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
  lrAccuracy: number | null;
  lastTrainedAt: string | null;
} {
  return {
    initialized: _initialized,
    exampleCount: _state?.examples.length ?? 0,
    initDurationMs: _state?.initDurationMs ?? 0,
    sopChunkCount: Object.keys(SOP_CONTENT).length,
    bakedInCount: BAKED_IN_CHUNKS.size,
    lrAccuracy: _state?.calibration?.crossValAccuracy ?? null,
    lastTrainedAt: _state?.trainedAt ?? null,
  };
}

/**
 * Return the current state's calibration data (for classifier-status endpoint).
 */
export function getClassifierCalibration(): {
  crossValAccuracy: number;
  perCategoryAccuracy: Record<string, number>;
} | null {
  return _state?.calibration ?? null;
}

/**
 * Load full LR weights + metadata from classifier-weights.json (if it exists).
 * Populates lrWeights, lrThresholds, centroids, calibration, trainedAt on the current state.
 * Called after training completes and on startup/reinit.
 */
export function loadLrWeightsMetadata(): void {
  try {
    const weightsPath = path.join(__dirname, '../config/classifier-weights.json');
    if (!fs.existsSync(weightsPath)) {
      console.log('[Classifier] No classifier-weights.json found — LR classifier not loaded');
      return;
    }

    const data = JSON.parse(fs.readFileSync(weightsPath, 'utf-8'));

    const lrWeights = (data.classes && data.coefficients && data.intercepts) ? {
      classes: data.classes as string[],
      coefficients: data.coefficients as number[][],
      intercepts: data.intercepts as number[],
    } : null;

    const lrThresholds = data.thresholds ? {
      global: data.thresholds.global ?? 0.5,
      perCategory: data.thresholds.perCategory ?? {},
    } : null;

    const centroids: Record<string, number[]> = data.centroids ?? {};

    const calibration = data.calibration ? {
      crossValAccuracy: data.calibration.crossValAccuracy ?? 0,
      perCategoryAccuracy: data.calibration.perCategoryAccuracy ?? {},
    } : null;

    const trainedAt: string | null = data.trainedAt ?? null;

    if (_state) {
      _state.lrWeights = lrWeights;
      _state.lrThresholds = lrThresholds;
      _state.centroids = centroids;
      _state.calibration = calibration;
      _state.trainedAt = trainedAt;
    }

    console.log(`[Classifier] LR weights loaded: ${lrWeights ? lrWeights.classes.length + ' classes' : 'no weights'}, accuracy=${calibration?.crossValAccuracy ?? 'n/a'}, trainedAt=${trainedAt}`);
  } catch (err) {
    console.warn('[Classifier] Could not load LR weights:', err);
  }
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
      const examples = TRAINING_EXAMPLES.map(ex => ({
        text: ex.text,
        labels: ex.labels.filter(l => !BAKED_IN_CHUNKS.has(l)),
      }));

      // Embed all training examples
      const texts = examples.map(e => e.text);
      const embeddings = await embedBatch(texts, 'classification');

      // Verify embeddings
      const validCount = embeddings.filter(e => e && e.length > 0).length;
      if (validCount < examples.length * 0.9) {
        console.error(`[Classifier] Only ${validCount}/${examples.length} examples embedded — aborting`);
        _initializingPromise = null;
        return;
      }

      const initDurationMs = Date.now() - startMs;

      // Atomic swap — readers see either the old state or the complete new state
      _state = {
        examples,
        embeddings,
        initDurationMs,
        lrWeights: null,
        lrThresholds: null,
        centroids: {},
        calibration: null,
        trainedAt: null,
      };
      _initialized = true;
      console.log(`[Classifier] Initialized: ${examples.length} examples, ${initDurationMs}ms`);
    } catch (err) {
      console.error('[Classifier] Initialization failed:', err);
      _initializingPromise = null;
    }
  })();

  return _initializingPromise;
}

// ─── LR Inference (T006) ──────────────────────────────────────────────────

function classifyWithLR(
  embedding: number[],
  state: ClassifierState,
  highThreshold: number = 0.85,
  lowThreshold: number = 0.55
): {
  labels: string[];
  confidence: number;
  topCandidates: Array<{ label: string; confidence: number }>;
  tier: 'high' | 'medium' | 'low';
} {
  if (!state.lrWeights) throw new Error('LR classifier not trained. Run retrain first.');

  const { classes, coefficients, intercepts } = state.lrWeights;
  const perCatThresholds = state.lrThresholds?.perCategory || {};

  // Compute sigmoid scores per label (OneVsRest)
  const scores: Array<{ label: string; confidence: number }> = [];
  for (let i = 0; i < classes.length; i++) {
    // Dot product + intercept
    let logit = intercepts[i];
    for (let j = 0; j < embedding.length; j++) {
      logit += coefficients[i][j] * embedding[j];
    }
    // Sigmoid
    const prob = 1 / (1 + Math.exp(-logit));
    scores.push({ label: classes[i], confidence: prob });
  }

  // Sort by confidence descending
  scores.sort((a, b) => b.confidence - a.confidence);

  // Get labels above per-category threshold
  const labels = scores
    .filter(s => s.confidence >= (perCatThresholds[s.label] || state.lrThresholds?.global || 0.5))
    .map(s => s.label);

  const maxConfidence = scores.length > 0 ? scores[0].confidence : 0;
  const tier: 'high' | 'medium' | 'low' =
    maxConfidence >= highThreshold ? 'high' :
    maxConfidence >= lowThreshold ? 'medium' : 'low';

  return {
    labels,
    confidence: maxConfidence,
    topCandidates: scores.slice(0, 5),  // top 5 for logging
    tier,
  };
}

// ─── KNN Diagnostic (internal — runs alongside LR for pipeline display) ──

function runKnnDiagnostic(
  queryEmbedding: number[],
  state: ClassifierState,
  overrideVoteThreshold?: number
): {
  topSimilarity: number;
  method: string;
  labels: string[];
  neighbors: Array<{ text: string; labels: string[]; similarity: number }>;
  topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
} {
  // Compute cosine similarity with all training examples
  const similarities: Array<{ index: number; similarity: number }> = [];
  for (let i = 0; i < state.embeddings.length; i++) {
    const emb = state.embeddings[i];
    if (!emb || emb.length === 0) continue;
    similarities.push({ index: i, similarity: cosineSimilarity(queryEmbedding, emb) });
  }
  similarities.sort((a, b) => b.similarity - a.similarity);

  // KNN-3 cosine-only (diagnostic — no async rerank)
  const topK = similarities.slice(0, K);
  const knnMethod = 'knn_vote';

  const topKDetails = topK.map(({ index, similarity }) => ({
    index,
    similarity,
    text: state.examples[index].text,
    labels: state.examples[index].labels,
  }));

  const topSimilarity = topK.length > 0 ? topK[0].similarity : 0;

  const knnNeighbors = topKDetails.map(n => ({
    text: n.text,
    labels: n.labels,
    similarity: n.similarity,
  }));

  // Weighted voting for KNN labels
  const votes: Record<string, number> = {};
  const labelCounts: Record<string, number> = {};
  for (const { index, similarity } of topK) {
    for (const label of state.examples[index].labels) {
      votes[label] = (votes[label] || 0) + similarity;
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
  }
  const totalWeight = topK.reduce((sum, { similarity }) => sum + similarity, 0);

  const effectiveThreshold = overrideVoteThreshold ?? _voteThreshold;
  const knnLabels = Object.entries(votes)
    .filter(([label, weight]) =>
      weight / totalWeight > effectiveThreshold &&
      (labelCounts[label] || 0) >= MIN_NEIGHBOR_AGREEMENT
    )
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  return {
    topSimilarity,
    method: knnMethod,
    labels: knnLabels,
    neighbors: knnNeighbors,
    topK: topKDetails,
  };
}

/**
 * Classify a guest message using LR (primary) with KNN diagnostic.
 * Returns empty labels if classifier not initialized (graceful degradation).
 * Requires LR weights to be loaded — throws if not trained.
 */
export async function classifyMessage(query: string, overrideVoteThreshold?: number): Promise<ClassificationResult> {
  // Snapshot state for thread-safe reads during classification (FR-007)
  const state = _state;
  if (!state || state.embeddings.length === 0) {
    return {
      labels: [], confidence: 0, tier: 'low', topCandidates: [], method: 'classifier_not_initialized',
      knnDiagnostic: { topSimilarity: 0, method: 'none', labels: [], neighbors: [] },
      topK: [], neighbors: [], tokensUsed: 0, topSimilarity: 0,
    };
  }

  // Embed the query (classification mode for Cohere input_type)
  const queryEmbedding = await embedText(query, 'classification');
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return {
      labels: [], confidence: 0, tier: 'low', topCandidates: [], method: 'embedding_failed',
      knnDiagnostic: { topSimilarity: 0, method: 'none', labels: [], neighbors: [] },
      topK: [], neighbors: [], tokensUsed: 0, topSimilarity: 0,
    };
  }

  // Require LR weights — fail loudly if not trained
  if (state.lrWeights === null) {
    throw new Error('LR classifier not trained. Run POST /api/knowledge/retrain-classifier first.');
  }

  // Primary: LR sigmoid classification (T006)
  const lrResult = classifyWithLR(queryEmbedding, state);

  // Diagnostic: KNN (for pipeline display, kept for backward compat)
  const knnDiag = runKnnDiagnostic(queryEmbedding, state, overrideVoteThreshold);

  // Apply token budget to LR labels
  const { labels: budgetedLabels, tokensUsed } = applyTokenBudget(lrResult.labels);

  // Backward-compat neighbors surface (from KNN diagnostic)
  const neighbors = knnDiag.topK.map(n => ({ labels: n.labels, similarity: n.similarity }));

  return {
    // LR decision (primary)
    labels: budgetedLabels,
    confidence: lrResult.confidence,
    tier: lrResult.tier,
    topCandidates: lrResult.topCandidates,
    method: 'lr_sigmoid',
    // KNN diagnostic
    knnDiagnostic: {
      topSimilarity: knnDiag.topSimilarity,
      method: knnDiag.method,
      labels: knnDiag.labels,
      neighbors: knnDiag.neighbors,
    },
    // Backward-compat surface
    topK: knnDiag.topK,
    neighbors,
    tokensUsed,
    topSimilarity: knnDiag.topSimilarity,
  };
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
  const state = _state;
  if (!state || state.examples.length === 0) return 0;
  const embedding = await embedText(text, 'classification');
  if (!embedding) return 0;

  let maxSim = 0;
  for (let i = 0; i < state.examples.length; i++) {
    const ex = state.examples[i];
    if (!ex.labels.some(l => labels.includes(l))) continue;
    const sim = cosineSimilarity(embedding, state.embeddings[i]);
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
  // Deduplication guard — coalesce concurrent reinit requests (T023)
  if (_reinitPromise) return _reinitPromise;

  const doReinit = async (): Promise<void> => {
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

      const examples = [...baseExamples, ...newExamples];

      const texts = examples.map(e => e.text);
      const embeddings = await embedBatch(texts, 'classification');

      const initDurationMs = Date.now() - startMs;

      // Load LR weights from classifier-weights.json (T008)
      let lrWeights: ClassifierState['lrWeights'] = null;
      let lrThresholds: ClassifierState['lrThresholds'] = null;
      let centroids: ClassifierState['centroids'] = {};
      let calibration: ClassifierState['calibration'] = null;
      let trainedAt: ClassifierState['trainedAt'] = null;

      try {
        const weightsPath = path.join(__dirname, '../config/classifier-weights.json');
        if (fs.existsSync(weightsPath)) {
          const data = JSON.parse(fs.readFileSync(weightsPath, 'utf-8'));

          if (data.classes && data.coefficients && data.intercepts) {
            lrWeights = {
              classes: data.classes as string[],
              coefficients: data.coefficients as number[][],
              intercepts: data.intercepts as number[],
            };
          }

          if (data.thresholds) {
            lrThresholds = {
              global: data.thresholds.global ?? 0.5,
              perCategory: data.thresholds.perCategory ?? {},
            };
          }

          centroids = data.centroids ?? {};

          if (data.calibration) {
            calibration = {
              crossValAccuracy: data.calibration.crossValAccuracy ?? 0,
              perCategoryAccuracy: data.calibration.perCategoryAccuracy ?? {},
            };
          }

          trainedAt = data.trainedAt ?? null;

          console.log(`[Classifier] LR weights loaded during reinit: ${lrWeights ? lrWeights.classes.length + ' classes' : 'no weights'}, accuracy=${calibration?.crossValAccuracy ?? 'n/a'}`);
        } else {
          console.log('[Classifier] No classifier-weights.json found during reinit — LR classifier not loaded');
        }
      } catch (weightsErr) {
        console.warn('[Classifier] Could not load classifier-weights.json during reinit:', weightsErr);
      }

      // Atomic swap — readers see either the old state or the complete new state (FR-007)
      _state = {
        examples,
        embeddings,
        initDurationMs,
        lrWeights,
        lrThresholds,
        centroids,
        calibration,
        trainedAt,
      };
      _initialized = true;
      console.log(`[Classifier] Re-initialized: ${examples.length} examples (${newExamples.length} from DB), ${initDurationMs}ms`);
    } catch (err) {
      console.error('[Classifier] Re-initialization failed:', err);
    }
  };

  _reinitPromise = doReinit().finally(() => { _reinitPromise = null; });
  return _reinitPromise;
}

/**
 * Batch classify multiple messages. Used by the gap analysis and testing UIs.
 * Optionally override the vote threshold for experimentation.
 */
export async function batchClassify(
  messages: string[],
  overrideVoteThreshold?: number
): Promise<{
  results: Array<{ message: string; labels: string[]; topSimilarity: number; method: string }>;
  threshold: number;
  emptyLabelCount: number;
  totalMessages: number;
}> {
  const results = [];
  for (const msg of messages) {
    const result = await classifyMessage(msg, overrideVoteThreshold);
    results.push({
      message: msg,
      labels: result.labels,
      topSimilarity: result.topSimilarity,
      method: result.method,
    });
  }
  const emptyLabelCount = results.filter(r => r.labels.length === 0).length;
  return { results, threshold: overrideVoteThreshold ?? _voteThreshold, emptyLabelCount, totalMessages: messages.length };
}
