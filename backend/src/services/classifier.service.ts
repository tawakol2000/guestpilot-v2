/**
 * LR Sigmoid Classifier (with Similarity Boost for observability) for guest message routing.
 * Ported from run_embedding_eval_v2.py (v7, 99/100 score).
 *
 * Architecture:
 * - 164 training examples embedded once at startup using OpenAI text-embedding-3-small
 * - Each incoming message is embedded and scored by a logistic-regression sigmoid model
 * - LR inference with three-tier confidence routing determines which SOP chunks to retrieve
 * - KNN-3 runs alongside as a diagnostic signal for observability (not used for routing)
 * - Contextual gate suppresses retrieval for "Ok thanks", "Yes", etc.
 * - Token budget caps total retrieved content at 500 tokens
 *
 * Cost: ~$0.000001 per classification (one 20-token embedding call + local LR inference)
 * Latency: <50ms after initialization (embedding is the bottleneck, LR inference is <1ms)
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

/**
 * Update boost similarity threshold at runtime (called when settings are saved).
 */
export function setBoostThreshold(threshold: number): void {
  _boostConfig.boostSimilarityThreshold = threshold;
  console.log(`[Classifier] Boost threshold updated: ${threshold}`);
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
  // T004: Description embeddings for description-enhanced LR
  descriptionEmbeddings: Map<string, number[][]> | null;  // category → array of embeddings
  descriptionCategories: string[] | null;                   // Sorted category names (canonical order)
  descriptionFeaturesActive: boolean;                       // true if weights match augmented dimension
}

// ─── Exported result types ──────────────────────────────────────────────

export interface ClassificationResult {
  // LR decision (primary)
  labels: string[];
  confidence: number;
  tier: 'high' | 'medium' | 'low';
  topCandidates: Array<{ label: string; confidence: number }>;
  method: string;  // 'lr_sigmoid' | 'lr_boost' | 'lr_desc' | 'embedding_failed' | 'classifier_not_initialized'
  // Similarity Boost (renamed from knnDiagnostic — T003)
  similarityBoost: {
    topSimilarity: number;
    method: string;  // 'similarity_boost'
    labels: string[];
    neighbors: Array<{ text: string; labels: string[]; similarity: number }>;
  };
  // Boost decision metadata (T003)
  boostApplied: boolean;
  boostSimilarity: number;
  boostLabels: string[];
  originalLrConfidence: number;
  originalLrLabels: string[];
  // Description feature metadata (T003)
  descriptionFeaturesActive: boolean;
  topDescriptionMatches: Array<{ label: string; similarity: number }>;
  // Backward-compat surface (consumed by rag.service, knowledge routes, batchClassify)
  topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
  neighbors: Array<{ labels: string[]; similarity: number }>;
  tokensUsed: number;
  topSimilarity: number;
  // Query embedding (used by topic-state for centroid distance check)
  queryEmbedding?: number[];
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
 * Load full LR weights + metadata from classifier-weights.json OR database.
 * File takes priority (fastest). If file missing, loads latest from ClassifierWeights table.
 * Populates lrWeights, lrThresholds, centroids, calibration, trainedAt on the current state.
 * Called after training completes and on startup/reinit.
 */
export async function loadLrWeightsMetadata(prisma?: any): Promise<void> {
  try {
    const weightsPath = path.join(__dirname, '../config/classifier-weights.json');
    let data: any = null;

    // Try file first (fastest)
    if (fs.existsSync(weightsPath)) {
      data = JSON.parse(fs.readFileSync(weightsPath, 'utf-8'));
      console.log('[Classifier] LR weights loaded from file');
    }

    // Fallback: load from database (survives container restarts)
    if (!data && prisma) {
      try {
        const dbWeights = await prisma.classifierWeights.findFirst({
          orderBy: { createdAt: 'desc' },
        });
        if (dbWeights) {
          data = dbWeights.weights;
          // Also write to file for next load (cache)
          fs.writeFileSync(weightsPath, JSON.stringify(data, null, 2));
          console.log(`[Classifier] LR weights loaded from DB (trained ${dbWeights.createdAt.toISOString()}) — cached to file`);
        }
      } catch (dbErr) {
        console.warn('[Classifier] Could not load weights from DB:', dbErr);
      }
    }

    if (!data) {
      console.log('[Classifier] No classifier weights found (file or DB) — LR classifier not loaded');
      return;
    }

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

      // T014: Dimension detection — 1044 = description-enhanced (scaling absorbed), 1024 = legacy
      if (lrWeights && lrWeights.coefficients.length > 0) {
        const dim = lrWeights.coefficients[0].length;
        if (dim === 1044) {
          _state.descriptionFeaturesActive = true;
          console.log('[Classifier] Description features ACTIVE — 1044-dim (scaling absorbed in weights)');
        } else if (dim === 1024) {
          _state.descriptionFeaturesActive = false;
          console.warn('[Classifier] Description features DISABLED — legacy 1024-dim weights, retrain required');
        } else {
          _state.descriptionFeaturesActive = false;
          console.error(`[Classifier] Unexpected weight dimension: ${dim} — description features disabled`);
        }
      }

      // T012: Load description embeddings from weights file if available
      if (data.descriptionEmbeddings && data.featureSchema?.descriptionCategories) {
        const descEmbs = new Map<string, number[][]>();
        for (const [cat, embs] of Object.entries(data.descriptionEmbeddings as Record<string, { en: number[][]; ar: number[][] }>)) {
          descEmbs.set(cat, [...(embs.en || []), ...(embs.ar || [])]);
        }
        _state.descriptionEmbeddings = descEmbs;
        _state.descriptionCategories = data.featureSchema.descriptionCategories as string[];
        console.log(`[Classifier] Description embeddings loaded from weights: ${descEmbs.size} categories`);
      }
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
        descriptionEmbeddings: null,
        descriptionCategories: null,
        descriptionFeaturesActive: false,
      };
      _initialized = true;
      // T030: Load LR weights from file or DB after initialization
      await loadLrWeightsMetadata();
      // T012: Load description embeddings
      await loadDescriptionEmbeddings();
      console.log(`[Classifier] Initialized: ${examples.length} examples, ${initDurationMs}ms`);
    } catch (err) {
      console.error('[Classifier] Initialization failed:', err);
      _initializingPromise = null;
    }
  })();

  return _initializingPromise;
}

