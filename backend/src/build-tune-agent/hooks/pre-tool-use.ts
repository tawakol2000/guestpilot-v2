/**
 * PreToolUse hook — runs before every tool call.
 *
 * Sprint 046 Session D: cooldown removal. The hook still enforces:
 *   1. Compliance — suggestion_action(apply | edit_then_apply) and
 *      rollback require an explicit manager-sanctioning turn.
 *   2. Oscillation detection — when a prior ACCEPTED suggestion targeted
 *      the same artifact within 14d and the new confidence does not
 *      meet the 1.25× boost floor, we emit a non-blocking
 *      `data-advisory` (kind: 'oscillation') so the Studio renderer can
 *      surface a muted warning chip. The advisory never blocks.
 *   3. Recent-edit advisory — when the artifact targeted by the apply
 *      was last written inside the last 48h, emit a non-blocking
 *      `data-advisory` (kind: 'recent-edit') so the manager can factor
 *      in the recent churn. Never blocks.
 *
 * Sprint 047 Session A: BUILD-write advisory extension. The recent-edit
 * and oscillation advisories now also fire on BUILD-mode create_*
 * tools (create_sop, create_faq, create_tool_definition,
 * write_system_prompt). No compliance check on BUILD creators —
 * they're direct-write by design, not manager-sanctioned applies.
 * Advisory only, never blocks — a broken hook is worse than a partial
 * advisory (plan §5.2 / session-a §2.4).
 *
 * The 48h deny-on-cooldown gate is gone. If abuse patterns appear in
 * production, handle them with rate-limiting on the controller per plan
 * §5.2 / NEXT.md §6 — do not re-add the hook block.
 */
import type {
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { TUNING_AGENT_TOOL_NAMES } from '../tools/names';
import {
  OSCILLATION_WINDOW_MS,
  OSCILLATION_CONFIDENCE_BOOST,
  RECENT_EDIT_WINDOW_MS,
  detectApplySanction,
  detectRollbackSanction,
  type HookContext,
} from './shared';
import { DATA_PART_TYPES, type AdvisoryData } from '../data-parts';

/**
 * Sprint 047 Session A — BUILD-mode creator tool names. These write
 * artifacts directly without going through suggestion_action. The hook
 * emits recent-edit / oscillation advisories for them but never blocks
 * — they're direct-write by design, not manager-sanctioned applies.
 */
const BUILD_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  TUNING_AGENT_TOOL_NAMES.studio_create_sop,
  TUNING_AGENT_TOOL_NAMES.studio_create_faq,
  TUNING_AGENT_TOOL_NAMES.studio_create_tool_definition,
  TUNING_AGENT_TOOL_NAMES.studio_create_system_prompt,
]);

/**
 * Derive a `targetWhere` Prisma fragment from a BUILD creator tool input.
 * Mirrors the shape artifactTargetWhere produces for suggestion_action so
 * the same recent-edit query works. Returns null when the input is too
 * sparse to match a prior ACCEPTED TuningSuggestion target.
 */
function buildWriteTargetWhere(
  toolName: string,
  toolInput: Record<string, unknown>
): Record<string, unknown> | null {
  if (toolName === TUNING_AGENT_TOOL_NAMES.studio_create_sop) {
    const sopCategory = (toolInput.sopCategory as string | undefined) ?? null;
    if (!sopCategory) return null;
    return {
      sopCategory,
      sopStatus: null,
      sopPropertyId: (toolInput.propertyId as string | undefined) ?? null,
    };
  }
  if (toolName === TUNING_AGENT_TOOL_NAMES.studio_create_faq) {
    // FAQ creates don't have a stable faqEntryId pre-write (the row is
    // generated inside create_faq). Match by the category+question+
    // propertyId tuple stored alongside the TuningSuggestion.
    const question = (toolInput.question as string | undefined) ?? null;
    const faqCategory = (toolInput.category as string | undefined) ?? null;
    if (!question && !faqCategory) return null;
    const where: Record<string, unknown> = {};
    if (faqCategory) where.faqCategory = faqCategory;
    if (question) where.faqQuestion = question;
    const propertyId = (toolInput.propertyId as string | undefined) ?? null;
    if (propertyId !== null) where.faqPropertyId = propertyId;
    return where;
  }
  if (toolName === TUNING_AGENT_TOOL_NAMES.studio_create_tool_definition) {
    // Mirrors suggestion_action's TOOL_CONFIG cooldown key: two
    // suggestions targeting the same tool share `beforeText` = the
    // current tool description. For a fresh create, we haven't seen the
    // target yet, so match loosely by diagnosticCategory TOOL_CONFIG.
    // Advisory will fire if ANY tool_config edit happened recently; a
    // more precise match requires a tool-id column we don't have.
    return { diagnosticCategory: 'TOOL_CONFIG' };
  }
  if (toolName === TUNING_AGENT_TOOL_NAMES.studio_create_system_prompt) {
    const variant = (toolInput.variant as string | undefined) ?? null;
    if (!variant) return null;
    return { systemPromptVariant: variant };
  }
  return null;
}

