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
  compliance: { lastUserSanctionedApply: boolean };
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
 * A few simple phrases that signal an explicit manager apply sanction.
 * Checked case-insensitively against the last user turn. Kept intentionally
 * narrow — principal safeguard against "agent applied without my say-so".
 */
const APPLY_SANCTION_PATTERNS = [
  /\bapply\b/i,
  /\bdo it now\b/i,
  /\bgo ahead\b/i,
  /\bship it\b/i,
  /\byes[,.!\s]+apply\b/i,
  /\byes,? do it\b/i,
  /\bmake the change\b/i,
  /\bconfirm\b/i,
];

export function detectApplySanction(lastUserMessage: string): boolean {
  if (!lastUserMessage) return false;
  return APPLY_SANCTION_PATTERNS.some((re) => re.test(lastUserMessage));
}
