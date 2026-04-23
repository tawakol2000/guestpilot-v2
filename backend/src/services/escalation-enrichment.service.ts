/**
 * Post-routing escalation enrichment.
 * Scans guest message for keyword patterns that indicate urgency,
 * appends signals to the context so Omar knows to escalate.
 *
 * NOT a pre-filter — routing happens first, then this adds urgency hints.
 */

import * as fs from 'fs';
import * as path from 'path';

let RULES: any = null;
try {
  const rulesPath = path.join(__dirname, '../../config/escalation_rules.json');
  RULES = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
  console.log('[EscalationEnrichment] Rules loaded:',
    RULES.immediate_triggers?.length || 0, 'immediate,',
    RULES.scheduled_triggers?.length || 0, 'scheduled,',
    RULES.info_request_triggers?.length || 0, 'info_request');
} catch (err) {
  console.warn('[EscalationEnrichment] Rules not found — enrichment disabled');
}

export interface EscalationSignal {
  signal: string;
  action: 'escalate_now' | 'create_task' | 'ask_manager';
  weight: number;
}

// Escape special regex characters in pattern strings
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matching to reduce false positives (e.g., "phone code" won't match "code doesn't work")
// For Arabic patterns, use includes() as \b doesn't work with Arabic script
const _regexCache = new Map<string, RegExp>();
function matchesPattern(text: string, pattern: string): boolean {
  const patternLower = pattern.toLowerCase();
  // Arabic characters don't support \b word boundaries — fall back to includes
  if (/[\u0600-\u06FF]/.test(pattern)) {
    return text.includes(patternLower);
  }
  let re = _regexCache.get(patternLower);
  if (!re) {
    re = new RegExp('\\b' + escapeRegex(patternLower) + '\\b', 'i');
    _regexCache.set(patternLower, re);
  }
  return re.test(text);
}

export function detectEscalationSignals(messageText: string): EscalationSignal[] {
  if (!RULES) return [];

  // Bugfix (2026-04-23): guest messages feed into `.test()` over every
  // cached trigger pattern + every soft-signal phrase (dozens of
  // regexes). A 1MB adversarial paste would scan each pattern against
  // the full string, burning CPU on every incoming message. Real
  // guest messages are never longer than ~2KB; 10KB is a comfortable
  // ceiling that still catches any legitimate long message. Trim
  // before lowercasing so the case change pass is also bounded.
  const bounded =
    messageText.length > 10_000 ? messageText.slice(0, 10_000) : messageText;
  const textLower = bounded.toLowerCase();
  const signals: EscalationSignal[] = [];

  // Check immediate triggers
  for (const trigger of (RULES.immediate_triggers || [])) {
    const allPatterns = [...(trigger.patterns_en || []), ...(trigger.patterns_ar || [])];
    for (const pattern of allPatterns) {
      if (matchesPattern(textLower, pattern)) {
        signals.push({
          signal: trigger.signal,
          action: trigger.action || 'escalate_now',
          weight: trigger.weight || 0.8,
        });
        break; // One match per trigger is enough
      }
    }
  }

  // Check scheduled triggers
  for (const trigger of (RULES.scheduled_triggers || [])) {
    const allPatterns = [...(trigger.patterns_en || []), ...(trigger.patterns_ar || [])];
    for (const pattern of allPatterns) {
      if (matchesPattern(textLower, pattern)) {
        signals.push({
          signal: trigger.signal,
          action: trigger.action || 'create_task',
          weight: trigger.weight || 0.8,
        });
        break;
      }
    }
  }

  // Check info request triggers
  for (const trigger of (RULES.info_request_triggers || [])) {
    if (!trigger.patterns_en?.length && !trigger.patterns_ar?.length) continue; // Skip catch-all
    const allPatterns = [...(trigger.patterns_en || []), ...(trigger.patterns_ar || [])];
    for (const pattern of allPatterns) {
      if (matchesPattern(textLower, pattern)) {
        signals.push({
          signal: trigger.signal,
          action: trigger.action || 'ask_manager',
          weight: trigger.weight || 0.7,
        });
        break;
      }
    }
  }

  return signals;
}