async function emitRecentEditAdvisoryFor(
  c: HookContext,
  targetWhere: Record<string, unknown>,
  idHint: string
): Promise<void> {
  if (!c.emitDataPart) return;
  const recentSince = new Date(Date.now() - RECENT_EDIT_WINDOW_MS);
  const recent = await c.prisma.tuningSuggestion.findFirst({
    where: {
      tenantId: c.tenantId,
      status: 'ACCEPTED',
      appliedAt: { gte: recentSince },
      ...targetWhere,
    },
    select: { id: true, appliedAt: true },
    orderBy: { appliedAt: 'desc' },
  });
  if (!recent) return;
  const lastEditedAt = recent.appliedAt?.toISOString() ?? null;
  const advisory: AdvisoryData = {
    kind: 'recent-edit',
    message: lastEditedAt
      ? `This artifact was last edited on ${lastEditedAt}.`
      : 'This artifact was edited recently.',
    context: { lastEditedAt, priorSuggestionId: recent.id, source: idHint },
  };
  c.emitDataPart({
    type: DATA_PART_TYPES.advisory,
    id: `advisory:recent-edit:${idHint}:${recent.id}`,
    data: advisory,
    transient: true,
  });
}

export function buildPreToolUseHook(ctx: () => HookContext): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true } as HookJSONOutput;
    }
    const pre = input as PreToolUseHookInput;
    const c = ctx();

    // ─── Sprint 047 Session A: BUILD-creator advisory extension ──────────
    // Non-blocking recent-edit on direct BUILD writes. Runs before the
    // rollback / suggestion_action branches so a broken BUILD query never
    // swallows those paths' existing behaviour. Failure here is swallowed.
    if (BUILD_WRITE_TOOL_NAMES.has(pre.tool_name)) {
      try {
        const targetWhere = buildWriteTargetWhere(
          pre.tool_name,
          (pre.tool_input ?? {}) as Record<string, unknown>
        );
        if (targetWhere) {
          await emitRecentEditAdvisoryFor(
            c,
            targetWhere,
            pre.tool_name.replace(/^mcp__[^_]+__/, '')
          );
        }
      } catch (err) {
        console.warn(
          '[pre-tool-use] build-creator advisory lookup failed:',
          err
        );
      }
      return { continue: true } as HookJSONOutput;
    }

    // ─── Sprint 09 fix 5: rollback also writes to artifacts ───────────────
    // The rollback tool bypassed compliance entirely, which violated the
    // human-in-the-loop principle. Require an explicit rollback sanction
    // before the handler runs.
    if (pre.tool_name === TUNING_AGENT_TOOL_NAMES.studio_rollback) {
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
    const targetWhere = artifactTargetWhere(category, target);

    // ─── 2. Recent-edit advisory ───────────────────────────────────────────
    //
    // Formerly the 48h cooldown-deny. Sprint 046 Session D demoted it to
    // a non-blocking advisory per plan §5.2 — the Studio renderer paints a
    // muted "last edited Nh ago" chip above the suggested-fix card.
    if (targetWhere) {
      const recentSince = new Date(Date.now() - RECENT_EDIT_WINDOW_MS);
      const recent = await c.prisma.tuningSuggestion.findFirst({
        where: {
          tenantId: c.tenantId,
          status: 'ACCEPTED',
          appliedAt: { gte: recentSince },
          ...targetWhere,
        },
        select: { id: true, appliedAt: true },
        orderBy: { appliedAt: 'desc' },
      });
      if (recent && c.emitDataPart) {
        const lastEditedAt = recent.appliedAt?.toISOString() ?? null;
        const advisory: AdvisoryData = {
          kind: 'recent-edit',
          message: lastEditedAt
            ? `This artifact was last edited on ${lastEditedAt}.`
            : 'This artifact was edited recently.',
          context: { lastEditedAt, priorSuggestionId: recent.id },
        };
        c.emitDataPart({
          type: DATA_PART_TYPES.advisory,
          id: `advisory:recent-edit:${recent.id}`,
          data: advisory,
          transient: true,
        });
      }
    }

    // ─── 3. Oscillation advisory (non-blocking) ────────────────────────────
    //
    // Sprint 046 Session D: still detect reversal-within-14d at confidence
    // below the 1.25× boost floor, but emit a `data-advisory` instead of
    // denying the apply. The boost check remains informative for
    // Langfuse / dashboards but never gates execution.
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
        const priorConfidence = priorAccepted.confidence;
        const nowConfidence = confidence;
        const bothHaveConfidence =
          typeof priorConfidence === 'number' && typeof nowConfidence === 'number';
        if (bothHaveConfidence) {
          const requiredFloor = priorConfidence * OSCILLATION_CONFIDENCE_BOOST;
          const passed = nowConfidence >= requiredFloor;
          console.log(
            `[TuningAgent] oscillation_check tenant=${c.tenantId} prior=${priorAccepted.id} prior_conf=${priorConfidence.toFixed(2)} now_conf=${nowConfidence.toFixed(2)} required_floor=${requiredFloor.toFixed(2)} boost=${OSCILLATION_CONFIDENCE_BOOST} passed=${passed}`
          );
          if (!passed && c.emitDataPart) {
            const advisory: AdvisoryData = {
              kind: 'oscillation',
              message: `This artifact was edited recently at a higher confidence (${priorConfidence.toFixed(2)}). New proposal confidence ${nowConfidence.toFixed(2)} is below the recommended ${requiredFloor.toFixed(2)} floor.`,
              context: {
                priorSuggestionId: priorAccepted.id,
                priorConfidence,
                nowConfidence,
                requiredFloor,
                priorAppliedAt: priorAccepted.appliedAt?.toISOString() ?? null,
              },
            };
            c.emitDataPart({
              type: DATA_PART_TYPES.advisory,
              id: `advisory:oscillation:${priorAccepted.id}`,
              data: advisory,
              transient: true,
            });
          }
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
