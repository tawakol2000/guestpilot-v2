/**
 * Tier 3: Topic State Cache — Config-driven from topic_state_config.json
 *
 * CRITICAL DESIGN: Always re-inject by default. Only STOP when:
 * 1. Topic switch keyword detected (clear cache)
 * 2. Cache expired (per-category TTL)
 * 3. Tier 1 confidently classified into a DIFFERENT category (reset to new)
 */

import * as fs from 'fs';
import * as path from 'path';

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

export function updateTopicState(conversationId: string, labels: string[]): void {
  if (!labels || labels.length === 0) return;
  _cache.set(conversationId, { labels, updatedAt: Date.now(), reinjectCount: 0 });
}

export function getReinjectedLabels(conversationId: string, messageText: string): {
  labels: string[];
  reinjected: boolean;
  topicSwitchDetected: boolean;
} {
  const state = _cache.get(conversationId);
  if (!state) return { labels: [], reinjected: false, topicSwitchDetected: false };

  // Check expiry using per-category TTL
  const decayMs = getDecayMs(state.labels);
  if (Date.now() - state.updatedAt > decayMs) {
    _cache.delete(conversationId);
    return { labels: [], reinjected: false, topicSwitchDetected: false };
  }

  // Check max reinject count
  if (state.reinjectCount >= MAX_REINJECT) {
    _cache.delete(conversationId);
    return { labels: [], reinjected: false, topicSwitchDetected: false };
  }

  const textLower = messageText.toLowerCase().trim();

  // Check if message is a "not-switch" signal first (short confirmations, etc.)
  // These should ALWAYS re-inject, never treated as a switch
  const isNotSwitch = NOT_SWITCH_SIGNALS.some(sig => textLower === sig.toLowerCase());
  if (isNotSwitch) {
    state.reinjectCount++;
    console.log(`[TopicState] Not-switch signal, re-injecting [${state.labels.join(', ')}]: "${messageText.substring(0, 40)}"`);
    return { labels: state.labels, reinjected: true, topicSwitchDetected: false };
  }

  // Check for topic switch keywords
  const topicSwitchDetected = ALL_SWITCH_KEYWORDS.some(kw => textLower.includes(kw.toLowerCase()));
  if (topicSwitchDetected) {
    _cache.delete(conversationId);
    console.log(`[TopicState] Topic switch detected: "${messageText.substring(0, 50)}"`);
    return { labels: [], reinjected: false, topicSwitchDetected: true };
  }

  // DEFAULT: re-inject
  state.reinjectCount++;
  console.log(`[TopicState] Re-injecting [${state.labels.join(', ')}] (#${state.reinjectCount}): "${messageText.substring(0, 40)}"`);
  return { labels: state.labels, reinjected: true, topicSwitchDetected: false };
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
