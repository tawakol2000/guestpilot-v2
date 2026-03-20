/**
 * Tier 3: Topic State Cache — Config-driven from topic_state_config.json
 *
 * T024-T026: Multi-slot cache with exponential confidence decay.
 * Each conversation holds up to 3 topic slots with independent decay.
 *
 * CRITICAL DESIGN: Always re-inject by default. Only STOP when:
 * 1. Topic switch keyword detected (clear cache)
 * 2. Centroid distance check detects semantic topic change (clear cache)
 * 3. All slots expired (confidence below floor)
 * 4. Tier 1 confidently classified into a DIFFERENT category (reset to new)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCentroids, getExampleCountPerLabel, cosineSimilarity } from './classifier.service';

// Load config at startup
let CONFIG: any = null;
try {
  const configPath = path.join(__dirname, '../../config/topic_state_config.json');
  CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  console.log('[TopicState] Config loaded:', Object.keys(CONFIG.per_category_rules || {}).length, 'category rules');
} catch (err) {
  console.warn('[TopicState] Config not found, using defaults');
}

// ─── Multi-slot cache types ────────────────────────────────────────────

interface TopicCacheSlot {
  label: string;
  confidence: number;   // initial confidence (decays over time)
  updatedAt: number;     // timestamp when slot was last updated
  reinjectCount: number; // per-slot reinject counter
}

interface TopicCache {
  slots: TopicCacheSlot[];  // max 3 slots
}

const MAX_SLOTS = 3;
const CONFIDENCE_FLOOR = 0.01;  // slots below this are expired
const DEFAULT_HALF_LIFE_MS = (CONFIG?.global_settings?.half_life_minutes || 10) * 60 * 1000;
const RETURN_BOOST_MULTIPLIER = CONFIG?.global_settings?.return_boost_multiplier ?? 1.5;

const _cache = new Map<string, TopicCache>();

// Build keyword lists from config
const SWITCH_KEYWORDS_EN: string[] = CONFIG?.topic_switch_keywords?.explicit_en || [
  'also', 'by the way', 'another thing', 'one more thing', 'different question',
  'new question', 'separately', 'on another note', 'btw', 'another issue',
  'something else', 'one more', 'quick question', 'unrelated',
];
const SWITCH_KEYWORDS_AR: string[] = CONFIG?.topic_switch_keywords?.explicit_ar || [];
const ALL_SWITCH_KEYWORDS = [...SWITCH_KEYWORDS_EN, ...SWITCH_KEYWORDS_AR];

// Not-switch signals — these look like switches but aren't
const NOT_SWITCH_SIGNALS: string[] = [
  ...(CONFIG?.not_switch_signals?.short_answers || []),
  ...(CONFIG?.not_switch_signals?.short_answers_ar || []),
  ...(CONFIG?.not_switch_signals?.time_responses || []),
  ...(CONFIG?.not_switch_signals?.identity_responses || []),
  ...(CONFIG?.not_switch_signals?.quantity_responses || []),
  ...(CONFIG?.not_switch_signals?.selection_responses || []),
];

const MAX_REINJECT = CONFIG?.global_settings?.max_reinject_count || 5;
const CENTROID_SWITCH_THRESHOLD = CONFIG?.global_settings?.centroid_switch_threshold ?? 0.60;
const CENTROID_MIN_EXAMPLES = CONFIG?.global_settings?.centroid_min_examples ?? 3;

// ─── Half-life helpers ─────────────────────────────────────────────────

function getHalfLifeMs(label: string): number {
  const rule = CONFIG?.per_category_rules?.[label];
  if (rule?.half_life_minutes) return rule.half_life_minutes * 60 * 1000;
  // Backward compat: use decay_minutes as half-life if half_life_minutes not set
  if (rule?.decay_minutes) return rule.decay_minutes * 60 * 1000;
  return DEFAULT_HALF_LIFE_MS;
}

/** Compute decayed confidence: conf(0) * 2^(-t / halfLife) */
function decayedConfidence(slot: TopicCacheSlot): number {
  const elapsed = Date.now() - slot.updatedAt;
  const halfLife = getHalfLifeMs(slot.label);
  return slot.confidence * Math.pow(2, -elapsed / halfLife);
}