// ─── T008: Boost + Cap/Gap config from topic_state_config.json ────────────

let _boostConfig: {
  boostSimilarityThreshold: number;
  boostMinAgreement: number;
  lrHardCap: number;
  lrGapFilter: number;
} = { boostSimilarityThreshold: 0.80, boostMinAgreement: 3, lrHardCap: 3, lrGapFilter: 0.10 };

try {
  const cfgPath = path.join(__dirname, '../../config/topic_state_config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  _boostConfig = {
    boostSimilarityThreshold: cfg.global_settings?.boost_similarity_threshold ?? 0.80,
    boostMinAgreement: cfg.global_settings?.boost_min_agreement ?? 3,
    lrHardCap: cfg.global_settings?.lr_hard_cap ?? 3,
    lrGapFilter: cfg.global_settings?.lr_gap_filter ?? 0.10,
  };
  console.log(`[Classifier] Boost config loaded: threshold=${_boostConfig.boostSimilarityThreshold}, agreement=${_boostConfig.boostMinAgreement}, hardCap=${_boostConfig.lrHardCap}, gapFilter=${_boostConfig.lrGapFilter}`);
} catch { /* defaults */ }

// ─── T012: Load SOP description embeddings at startup ─────────────────────

async function loadDescriptionEmbeddings(): Promise<void> {
  if (!_state) return;

  // Always embed fresh from sop_descriptions.json using the runtime embeddings service
  // Do NOT reuse embeddings from weights file — they may be from a different model version

  try {
    const descPath = path.join(__dirname, '../config/sop_descriptions.json');
    if (!fs.existsSync(descPath)) {
      console.warn('[Classifier] sop_descriptions.json not found — description features unavailable');
      return;
    }
    const descData = JSON.parse(fs.readFileSync(descPath, 'utf-8'));
    const categories = Object.keys(descData.categories || {}).sort();

    // Flatten all description texts for batch embedding
    const textsToEmbed: string[] = [];
    const textMap: Array<{ category: string; index: number }> = [];

    for (const cat of categories) {
      const catData = descData.categories[cat];
      const allDescs = [...(catData.descriptions?.en || []), ...(catData.descriptions?.ar || [])];
      for (const desc of allDescs) {
        textMap.push({ category: cat, index: textsToEmbed.length });
        textsToEmbed.push(desc);
      }
    }

    if (textsToEmbed.length === 0) {
      console.warn('[Classifier] No descriptions found in sop_descriptions.json');
      return;
    }

    console.log(`[Classifier] Embedding ${textsToEmbed.length} SOP descriptions...`);
    const embeddings = await embedBatch(textsToEmbed, 'classification');

    // Build Map<category, number[][]>
    const descEmbs = new Map<string, number[][]>();
    for (const { category, index } of textMap) {
      const emb = embeddings[index];
      if (!emb || emb.length === 0) continue;
      if (!descEmbs.has(category)) descEmbs.set(category, []);
      descEmbs.get(category)!.push(emb);
    }

    _state.descriptionEmbeddings = descEmbs;
    _state.descriptionCategories = categories;
    console.log(`[Classifier] Description embeddings loaded: ${descEmbs.size} categories, ${textsToEmbed.length} descriptions`);
  } catch (err) {
    console.warn('[Classifier] Failed to load description embeddings (non-fatal):', err);
  }
}

