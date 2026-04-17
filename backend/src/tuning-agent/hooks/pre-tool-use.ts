/**
 * PreToolUse hook — runs before every tool call. Enforces:
 *   1. Compliance: suggestion_action(apply | edit_then_apply) requires an
 *      explicit manager-sanctioning turn in the last user message.
 *   2. Cooldown: 48h on the same (diagnosticCategory, artifact target).
 *   3. Oscillation: refuses an apply that reverses a decision within the
 *      last 14d unless new confidence exceeds prior * 1.25.
 *
 * The hook returns PreToolUseHookSpecificOutput with a permissionDecision
 * of 'deny' + a rationale when blocked. Deny strings are fed back to the
 * agent as the tool's return, so the agent explains the block to the user.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';
import {
  COOLDOWN_WINDOW_MS,
  OSCILLATION_WINDOW_MS,
  OSCILLATION_CONFIDENCE_BOOST,
  detectApplySanction,
  detectRollbackSanction,
  type HookContext,
} from './shared';

export function buildPreToolUseHook(ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const pre = input as PreToolUseHookInput;
    const c = ctx();

    // ─── Sprint 09 fix 5: rollback also writes to artifacts ───────────────
    // The rollback tool bypassed compliance entirely, which violated the
    // human-in-the-loop principle. Require an explicit rollback sanction
    // before the handler runs.
    if (pre.tool_name === TUNING_AGENT_TOOL_NAMES.rollback) {
      const last = c.readLastUserMessage();
      if (!detectRollbackSanction(last)) {
        return denyHook(
          `Compliance check failed: the manager's last turn did not explicitly sanction a rollback (e.g. "roll back", "revert it", "undo the change"). Ask for confirmation before invoking rollback.`
        );
      }
      c.compliance.lastUserSanctionedRollback = true;
      return { continue: true } as HookJSONOutput;
    }

    // Only intercept suggestion_action applies; all other tools pass through.
    if (pre.tool_name !== TUNING_AGENT_TOOL_NAMES.suggestion_action) {
      return { continue: true } as HookJSONOutput;
    }
    const toolInput = (pre.tool_input ?? {}) as {
      action?: string;
      suggestionId?: string;
      draft?: {
        category?: string;
        sopCategory?: string;
        sopStatus?: string;
        sopPropertyId?: string;
        systemPromptVariant?: string;
        faqEntryId?: string;
        confidence?: number;
        // Sprint 09 follow-up: `beforeText` is the TOOL_CONFIG cooldown key.
        // The draft schema in suggestion-action has no `targetHint` and the
        // persisted row has no toolDefinitionId column, so beforeText (the
        // current tool description) is the closest stable identifier two
        // suggestions targeting the same tool share.
        beforeText?: string;
      };
    };
    const action = toolInput.action;
    const isWrite = action === 'apply' || action === 'edit_then_apply';
    if (!isWrite) {
      return { continue: true } as HookJSONOutput;
    }

    // ─── 1. Compliance ─────────────────────────────────────────────────────
    const last = c.readLastUserMessage();
    const sanctioned = detectApplySanction(last);
    if (!sanctioned) {
      return denyHook(
        `Compliance check failed: the manager's last turn did not explicitly sanction an apply (e.g. "apply it", "go ahead", "do it now", "yes, apply"). Either ask the manager to confirm, or use action:'queue' instead.`
      );
    }
    c.compliance.lastUserSanctionedApply = true;

    // ─── Resolve the suggestion (either existing id or a draft) ──────────
    let existingSuggestion: any = null;
    if (toolInput.suggestionId) {
      existingSuggestion = await c.prisma.tuningSuggestion.findFirst({
        where: { id: toolInput.suggestionId, tenantId: c.tenantId },
        select: {
          id: true,
          diagnosticCategory: true,
          confidence: true,
          sopCategory: true,
          sopStatus: true,
          sopPropertyId: true,
          systemPromptVariant: true,
          faqEntryId: true,
          beforeText: true,
          status: true,
        },
      });
    }
    const category = existingSuggestion?.diagnosticCategory ?? toolInput.draft?.category ?? null;
    const target = {
      sopCategory: existingSuggestion?.sopCategory ?? toolInput.draft?.sopCategory ?? null,
      sopStatus: existingSuggestion?.sopStatus ?? toolInput.draft?.sopStatus ?? null,
      sopPropertyId: existingSuggestion?.sopPropertyId ?? toolInput.draft?.sopPropertyId ?? null,
      systemPromptVariant:
        existingSuggestion?.systemPromptVariant ?? toolInput.draft?.systemPromptVariant ?? null,
      faqEntryId: existingSuggestion?.faqEntryId ?? toolInput.draft?.faqEntryId ?? null,
      // Sprint 09 fix 3 (follow-up): TOOL_CONFIG cooldown key is `beforeText`.
      // Two suggestions targeting the same tool share the same current
      // description (that's exactly how the apply handler resolves the
      // target). Using it here means two TOOL_CONFIG proposals against the
      // same tool definition will collide as intended, without needing
      // a tool-id column on TuningSuggestion.
      toolTarget:
        existingSuggestion?.beforeText ?? toolInput.draft?.beforeText ?? null,
    };
    const confidence = existingSuggestion?.confidence ?? toolInput.draft?.confidence ?? null;

    // ─── 2. Cooldown ───────────────────────────────────────────────────────
    const cooldownSince = new Date(Date.now() - COOLDOWN_WINDOW_MS);
    const targetWhere = artifactTargetWhere(category, target);
    if (targetWhere) {
      const recent = await c.prisma.tuningSuggestion.findFirst({
        where: {
          tenantId: c.tenantId,
          status: 'ACCEPTED',
          appliedAt: { gte: cooldownSince },
          ...targetWhere,
        },
        select: { id: true, appliedAt: true },
        orderBy: { appliedAt: 'desc' },
      });
      if (recent) {
        return denyHook(
          `Cooldown (48h) hit: suggestion ${recent.id} was applied at ${recent.appliedAt?.toISOString()} against the same artifact. Wait for the window to clear, or propose a materially different fix.`
        );
      }
    }

    // ─── 3. Oscillation ────────────────────────────────────────────────────
    const oscWindow = new Date(Date.now() - OSCILLATION_WINDOW_MS);
    if (targetWhere) {
      const priorAccepted = await c.prisma.tuningSuggestion.findFirst({
        where: {
          tenantId: c.tenantId,
          status: 'ACCEPTED',
          appliedAt: { gte: oscWindow },
          ...targetWhere,
        },
        select: { id: true, confidence: true, appliedAt: true },
        orderBy: { appliedAt: 'desc' },
      });
      if (priorAccepted) {
        // Sprint 09 fix 4: when EITHER the current or prior suggestion has
        // null confidence (legacy rows), the comparison 0 <= 0 * 1.25 is
        // trivially true and fires a false oscillation block. Skip the
        // check unless both sides have real confidence scores.
        const priorConfidence = priorAccepted.confidence;
        const nowConfidence = confidence;
        const bothHaveConfidence =
          typeof priorConfidence === 'number' && typeof nowConfidence === 'number';
        if (bothHaveConfidence && nowConfidence <= priorConfidence * OSCILLATION_CONFIDENCE_BOOST) {
          return denyHook(
            `Oscillation guard: an ACCEPTED suggestion (${priorAccepted.id}, confidence ${priorConfidence.toFixed(2)}) was applied to the same artifact on ${priorAccepted.appliedAt?.toISOString()}. This proposal's confidence (${nowConfidence.toFixed(2)}) does not exceed the prior by at least ${OSCILLATION_CONFIDENCE_BOOST}×. Explain to the manager and either gather stronger evidence or propose a different artifact.`
          );
        }
      }
    }

    return { continue: true } as HookJSONOutput;
  };
}

function denyHook(reason: string): HookJSONOutput {
  return {
    continue: false,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  } as HookJSONOutput;
}

function artifactTargetWhere(
  category: string | null,
  t: {
    sopCategory: string | null;
    sopStatus: string | null;
    sopPropertyId: string | null;
    systemPromptVariant: string | null;
    faqEntryId: string | null;
    toolTarget: string | null;
  }
): Record<string, unknown> | null {
  if (category === 'SOP_CONTENT' || category === 'PROPERTY_OVERRIDE' || category === 'SOP_ROUTING') {
    if (!t.sopCategory) return null;
    return {
      sopCategory: t.sopCategory,
      sopStatus: t.sopStatus,
      sopPropertyId: t.sopPropertyId,
    };
  }
  if (category === 'SYSTEM_PROMPT') {
    return t.systemPromptVariant ? { systemPromptVariant: t.systemPromptVariant } : null;
  }
  if (category === 'FAQ') {
    return t.faqEntryId ? { faqEntryId: t.faqEntryId } : null;
  }
  // Sprint 09 fix 3: TOOL_CONFIG previously had no case here, meaning zero
  // cooldown or oscillation protection. TuningSuggestion has no dedicated
  // tool-id column, so we scope by (diagnosticCategory = 'TOOL_CONFIG',
  // beforeText = the current tool description). The apply handler in
  // suggestion-action.ts identifies the target tool by exact beforeText
  // match, so two suggestions aiming at the same tool share the same
  // beforeText and collide here as intended.
  if (category === 'TOOL_CONFIG') {
    return t.toolTarget
      ? { diagnosticCategory: 'TOOL_CONFIG', beforeText: t.toolTarget }
      : null;
  }
  return null;
}