/** Get live (decayed) slots sorted by confidence desc, filtering expired ones */
function getLiveSlots(cache: TopicCache): TopicCacheSlot[] {
  return cache.slots
    .filter(s => decayedConfidence(s) >= CONFIDENCE_FLOOR)
    .sort((a, b) => decayedConfidence(b) - decayedConfidence(a));
}

// ─── Cache size management ─────────────────────────────────────────────

const CACHE_MAX_SIZE = 10000;

function evictOldestIfNeeded(): void {
  if (_cache.size > CACHE_MAX_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of _cache.entries()) {
      const maxUpdated = Math.max(...entry.slots.map(s => s.updatedAt));
      if (maxUpdated < oldestTime) {
        oldestTime = maxUpdated;
        oldestKey = key;
      }
    }
    if (oldestKey) _cache.delete(oldestKey);
  }
}

// ─── Public API ────────────────────────────────────────────────────────

export function updateTopicState(conversationId: string, labels: string[]): void {
  if (!labels || labels.length === 0) return;

  let cache = _cache.get(conversationId);
  if (!cache) {
    cache = { slots: [] };
    _cache.set(conversationId, cache);
  }

  for (const label of labels) {
    // Check if this label already exists in a slot
    const existingIdx = cache.slots.findIndex(s => s.label === label);
    if (existingIdx >= 0) {
      // Boost existing slot — return to previous topic
      cache.slots[existingIdx].confidence = Math.min(1.0, decayedConfidence(cache.slots[existingIdx]) * RETURN_BOOST_MULTIPLIER);
      cache.slots[existingIdx].updatedAt = Date.now();
      cache.slots[existingIdx].reinjectCount = 0;
    } else {
      // Insert new slot
      cache.slots.push({ label, confidence: 1.0, updatedAt: Date.now(), reinjectCount: 0 });
    }
  }

  // Evict expired slots
  cache.slots = cache.slots.filter(s => decayedConfidence(s) >= CONFIDENCE_FLOOR);

  // If more than MAX_SLOTS, evict lowest-confidence
  if (cache.slots.length > MAX_SLOTS) {
    cache.slots.sort((a, b) => decayedConfidence(b) - decayedConfidence(a));
    cache.slots = cache.slots.slice(0, MAX_SLOTS);
  }

  evictOldestIfNeeded();
}

