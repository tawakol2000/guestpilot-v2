/**
 * Tier 3: Topic State Cache — Config-driven from topic_state_config.json
 *
 * CRITICAL DESIGN: Always re-inject by default. Only STOP when:
 * 1. Topic switch keyword detected (clear cache)
 * 2. Centroid distance check detects semantic topic change (clear cache)
 * 3. Cache expired (per-category TTL)
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

interface TopicState {
  labels: string[];
  updatedAt: number;
  reinjectCount: number;
}

const _cache = new Map<string, TopicState>();

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

const DEFAULT_DECAY_MS = (CONFIG?.global_settings?.default_decay_minutes || 30) * 60 * 1000;
const MAX_REINJECT = CONFIG?.global_settings?.max_reinject_count || 5;
const CENTROID_SWITCH_THRESHOLD = CONFIG?.global_settings?.centroid_switch_threshold ?? 0.60;
const CENTROID_MIN_EXAMPLES = CONFIG?.global_settings?.centroid_min_examples ?? 3;

function getDecayMs(labels: string[]): number {
  if (!CONFIG?.per_category_rules || labels.length === 0) return DEFAULT_DECAY_MS;
  // Use the longest TTL among all active labels
  let maxDecay = DEFAULT_DECAY_MS;
  for (const label of labels) {
    const rule = CONFIG.per_category_rules[label];
    if (rule?.decay_minutes) {
      maxDecay = Math.max(maxDecay, rule.decay_minutes * 60 * 1000);
    }
  }
  return maxDecay;
}

const CACHE_MAX_SIZE = 10000;

export function updateTopicState(conversationId: string, labels: string[]): void {
  if (!labels || labels.length === 0) return;
  _cache.set(conversationId, { labels, updatedAt: Date.now(), reinjectCount: 0 });

  // T033: LRU cap — evict oldest entry when cache exceeds max size
  if (_cache.size > CACHE_MAX_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of _cache.entries()) {
      if (entry.updatedAt < oldestTime) {
        oldestTime = entry.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) _cache.delete(oldestKey);
  }
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

  const state = _cache.get(conversationId);
  if (!state) return noResult;

  // Check expiry using per-category TTL
  const decayMs = getDecayMs(state.labels);
  if (Date.now() - state.updatedAt > decayMs) {
    _cache.delete(conversationId);
    return noResult;
  }

  // Check max reinject count
  if (state.reinjectCount >= MAX_REINJECT) {
    _cache.delete(conversationId);
    return noResult;
  }

  const textLower = messageText.toLowerCase().trim();

  // Check if message is a "not-switch" signal first (short confirmations, etc.)
  // These should ALWAYS re-inject, never treated as a switch
  const isNotSwitch = NOT_SWITCH_SIGNALS.some(sig => textLower === sig.toLowerCase());
  if (isNotSwitch) {
    state.reinjectCount++;
    console.log(`[TopicState] Not-switch signal, re-injecting [${state.labels.join(', ')}]: "${messageText.substring(0, 40)}"`);
    return { labels: state.labels, reinjected: true, topicSwitchDetected: false, centroidSimilarity: null, centroidThreshold: null, switchMethod: null };
  }

  // T007: Centroid check runs FIRST (primary switch detection)
  if (messageEmbedding && messageEmbedding.length > 0) {
    const centroids = getCentroids();
    if (centroids) {
      const exampleCounts = getExampleCountPerLabel();
      let maxSim = -1;
      let checkedAny = false;

      for (const label of state.labels) {
        const centroid = centroids[label];
        if (!centroid) continue;
        // Skip unreliable centroids (too few training examples)
        if ((exampleCounts[label] || 0) < CENTROID_MIN_EXAMPLES) continue;
        checkedAny = true;
        const sim = cosineSimilarity(messageEmbedding, centroid);
        if (sim > maxSim) maxSim = sim;
      }

      if (checkedAny && maxSim >= 0 && maxSim < CENTROID_SWITCH_THRESHOLD) {
        _cache.delete(conversationId);
        console.log(`[TopicState] Centroid topic switch detected (sim=${maxSim.toFixed(3)} < threshold=${CENTROID_SWITCH_THRESHOLD}): "${messageText.substring(0, 50)}"`);
        return { labels: [], reinjected: false, topicSwitchDetected: true, centroidSimilarity: maxSim, centroidThreshold: CENTROID_SWITCH_THRESHOLD, switchMethod: 'centroid' };
      }
    } else {
      // T007: Keyword check only fires as fallback when no centroids available
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

  // DEFAULT: re-inject
  state.reinjectCount++;
  console.log(`[TopicState] Re-injecting [${state.labels.join(', ')}] (#${state.reinjectCount}): "${messageText.substring(0, 40)}"`);
  return { labels: state.labels, reinjected: true, topicSwitchDetected: false, centroidSimilarity: null, centroidThreshold: null, switchMethod: null };
}

export function clearTopicState(conversationId: string): void {
  _cache.delete(conversationId);
}

// Periodic cleanup of expired cache entries (every 5 minutes)
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, state] of _cache.entries()) {
    if (now - state.updatedAt > getDecayMs(state.labels)) {
      _cache.delete(id);
    }
  }
}, 5 * 60 * 1000);

/** Call during graceful shutdown to stop the periodic cleanup timer. */
export function stopTopicStateCleanup(): void {
  clearInterval(_cleanupTimer);
}

export function getTopicCacheStats(): { size: number; conversationIds: string[] } {
  const now = Date.now();
  for (const [id, state] of _cache.entries()) {
    if (now - state.updatedAt > getDecayMs(state.labels)) _cache.delete(id);
  }
  return { size: _cache.size, conversationIds: Array.from(_cache.keys()) };
}
