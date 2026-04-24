/**
 * write_system_prompt — write or replace the tenant's coordinator or
 * screening system prompt.
 *
 * Gate 2 enforcement:
 *   - ≤2,500 token cap (heuristic chars × 0.25 ≥ 10,000 chars rejects).
 *   - Shared 100-char floor — matches tenant-config.service validation
 *     so a BUILD write never produces a prompt the update path would
 *     reject later.
 *   - Coverage ≥0.7 AND all 6 load-bearing slots non-default, computed
 *     from `slotValues`. Default-marked slots
 *     (`<!-- DEFAULT: change me -->`) count toward coverage ONLY for
 *     non-load-bearing slots; load-bearing slots must be non-default.
 *   - Explicit manager sanction required (`managerSanctioned: true`).
 *     The agent must have received the sanction in the manager's last
 *     turn before calling.
 *
 * Persistence:
 *   - Creates a new AiConfigVersion with the full config snapshot tagged
 *     with buildTransactionId, so the plan-level rollback path can
 *     restore the prior version atomically.
 *   - Updates TenantAiConfig.systemPromptCoordinator or
 *     systemPromptScreening + bumps systemPromptVersion + snapshots
 *     previous into systemPromptHistory (last 10 kept).
 *
 * Does NOT import tenant-config.service (which eagerly loads
 * ai.service and the OpenAI client). The update shape is duplicated
 * here deliberately — see the tenant-config-parity comment below.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { Prisma } from '@prisma/client';
import { startAiSpan } from '../../services/observability.service';
import {
  finalizeBuildTransactionIfComplete,
  markBuildTransactionPartial,
  validateBuildTransaction,
} from './build-transaction';
import { asCallToolResult, asError, type ToolContext } from './types';
import { emitArtifactHistory } from '../lib/artifact-history';
import { validateRationale } from '../lib/rationale-validator';
import { openRitualWindow } from '../lib/ritual-state';
import { invalidateTenantConfigCache } from '../../services/tenant-config.service';

// Spec §6 graduation criteria — load-bearing slots must be covered with
// non-default values before write_system_prompt is allowed.
const LOAD_BEARING_SLOTS = [
  'property_identity',
  'checkin_time',
  'checkout_time',
  'escalation_contact',
  'payment_policy',
  'brand_voice',
] as const;

// Non-load-bearing slots (defaults permitted). 14 total per spec §10.
const NON_LOAD_BEARING_SLOTS = [
  'cleaning_policy',
  'amenities_list',
  'local_recommendations',
  'emergency_contact',
  'noise_policy',
  'pet_policy',
  'smoking_policy',
  'max_occupancy',
  'id_verification',
  'long_stay_discount',
  'cancellation_policy',
  'channel_coverage',
  'timezone',
  'ai_autonomy',
] as const;

const TOTAL_SLOTS = LOAD_BEARING_SLOTS.length + NON_LOAD_BEARING_SLOTS.length;
const COVERAGE_FLOOR = 0.7;

// 2,500 tokens × 4 chars/token ≈ 10,000 chars. Generous upper bound.
const MAX_PROMPT_CHARS = 10_000;
const MIN_PROMPT_CHARS = 100; // parity with tenant-config.service validation

const DEFAULT_MARKER = '<!-- DEFAULT: change me -->';

const DESCRIPTION = `write_system_prompt: Write or replace the tenant's coordinator or screening system prompt.
WHEN TO USE: In BUILD mode, after the canonical hospitality template has been filled to at least coverage ≥ 0.7 and all 6 load-bearing slots have non-default values. The manager explicitly sanctions the write.
WHEN NOT TO USE: Do NOT use to make small edits to an existing system prompt — use propose_suggestion(category='SYSTEM_PROMPT') or search_replace instead. Do NOT use mid-interview while slots are still unfilled — the template will produce a fragment-quality prompt.
PARAMETERS:
  variant (enum 'coordinator' | 'screening')
  text (string, ≤2,500 tokens, COMPLETE prompt — no fragments)
  sourceTemplateVersion (string, hash of the GENERIC_HOSPITALITY_SEED.md used at render time)
  slotValues (object, key→value map of the slots that produced this prompt; used for re-render and audit)
  rationale (string, 15–280 chars) — REQUIRED. One-sentence explanation of WHY this system prompt is being written (e.g. "Graduated to system-prompt write after all 6 load-bearing slots were confirmed with non-default manager answers.")
  transactionId (string, optional)
  dryRun (boolean, optional) — when true, validate + return preview, no DB write
RETURNS: { configVersionId, previewUrl } or { dryRun: true, preview, diff }`;

export function buildWriteSystemPromptTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext
) {
  return tool(
    'studio_create_system_prompt',
    DESCRIPTION,
    {
      variant: z.enum(['coordinator', 'screening']),
      text: z
        .string()
        .min(MIN_PROMPT_CHARS)
        .max(MAX_PROMPT_CHARS, `text exceeds ~2,500 token cap (${MAX_PROMPT_CHARS} chars)`),
      sourceTemplateVersion: z.string().min(1).max(120),
      slotValues: z.record(z.string(), z.string()),
      managerSanctioned: z
        .literal(true, "managerSanctioned must be true — manager must sanction the write in their last turn"),
      // Bugfix (2026-04-23): see create-sop.ts for the same fix.
      rationale: z.string().min(15).max(280),
      transactionId: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.write_system_prompt', {
        variant: args.variant,
        sourceTemplateVersion: args.sourceTemplateVersion,
        slotCount: Object.keys(args.slotValues).length,
        transactionId: args.transactionId ?? null,
      });
      try {
        const rationaleCheck = validateRationale(args.rationale);
        if (!rationaleCheck.ok) {
          span.end({ error: 'RATIONALE_INVALID' });
          return asError(`write_system_prompt: ${rationaleCheck.error}`);
        }
        const rationale = rationaleCheck.rationale;

        // Coverage + load-bearing checks.
        const coverage = computeCoverage(args.slotValues);
        if (coverage.coverageRatio < COVERAGE_FLOOR) {
          span.end({ error: 'COVERAGE_TOO_LOW', ratio: coverage.coverageRatio });
          return asError(
            `write_system_prompt: coverage is ${coverage.coverageRatio.toFixed(2)} < ${COVERAGE_FLOOR}. Fill more slots or run interview rounds for: ${coverage.unfilledSlots.slice(0, 5).join(', ')}${coverage.unfilledSlots.length > 5 ? '…' : ''}.`
          );
        }
        if (coverage.loadBearingDefaulted.length > 0) {
          span.end({
            error: 'LOAD_BEARING_DEFAULTED',
            slots: coverage.loadBearingDefaulted,
          });
          return asError(
            `write_system_prompt: load-bearing slots still hold default values — cannot ship a system prompt where ${coverage.loadBearingDefaulted.join(', ')} are defaulted. Interview the manager on these before calling.`
          );
        }
        if (coverage.loadBearingMissing.length > 0) {
          span.end({
            error: 'LOAD_BEARING_MISSING',
            slots: coverage.loadBearingMissing,
          });
          return asError(
            `write_system_prompt: load-bearing slots missing from slotValues: ${coverage.loadBearingMissing.join(', ')}. All 6 of {${LOAD_BEARING_SLOTS.join(', ')}} are required.`
          );
        }

        const txCheck = await validateBuildTransaction(
          c.prisma,
          c.tenantId,
          args.transactionId
        );
        if (!txCheck.ok) {
          span.end({ error: 'TX_INVALID' });
          return asError(txCheck.error);
        }

        // Fetch current config for snapshotting (if it exists).
        const current = await c.prisma.tenantAiConfig.findUnique({
          where: { tenantId: c.tenantId },
        });

        // D1 dry-run seam — return the would-be payload without persisting.
        // Validation (coverage + load-bearing + tx) has already run above.
        if (args.dryRun) {
          const previewPayload = {
            tenantId: c.tenantId,
            variant: args.variant,
            field:
              args.variant === 'coordinator'
                ? 'systemPromptCoordinator'
                : 'systemPromptScreening',
            text: args.text,
            sourceTemplateVersion: args.sourceTemplateVersion,
            slotValues: args.slotValues,
            buildTransactionId: args.transactionId ?? null,
            characterLength: args.text.length,
            estimatedTokens: Math.ceil(args.text.length / 4),
          };
          const out = {
            ok: true,
            dryRun: true,
            artifactType: 'system_prompt' as const,
            preview: previewPayload,
            rationale,
            diff: {
              kind: 'update' as const,
              variant: args.variant,
              coverage: coverage.coverageRatio,
              defaultedSlots: coverage.defaultedSlots,
            },
          };
          span.end({ dryRun: true, ok: true });
          return asCallToolResult(out);
        }



        const field =
          args.variant === 'coordinator'
            ? 'systemPromptCoordinator'
            : 'systemPromptScreening';

        // Snapshot the outgoing prompt into systemPromptHistory (cap 10).
        const history: any[] = Array.isArray(current?.systemPromptHistory)
          ? [...(current!.systemPromptHistory as any[])]
          : [];
        if (current && (current as any)[field]) {
          history.push({
            version: current.systemPromptVersion,
            timestamp: new Date().toISOString(),
            [args.variant]: (current as any)[field] as string,
            note: `Superseded by write_system_prompt (BUILD)`,
          });
          while (history.length > 10) history.shift();
        }

        // Bugfix (2026-04-22): wrap the TenantAiConfig upsert and the
        // AiConfigVersion insert in a single $transaction. Previously
        // the upsert committed first and the version-insert ran
        // separately; if the version-insert threw (DB hiccup, serialisation
        // conflict), the live prompt was already flipped but no rollback
        // anchor existed. The rollback tool reads `aiConfigVersion` rows
        // — without one, the prompt could not be rolled back by the
        // plan path. Manager would think the plan was safe; it wasn't.
        const [updated, versionRow] = await c.prisma.$transaction(async (tx) => {
          const u = await tx.tenantAiConfig.upsert({
            where: { tenantId: c.tenantId },
            update: {
              [field]: args.text,
              systemPromptVersion: { increment: 1 },
              systemPromptHistory: history as Prisma.InputJsonValue,
            },
            create: {
              tenantId: c.tenantId,
              [field]: args.text,
              // Prisma defaults everything else; explicit set here only for
              // the two fields write_system_prompt owns.
            } as any,
            select: {
              systemPromptVersion: true,
              systemPromptCoordinator: true,
              systemPromptScreening: true,
            },
          });

          // Write an AiConfigVersion snapshot tagged with buildTransactionId.
          // The rollback path reads `config.systemPromptCoordinator` /
          // `...Screening` — we include both so the rollback can restore
          // either side. Inside the same tx so a throw here rolls the
          // upsert back too.
          const v = await tx.aiConfigVersion.create({
            data: {
              tenantId: c.tenantId,
              version: u.systemPromptVersion,
              config: {
                systemPromptCoordinator: u.systemPromptCoordinator ?? null,
                systemPromptScreening: u.systemPromptScreening ?? null,
                sourceTemplateVersion: args.sourceTemplateVersion,
                slotValues: args.slotValues,
                variantWritten: args.variant,
              } as Prisma.InputJsonValue,
              note: `BUILD write_system_prompt (${args.variant}) — template=${args.sourceTemplateVersion}, coverage=${coverage.coverageRatio.toFixed(2)}`,
              buildTransactionId: args.transactionId ?? null,
            },
            select: { id: true, version: true },
          });

          return [u, v] as const;
        });

        // Main AI will pick up the new prompt after the tenant-config
        // 60s TTL expires. We do NOT invalidate here because
        // tenant-config.service transitively loads ai.service (which
        // eager-inits OpenAI + pulls middleware/auth via socket.service),
        // and pulling that graph from the BUILD tool layer is a bigger
        // dependency change than Gate 2 should make. Acceptable trade-off:
        // the manager is still in BUILD/preview mode when this writes, so
        // a 60s delay before main-AI propagation is not user-visible.
        // Sprint 046 can add a leaner invalidation path if needed.

        await finalizeBuildTransactionIfComplete(
          c.prisma,
          c.tenantId,
          args.transactionId
        );

        // D2 — observational history row. artifactId is the variant name
        // ("coordinator" | "screening") to match the drawer's read-seam.
        // prevBody holds whatever was in the target field before this
        // write (null for a fresh tenant).
        const prevField = current
          ? args.variant === 'coordinator'
            ? current.systemPromptCoordinator
            : current.systemPromptScreening
          : null;
        const operation: 'CREATE' | 'UPDATE' = prevField ? 'UPDATE' : 'CREATE';
        const emission = await emitArtifactHistory(c.prisma, {
          tenantId: c.tenantId,
          artifactType: 'system_prompt',
          artifactId: args.variant,
          operation,
          prevBody: prevField ? { text: prevField, variant: args.variant } : null,
          newBody: {
            text: args.text,
            variant: args.variant,
            sourceTemplateVersion: args.sourceTemplateVersion,
            slotValues: args.slotValues,
          },
          actorUserId: c.userId,
          actorEmail: c.actorEmail ?? null,
          conversationId: c.conversationId,
          metadata: {
            rationale,
            version: versionRow.version,
            ...(args.transactionId ? { buildTransactionId: args.transactionId } : {}),
          },
        });
        // 054-A F3 — open verification ritual tied to this history row.
        openRitualWindow(c, emission.historyId, {
          artifactType: 'system_prompt',
          artifactId: args.variant,
          operation,
        });

        // Bugfix (2026-04-23): tenant-config cache had a 60s TTL, so a
        // just-written system prompt stayed invisible to the main
        // pipeline for up to a minute. The admin-apply path in
        // artifact-apply.ts was already calling
        // `invalidateTenantConfigCache` (2026-04-22 fix); the agent
        // write path was missed. Mirror it here so edits propagate
        // immediately — matches the operator's expectation that
        // "apply" means "live on the next guest message."
        invalidateTenantConfigCache(c.tenantId);

        const previewUrl = `/system-prompt/${versionRow.id}`;
        const payload = {
          ok: true,
          configVersionId: versionRow.id,
          version: versionRow.version,
          variant: args.variant,
          coverage: coverage.coverageRatio,
          defaultedSlots: coverage.defaultedSlots,
          previewUrl,
          transactionId: args.transactionId ?? null,
        };
        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-system-prompt-written',
            id: `sp:${versionRow.id}`,
            data: {
              ...payload,
              sourceTemplateVersion: args.sourceTemplateVersion,
              characterLength: args.text.length,
              estimatedTokens: Math.ceil(args.text.length / 4),
              createdAt: new Date().toISOString(),
            },
          });
        }
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        await markBuildTransactionPartial(c.prisma, c.tenantId, args.transactionId, {
          failedTool: 'write_system_prompt',
          message: msg,
        });
        span.end({ error: String(err) });
        return asError(`write_system_prompt failed: ${msg}`);
      }
    }
  );
}

interface CoverageResult {
  coverageRatio: number;
  loadBearingMissing: string[];
  loadBearingDefaulted: string[];
  defaultedSlots: string[];
  unfilledSlots: string[];
}

function computeCoverage(slotValues: Record<string, string>): CoverageResult {
  const loadBearingMissing: string[] = [];
  const loadBearingDefaulted: string[] = [];
  const defaultedSlots: string[] = [];
  const unfilledSlots: string[] = [];
  let filled = 0;

  for (const slot of LOAD_BEARING_SLOTS) {
    const v = slotValues[slot];
    if (!v || !v.trim()) {
      loadBearingMissing.push(slot);
      unfilledSlots.push(slot);
      continue;
    }
    if (v.includes(DEFAULT_MARKER)) {
      loadBearingDefaulted.push(slot);
      defaultedSlots.push(slot);
      // Defaulted load-bearing slots do not count as filled for
      // graduation purposes; they fail the secondary check anyway.
      continue;
    }
    filled += 1;
  }
  for (const slot of NON_LOAD_BEARING_SLOTS) {
    const v = slotValues[slot];
    if (!v || !v.trim()) {
      unfilledSlots.push(slot);
      continue;
    }
    if (v.includes(DEFAULT_MARKER)) {
      defaultedSlots.push(slot);
    }
    // Default-marked non-load-bearing slots still count toward coverage.
    filled += 1;
  }
  return {
    coverageRatio: filled / TOTAL_SLOTS,
    loadBearingMissing,
    loadBearingDefaulted,
    defaultedSlots,
    unfilledSlots,
  };
}