export function getReinjectedLabels(conversationId: string, messageText: string, messageEmbedding?: number[]): {
  labels: string[];
  reinjected: boolean;
  topicSwitchDetected: boolean;
  centroidSimilarity: number | null;
  centroidThreshold: number | null;
  switchMethod: 'keyword' | 'centroid' | null;
} {
  const noResult = { labels: [] as string[], reinjected: false, topicSwitchDetected: false, centroidSimilarity: null, centroidThreshold: null, switchMethod: null as 'keyword' | 'centroid' | null };

  const cache = _cache.get(conversationId);
  if (!cache) return noResult;

  // Get live (non-expired) slots sorted by decayed confidence
  const liveSlots = getLiveSlots(cache);
  if (liveSlots.length === 0) {
    _cache.delete(conversationId);
    return noResult;
  }

  // Check max reinject on primary slot
  const primarySlot = liveSlots[0];
  if (primarySlot.reinjectCount >= MAX_REINJECT) {
    _cache.delete(conversationId);
    return noResult;
  }

  const textLower = messageText.toLowerCase().trim();

  // Check if message is a "not-switch" signal first (short confirmations, etc.)
  const isNotSwitch = NOT_SWITCH_SIGNALS.some(sig => textLower === sig.toLowerCase());
  if (isNotSwitch) {
    primarySlot.reinjectCount++;
    const labelsToReinject = liveSlots.map(s => s.label);
    console.log(`[TopicState] Not-switch signal, re-injecting [${labelsToReinject.join(', ')}]: "${messageText.substring(0, 40)}"`);
    return { labels: labelsToReinject, reinjected: true, topicSwitchDetected: false, centroidSimilarity: null, centroidThreshold: null, switchMethod: null };
  }

  // Centroid check — check against ALL cached slots, not just primary
  if (messageEmbedding && messageEmbedding.length > 0) {
    const centroids = getCentroids();
    if (centroids) {
      const exampleCounts = getExampleCountPerLabel();
      let maxSim = -1;
      let checkedAny = false;

      for (const slot of liveSlots) {
        const centroid = centroids[slot.label];
        if (!centroid) continue;
        if ((exampleCounts[slot.label] || 0) < CENTROID_MIN_EXAMPLES) continue;
        checkedAny = true;
        const sim = cosineSimilarity(messageEmbedding, centroid);
        if (sim > maxSim) maxSim = sim;
      }

      if (checkedAny && maxSim >= 0 && maxSim < CENTROID_SWITCH_THRESHOLD) {
        // All cached slots fail centroid check → topic switch
        _cache.delete(conversationId);
        console.log(`[TopicState] Centroid topic switch detected (sim=${maxSim.toFixed(3)} < threshold=${CENTROID_SWITCH_THRESHOLD}): "${messageText.substring(0, 50)}"`);
        return { labels: [], reinjected: false, topicSwitchDetected: true, centroidSimilarity: maxSim, centroidThreshold: CENTROID_SWITCH_THRESHOLD, switchMethod: 'centroid' };
      }
    } else {
      // No centroids available — keyword fallback
      const topicSwitchDetected = ALL_SWITCH_KEYWORDS.some(kw => textLower.includes(kw.toLowerCase()));
      if (topicSwitchDetected) {
        _cache.delete(conversationId);
        console.log(`[TopicState] Keyword topic switch detected (fallback, no centroids): "${messageText.substring(0, 50)}"`);
        return { labels: [], reinjected: false, topicSwitchDetected: true, centroidSimilarity: null, centroidThreshold: null, switchMethod: 'keyword' };
      }
    }
  } else {
    // No embedding available — keyword fallback
    const topicSwitchDetected = ALL_SWITCH_KEYWORDS.some(kw => textLower.includes(kw.toLowerCase()));
    if (topicSwitchDetected) {
      _cache.delete(conversationId);
      console.log(`[TopicState] Keyword topic switch detected (fallback, no embedding): "${messageText.substring(0, 50)}"`);
      return { labels: [], reinjected: false, topicSwitchDetected: true, centroidSimilarity: null, centroidThreshold: null, switchMethod: 'keyword' };
    }
  }

  // DEFAULT: re-inject all live slot labels (primary first)
  primarySlot.reinjectCount++;
  const labelsToReinject = liveSlots.map(s => s.label);
  console.log(`[TopicState] Re-injecting [${labelsToReinject.join(', ')}] (#${primarySlot.reinjectCount}): "${messageText.substring(0, 40)}"`);
  return { labels: labelsToReinject, reinjected: true, topicSwitchDetected: false, centroidSimilarity: null, centroidThreshold: null, switchMethod: null };
}

/** Get current cached topic label for a conversation (for short message augmentation) */
export function getCachedTopicLabel(conversationId: string): string | undefined {
  const cache = _cache.get(conversationId);
  if (!cache) return undefined;
  const liveSlots = getLiveSlots(cache);
  return liveSlots.length > 0 ? liveSlots[0].label : undefined;
}

export function clearTopicState(conversationId: string): void {
  _cache.delete(conversationId);
}

// Periodic cleanup of expired cache entries (every 5 minutes)
const _cleanupTimer = setInterval(() => {
  for (const [id, cache] of _cache.entries()) {
    cache.slots = cache.slots.filter(s => decayedConfidence(s) >= CONFIDENCE_FLOOR);
    if (cache.slots.length === 0) _cache.delete(id);
  }
}, 5 * 60 * 1000);

/** Call during graceful shutdown to stop the periodic cleanup timer. */
export function stopTopicStateCleanup(): void {
  clearInterval(_cleanupTimer);
}

export function getTopicCacheStats(): { size: number; conversationIds: string[] } {
  // Clean up first
  for (const [id, cache] of _cache.entries()) {
    cache.slots = cache.slots.filter(s => decayedConfidence(s) >= CONFIDENCE_FLOOR);
    if (cache.slots.length === 0) _cache.delete(id);
  }
  return { size: _cache.size, conversationIds: Array.from(_cache.keys()) };
}