// ─── T013: Compute description similarities (20-dim feature vector) ────────

function computeDescriptionSimilarities(
  queryEmbedding: number[],
  state: ClassifierState
): {
  featureVector: number[];
  topDescriptionMatches: Array<{ label: string; similarity: number }>;
} | null {
  if (!state.descriptionEmbeddings || !state.descriptionCategories) return null;

  const categories = state.descriptionCategories;
  const featureVector: number[] = [];
  const allMatches: Array<{ label: string; similarity: number }> = [];

  for (const cat of categories) {
    const embeddings = state.descriptionEmbeddings.get(cat);
    if (!embeddings || embeddings.length === 0) {
      featureVector.push(0);
      continue;
    }
    // Max similarity across all EN+AR description embeddings for this category
    let maxSim = 0;
    for (const emb of embeddings) {
      const sim = cosineSimilarity(queryEmbedding, emb);
      if (sim > maxSim) maxSim = sim;
    }
    featureVector.push(maxSim);
    allMatches.push({ label: cat, similarity: maxSim });
  }

  // Top 3 description matches
  allMatches.sort((a, b) => b.similarity - a.similarity);
  const topDescriptionMatches = allMatches.slice(0, 3);

  return { featureVector, topDescriptionMatches };
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

  // Dimension validation — non-fatal, returns empty on mismatch (handles stale DB weights)
  if (embedding.length !== coefficients[0].length) {
    console.error(`[Classifier] Dimension mismatch: input=${embedding.length} weights=${coefficients[0].length} — skipping LR, retrain required`);
    return { labels: [], confidence: 0, topCandidates: [], tier: 'low' as const };
  }
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
  let labels = scores
    .filter(s => s.confidence >= (perCatThresholds[s.label] || state.lrThresholds?.global || 0.5))
    .map(s => s.label);

  const maxConfidence = scores.length > 0 ? scores[0].confidence : 0;

  // T018 (US3): Gap filter — only keep labels within lr_gap_filter of top score
  if (labels.length > 1 && maxConfidence > 0) {
    const gapThreshold = maxConfidence - _boostConfig.lrGapFilter;
    labels = labels.filter(l => {
      const score = scores.find(s => s.label === l);
      return score ? score.confidence >= gapThreshold : false;
    });
  }

  // T018 (US3): Hard cap — max lr_hard_cap labels
  if (labels.length > _boostConfig.lrHardCap) {
    labels = labels.slice(0, _boostConfig.lrHardCap);
  }

  // Ensure at least top-1 is always returned (FR-013)
  if (labels.length === 0 && scores.length > 0) {
    labels = [scores[0].label];
  }

  const tier: 'high' | 'medium' | 'low' =
    maxConfidence >= highThreshold ? 'high' :
    maxConfidence >= lowThreshold ? 'medium' : 'low';

  return {
    labels,
    confidence: maxConfidence,
    topCandidates: scores,  // all SOP scores for pipeline display
    tier,
  };
}

