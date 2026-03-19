/**
 * Tier 2: Canonical Intent Extractor — Real Haiku LLM call
 *
 * Fires when Tier 1 topSimilarity <= 0.75 AND Tier 3 doesn't re-inject.
 * Reads last 3 guest + 2 host messages, calls Haiku with the prompt from
 * backend/config/intent_extractor_prompt.md, returns TOPIC/STATUS/URGENCY/SOPS.
 *
 * Cost: ~$0.0001/call | Latency: ~300-500ms | Fires on ~20% of messages
 *
 * Graceful degradation: if Haiku call fails, returns null → system uses Tier 1 results.
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';

// Load the intent extractor prompt
let INTENT_PROMPT = '';
try {
  const promptPath = path.join(__dirname, '../../config/intent_extractor_prompt.md');
  INTENT_PROMPT = fs.readFileSync(promptPath, 'utf-8');
  console.log('[IntentExtractor] Prompt loaded:', INTENT_PROMPT.length, 'chars');
} catch (err) {
  console.warn('[IntentExtractor] Prompt not found — Tier 2 will be disabled');
}

export interface IntentExtraction {
  topic: string;
  status: 'new_request' | 'ongoing_issue' | 'follow_up' | 'resolved' | 'just_chatting';
  urgency: 'routine' | 'frustrated' | 'angry' | 'emergency';
  sops: string[];
}

export const RAG_CATEGORIES = [
  'sop-cleaning', 'sop-amenity-request', 'sop-maintenance', 'sop-wifi-doorcode',
  'sop-visitor-policy', 'sop-early-checkin', 'sop-late-checkout', 'sop-complaint',
  'property-info', 'property-description',
  'sop-booking-inquiry', 'pricing-negotiation', 'pre-arrival-logistics',
  'sop-booking-modification', 'sop-booking-confirmation', 'payment-issues',
  'post-stay-issues', 'sop-long-term-rental', 'sop-booking-cancellation',
  'sop-property-viewing', 'non-actionable', 'contextual',
] as const;

export const BAKED_IN_CATEGORIES = [
  'sop-scheduling', 'sop-house-rules', 'sop-escalation-immediate', 'sop-escalation-scheduled',
] as const;

let _tier2CallCount = 0;
let _tier2SuccessCount = 0;
let _tier2FailCount = 0;

// Initialize Anthropic client — use the same API key as the main Omar call
let _anthropic: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { console.warn('[IntentExtractor] No ANTHROPIC_API_KEY'); return null; }
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

export async function extractIntent(
  messages: Array<{ role: string; content: string }>,
  tenantId: string,
  conversationId: string
): Promise<IntentExtraction | null> {
  _tier2CallCount++;

  if (!INTENT_PROMPT) {
    console.log(`[IntentExtractor] Tier 2 disabled (no prompt), call #${_tier2CallCount}`);
    return null;
  }

  const client = getClient();
  if (!client) return null;

  // Format messages for the prompt: last 5 messages chronologically
  let conversationContext = '';
  const allRecent = messages.slice(-5);
  for (const msg of allRecent) {
    conversationContext += `${msg.role.toUpperCase()}: ${msg.content}\n`;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: INTENT_PROMPT,
      messages: [{ role: 'user', content: conversationContext.trim() }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[IntentExtractor] No JSON in response: ${text.substring(0, 100)}`);
      _tier2FailCount++;
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate SOPS are from allowed categories, deduplicate
    const validSops = [...new Set<string>((parsed.SOPS || []).filter((s: string) =>
      (RAG_CATEGORIES as readonly string[]).includes(s)
    ))];

    const result: IntentExtraction = {
      topic: parsed.TOPIC || 'unknown',
      status: parsed.STATUS || 'new_request',
      urgency: parsed.URGENCY || 'routine',
      sops: validSops,
    };

    _tier2SuccessCount++;
    console.log(`[IntentExtractor] Tier 2 classified conv ${conversationId}: ${JSON.stringify(result)}`);
    return result;

  } catch (err: any) {
    _tier2FailCount++;
    console.warn(`[IntentExtractor] Haiku call failed (non-fatal): ${err.message}`);
    return null;
  }
}

export function getTier2Stats() {
  return { calls: _tier2CallCount, successes: _tier2SuccessCount, failures: _tier2FailCount };
}
