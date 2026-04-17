/**
 * Shared types + helpers for the tuning-agent hook layer. The hooks run
 * outside the token budget per SDK guarantee; they can do side-effect work
 * (DB writes, Langfuse logging, cache reads) without burning context.
 */
import type { PrismaClient } from '@prisma/client';

export interface HookContext {
  prisma: PrismaClient;
  tenantId: string;
  conversationId: string | null;
  userId: string | null;
  /** Updated by runtime on every incoming user message. */
  readLastUserMessage: () => string;
  /**
   * Emits a transient data part to the client (progress indicators, follow-up
   * suggestions). No-op outside the chat endpoint.
   */
  emitDataPart?: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void;
  /** Mutable flag — flipped true on compliance grant, read by suggestion_action hook. */
  compliance: {
    lastUserSanctionedApply: boolean;
    /** Sprint 09 fix 5: separate sanction track for rollback. */
    lastUserSanctionedRollback: boolean;
  };
}

/** 48 hours in ms — mirrors sprint-02's cooldown constant. */
export const COOLDOWN_WINDOW_MS = 48 * 60 * 60 * 1000;

/** 14 days — oscillation window for reversal-detection in PreToolUse. */
export const OSCILLATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Boost required for oscillation-reversal: a new suggestion whose confidence
 * exceeds the prior accepted suggestion's confidence by this factor may
 * proceed even if it reverses a recent decision.
 */
export const OSCILLATION_CONFIDENCE_BOOST = 1.25;

/**
 * Phrases that signal an explicit manager apply sanction. Checked
 * case-insensitively against the last user turn.
 *
 * Sprint 09 fix 6: earlier the list was `/\bapply\b/` and `/\bconfirm\b/`
 * as bare words, which triggered on unrelated contexts like "Can you
 * confirm what the SOP says?" or "I need to apply for a visa". Patterns
 * are now intent-phrases: they require accompanying context words
 * ("apply it", "apply the change", "confirm the rollback"). The
 * unambiguous single words `yes` and `approve` / `approved` are kept as-is.
 */
const APPLY_SANCTION_PATTERNS = [
  // "apply" in clear imperative context
  /\bapply\s+(it|this|that|them|the\s+(change|suggestion|fix|edit|update|changes)|now)\b/i,
  /\bapply\s+(now|them|it|this|that)\b/i,
  // Politeness-prefixed "apply": "please apply", "sure, apply", "ok apply",
  // "could you apply", etc. The leading-word check keeps it from matching
  // "apply for a visa" (no imperative cue) while covering common natural
  // phrasings the tighter patterns above missed.
  /\b(please|pls|sure|ok|okay|alright|yeah|yep|go\s+and|could\s+you|can\s+you|let'?s)[,.!\s]+apply\b/i,
  /^\s*apply\s*[.!?]?\s*$/i, // bare "apply" as the whole message
  // "confirm" in write-action context
  /\bconfirm\s+(the\s+)?(change|apply|rollback|revert|edit|update|changes|fix)\b/i,
  // agreement phrases
  /\bthat'?s?\s+(right|correct|good|the one|the fix|it)\b/i,
  /\bgo\s+ahead\b/i,
  /\bdo\s+it(\s+now)?\b/i,
  /\bship\s+it\b/i,
  /\bmake\s+the\s+change\b/i,
  // "yes" followed by an action verb
  /\byes[,.!\s]+(apply|go|do|confirm|proceed|ship)\b/i,
  // Unambiguous stand-alones
  /\bapprove(d)?\b/i,
  // Bare "yes" — kept per brief, unambiguous enough in context
  /^\s*yes[.!\s]*$/i,
  /\byes[,.!\s]+(please|thanks?)\b/i,
  /\byes\s+do\b/i,
];

/**
 * Sprint 09 fix 5: rollback also writes to artifacts and must require a
 * rollback-specific manager sanction. Reusing the apply patterns would
 * accept "apply" as a greenlight for a rollback, which is wrong — the
 * manager should be acknowledging the rollback specifically.
 */
const ROLLBACK_SANCTION_PATTERNS = [
  /\broll(\s|-)?back\b/i,
  /\brevert\b/i,
  /\bundo\s+(it|that|this|the\s+(change|edit|update))\b/i,
  /\byes[,.!\s]+(roll(\s|-)?back|revert|undo)/i,
  /\bgo\s+ahead\b/i,
  /\bdo\s+it(\s+now)?\b/i,
];

export function detectApplySanction(lastUserMessage: string): boolean {
  if (!lastUserMessage) return false;
  return APPLY_SANCTION_PATTERNS.some((re) => re.test(lastUserMessage));
}

export function detectRollbackSanction(lastUserMessage: string): boolean {
  if (!lastUserMessage) return false;
  return ROLLBACK_SANCTION_PATTERNS.some((re) => re.test(lastUserMessage));
}