// ─── Similarity Diagnostic (T019: renamed from KNN Diagnostic) ──────────

function runSimilarityDiagnostic(
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
  const knnMethod = 'similarity_boost';

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
export async function classifyMessage(query: string, overrideVoteThreshold?: number, cachedTopicLabel?: string): Promise<ClassificationResult> {
  const emptyBoost = { topSimilarity: 0, method: 'none', labels: [] as string[], neighbors: [] as Array<{ text: string; labels: string[]; similarity: number }> };
  const emptyResult: ClassificationResult = {
    labels: [], confidence: 0, tier: 'low', topCandidates: [], method: 'classifier_not_initialized',
    similarityBoost: emptyBoost,
    boostApplied: false, boostSimilarity: 0, boostLabels: [], originalLrConfidence: 0, originalLrLabels: [],
    descriptionFeaturesActive: false, topDescriptionMatches: [],
    topK: [], neighbors: [], tokensUsed: 0, topSimilarity: 0,
  };

  // Snapshot state for thread-safe reads during classification (FR-007)
  const state = _state;
  if (!state || state.embeddings.length === 0) return emptyResult;

  // T027: Short message augmentation — prepend context for messages < 4 words
  const wordCount = query.trim().split(/\s+/).length;
  const embeddingInput = wordCount < 4
    ? `In a ${cachedTopicLabel || 'general inquiry'} conversation, the guest says: ${query}`
    : query;

  // Embed the query (classification mode for Cohere input_type)
  const queryEmbedding = await embedText(embeddingInput, 'classification');
  if (!queryEmbedding || queryEmbedding.length === 0) {
    return { ...emptyResult, method: 'embedding_failed' };
  }

  // Require LR weights — fail loudly if not trained
  if (state.lrWeights === null) {
    throw new Error('LR classifier not trained. Run POST /api/knowledge/retrain-classifier first.');
  }

  // T013: Compute description similarities (always, for observability)
  const descResult = computeDescriptionSimilarities(queryEmbedding, state);
  const topDescriptionMatches = descResult?.topDescriptionMatches || [];

  // T015: Concatenate [1024-dim embedding, 20-dim description sims] when active
  // Scaling is absorbed into the LR weights during training (StandardScaler)
  let lrInput: number[];
  let method: string;
  if (state.descriptionFeaturesActive && descResult) {
    lrInput = [...queryEmbedding, ...descResult.featureVector];
    method = 'lr_desc';
  } else {
    lrInput = queryEmbedding;
    method = 'lr_sigmoid';
  }

  // Primary: LR sigmoid classification (T006)
  const lrResult = classifyWithLR(lrInput, state);

  // Similarity diagnostic (renamed from KNN)
  const simDiag = runSimilarityDiagnostic(queryEmbedding, state, overrideVoteThreshold);

  // T009: Similarity Boost — if top neighbor is near-exact match with full agreement, override LR
  let boostApplied = false;
  let boostSimilarity = simDiag.topSimilarity;
  let boostLabels: string[] = [];
  const originalLrConfidence = lrResult.confidence;
  const originalLrLabels = [...lrResult.labels];

  let finalLabels = lrResult.labels;
  let finalConfidence = lrResult.confidence;
  let finalTier = lrResult.tier;

  if (simDiag.topSimilarity >= _boostConfig.boostSimilarityThreshold && simDiag.neighbors.length > 0) {
    // Top neighbor is a near-exact match — use its labels directly
    boostApplied = true;
    boostLabels = simDiag.neighbors[0].labels;
    finalLabels = simDiag.neighbors[0].labels;
    finalConfidence = simDiag.topSimilarity;
    method = 'lr_boost';
    finalTier = finalConfidence >= 0.85 ? 'high' : finalConfidence >= 0.55 ? 'medium' : 'low';
  }

  // Apply token budget
  const { labels: budgetedLabels, tokensUsed } = applyTokenBudget(finalLabels);

  // Backward-compat neighbors surface
  const neighbors = simDiag.topK.map(n => ({ labels: n.labels, similarity: n.similarity }));

  return {
    labels: budgetedLabels,
    confidence: finalConfidence,
    tier: finalTier,
    topCandidates: lrResult.topCandidates,
    method,
    // T007: Renamed from knnDiagnostic
    similarityBoost: {
      topSimilarity: simDiag.topSimilarity,
      method: 'similarity_boost',
      labels: simDiag.labels,
      neighbors: simDiag.neighbors,
    },
    // T010: Boost metadata
    boostApplied,
    boostSimilarity,
    boostLabels,
    originalLrConfidence,
    originalLrLabels,
    // T015: Description metadata
    descriptionFeaturesActive: state.descriptionFeaturesActive,
    topDescriptionMatches,
    // Backward-compat surface
    topK: simDiag.topK,
    neighbors,
    tokensUsed,
    topSimilarity: simDiag.topSimilarity,
    queryEmbedding,
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

// ─── Exported helpers (used by topic-state.service.ts for centroid distance) ──

/**
 * Return the current centroids map (category → mean embedding) or null if not loaded.
 * Used by topic-state.service.ts for centroid-based topic switch detection.
 */
export function getCentroids(): Record<string, number[]> | null {
  return _state?.centroids && Object.keys(_state.centroids).length > 0 ? _state.centroids : null;
}

/**
 * Return the count of training examples per label. Used to determine if a centroid
 * is reliable (needs >= min_examples training examples).
 */
export function getExampleCountPerLabel(): Record<string, number> {
  if (!_state) return {};
  const counts: Record<string, number> = {};
  for (const ex of _state.examples) {
    for (const label of ex.labels) {
      counts[label] = (counts[label] || 0) + 1;
    }
  }
  return counts;
}

// ─── Live test: detailed classification breakdown ─────────────────────────

export async function classifyDetailed(query: string): Promise<{
  message: string;
  knn: {
    topSimilarity: number;
    boostFired: boolean;
    neighbors: Array<{ text: string; labels: string[]; similarity: number }>;
  };
  lr: {
    method: string;
    descriptionFeaturesActive: boolean;
    descriptionSimilarities: Array<{ label: string; similarity: number }>;
    topCandidates: Array<{ label: string; confidence: number }>;
    labels: string[];
    confidence: number;
    tier: string;
  };
  final: {
    method: string;
    labels: string[];
    confidence: number;
    tier: string;
    boostApplied: boolean;
  };
} | null> {
  const state = _state;
  if (!state || state.embeddings.length === 0) return null;

  const queryEmbedding = await embedText(query, 'classification');
  if (!queryEmbedding || queryEmbedding.length === 0) return null;

  // KNN diagnostic
  const simDiag = runSimilarityDiagnostic(queryEmbedding, state);

  // Description similarities
  const descResult = computeDescriptionSimilarities(queryEmbedding, state);
  const descSims = descResult
    ? descResult.topDescriptionMatches.length > 0
      ? [...(state.descriptionCategories || [])].map((cat, i) => ({
          label: cat,
          similarity: descResult.featureVector[i] || 0,
        })).sort((a, b) => b.similarity - a.similarity)
      : []
    : [];

  // LR on description features (or fallback to embedding)
  let lrInput: number[];
  let lrMethod: string;
  if (state.descriptionFeaturesActive && descResult) {
    lrInput = [...queryEmbedding, ...descResult.featureVector];
    lrMethod = 'lr_desc';
  } else if (state.lrWeights) {
    lrInput = queryEmbedding;
    lrMethod = 'lr_sigmoid';
  } else {
    return null;
  }

  const lrResult = classifyWithLR(lrInput, state);

  // Boost check
  const boostFired = simDiag.topSimilarity >= _boostConfig.boostSimilarityThreshold && simDiag.neighbors.length > 0;

  return {
    message: query,
    knn: {
      topSimilarity: simDiag.topSimilarity,
      boostFired,
      neighbors: simDiag.neighbors.slice(0, 5),
    },
    lr: {
      method: lrMethod,
      descriptionFeaturesActive: state.descriptionFeaturesActive,
      descriptionSimilarities: descSims,
      topCandidates: lrResult.topCandidates.slice(0, 10),
      labels: lrResult.labels,
      confidence: lrResult.confidence,
      tier: lrResult.tier,
    },
    final: {
      method: boostFired ? 'lr_boost' : lrMethod,
      labels: boostFired ? simDiag.neighbors[0].labels : lrResult.labels,
      confidence: boostFired ? simDiag.topSimilarity : lrResult.confidence,
      tier: boostFired
        ? (simDiag.topSimilarity >= 0.85 ? 'high' : simDiag.topSimilarity >= 0.55 ? 'medium' : 'low')
        : lrResult.tier,
      boostApplied: boostFired,
    },
  };
}

// ─── T027: Description matrix diagnostic ──────────────────────────────────

export function getDescriptionMatrix(): {
  matrix: Array<{ category1: string; category2: string; similarity: number; flagged: boolean }>;
  flaggedCount: number;
  totalPairs: number;
} | null {
  if (!_state?.descriptionEmbeddings || !_state?.descriptionCategories) return null;

  const categories = _state.descriptionCategories;
  const matrix: Array<{ category1: string; category2: string; similarity: number; flagged: boolean }> = [];

  // Compute representative embedding per category (max across all description embeddings)
  const reps: Map<string, number[]> = new Map();
  for (const cat of categories) {
    const embs = _state.descriptionEmbeddings.get(cat);
    if (!embs || embs.length === 0) continue;
    // Use first embedding as representative (mean would be better but this is diagnostic)
    reps.set(cat, embs[0]);
  }

  let flaggedCount = 0;
  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      const emb1 = reps.get(categories[i]);
      const emb2 = reps.get(categories[j]);
      if (!emb1 || !emb2) continue;
      const sim = cosineSimilarity(emb1, emb2);
      const flagged = sim > 0.70;
      if (flagged) flaggedCount++;
      matrix.push({
        category1: categories[i],
        category2: categories[j],
        similarity: Math.round(sim * 1000) / 1000,
        flagged,
      });
    }
  }

  return { matrix, flaggedCount, totalPairs: matrix.length };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  // T029: Vector dimension validation
  if (a.length !== b.length) {
    throw new Error('Vector dimension mismatch');
  }
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
      let descEmbeddings: ClassifierState['descriptionEmbeddings'] = null;
      let descCategories: ClassifierState['descriptionCategories'] = null;
      let descFeaturesActive = false;

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

          // T014: Dimension detection — 1044 = description-enhanced (scaling absorbed)
          if (lrWeights && lrWeights.coefficients.length > 0) {
            const dim = lrWeights.coefficients[0].length;
            if (dim === 1044) {
              descFeaturesActive = true;
              console.log('[Classifier] Description features ACTIVE during reinit — 1044-dim (scaling absorbed)');
            } else if (dim === 1024) {
              console.warn('[Classifier] Description features DISABLED during reinit — legacy 1024-dim weights');
            }
          }

          // Load description embeddings from weights if available
          if (data.descriptionEmbeddings && data.featureSchema?.descriptionCategories) {
            const descEmbs = new Map<string, number[][]>();
            for (const [cat, embs] of Object.entries(data.descriptionEmbeddings as Record<string, { en: number[][]; ar: number[][] }>)) {
              descEmbs.set(cat, [...(embs.en || []), ...(embs.ar || [])]);
            }
            descEmbeddings = descEmbs;
            descCategories = data.featureSchema.descriptionCategories as string[];
            console.log(`[Classifier] Description embeddings loaded from weights during reinit: ${descEmbs.size} categories`);
          }
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
        descriptionEmbeddings: descEmbeddings,
        descriptionCategories: descCategories,
        descriptionFeaturesActive: descFeaturesActive,
      };
      _initialized = true;
      // Load description embeddings from JSON if not already loaded from weights
      await loadDescriptionEmbeddings();
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
