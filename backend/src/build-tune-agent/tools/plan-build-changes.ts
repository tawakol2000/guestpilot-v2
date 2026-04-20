/**
 * plan_build_changes — surface a reviewable plan of multiple artifact
 * writes BEFORE executing any. Creates a BuildTransaction with
 * status='PLANNED' and emits a `data-build-plan` part to the frontend
 * for manager approval.
 *
 * Does NOT execute any writes. Subsequent create_* calls reference the
 * returned transactionId; build-transaction.ts flips PLANNED → EXECUTING
 * on first reference.
 *
 * Callable in both BUILD and TUNE modes per spec §11 (TUNE's multi-
 * artifact corrections sometimes span SOPs + FAQs + system prompt).
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { Prisma } from '@prisma/client';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `plan_build_changes: Surface a reviewable plan of multiple artifact writes before executing any of them. Returns a plan_id (transactionId) that subsequent create_* calls reference.
WHEN TO USE: BEFORE any sequence of 2+ create_* calls within a single user turn OR when a single manager statement implies multiple artifacts. Also appropriate in TUNE mode for multi-artifact corrections that touch SOPs + FAQs + system prompt together.
WHEN NOT TO USE: Do NOT use for single-artifact operations. Do NOT use after create_* calls have already been made — call plan first or not at all.
PARAMETERS:
  items (array of { type: 'sop'|'faq'|'system_prompt'|'tool_definition', name: string, rationale: string, target?: {artifactId?, sectionId?, slotKey?, lineRange?}, previewDiff?: {before, after} })
    - target: machine-readable pointer to the artifact/section the item edits. Supply whenever editing something that exists (lets the frontend render a chip so the manager can click through).
    - previewDiff: optional before/after text for the plan-checklist's expandable disclosure. Omit if the body is being generated lazily inside the subsequent create_* call.
  rationale (string, ≤500 chars, overall plan rationale)
RETURNS: { transactionId, plannedAt, approvalRequired, uiHint }`;

const planItemSchema = z.object({
  type: z.enum(['sop', 'faq', 'system_prompt', 'tool_definition']),
  name: z.string().min(1).max(120),
  rationale: z.string().min(5).max(500),
  // Sprint 046 Session B — machine-readable target + optional before/after
  // preview for the plan-checklist's expandable disclosure. Both fields are
  // optional so existing planners don't break, but the frontend renders a
  // chip whenever `target` is present and an "expand diff" affordance
  // whenever `previewDiff` is present.
  target: z
    .object({
      artifactId: z.string().optional(),
      sectionId: z.string().optional(),
      slotKey: z.string().optional(),
      lineRange: z.tuple([z.number(), z.number()]).optional(),
    })
    .optional(),
  previewDiff: z
    .object({
      before: z.string(),
      after: z.string(),
    })
    .optional(),
});

export function buildPlanBuildChangesTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext
) {
  return tool(
    'plan_build_changes',
    DESCRIPTION,
    {
      items: z.array(planItemSchema).min(1).max(10),
      rationale: z.string().min(5).max(500),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.plan_build_changes', {
        itemCount: args.items.length,
        types: args.items.map((i) => i.type).join(','),
      });
      try {
        const created = await c.prisma.buildTransaction.create({
          data: {
            tenantId: c.tenantId,
            conversationId: c.conversationId,
            plannedItems: args.items as unknown as Prisma.InputJsonValue,
            status: 'PLANNED',
            rationale: args.rationale,
          },
          select: { id: true, createdAt: true },
        });

        const approvalRequired = args.items.length > 1;
        const plannedAt = created.createdAt.toISOString();
        const payload = {
          ok: true,
          transactionId: created.id,
          plannedAt,
          approvalRequired,
          uiHint:
            'Show this plan to the manager and wait for approval before executing any create_* calls that reference this transactionId.',
          items: args.items,
          rationale: args.rationale,
        };
        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-build-plan',
            id: `plan:${created.id}`,
            data: payload,
          });
        }
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`plan_build_changes failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
