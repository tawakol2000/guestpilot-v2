/**
 * create_tool_definition — write a new custom webhook-backed ToolDefinition.
 *
 * Schema invariants (prisma/schema.prisma):
 *   - ToolDefinition @@unique(tenantId, name) — collision must be
 *     surfaced clearly; a different tool is not a drop-in replacement.
 *   - `type` is 'system' | 'custom' — BUILD only ever creates 'custom'
 *     webhook tools. System tools are seeded by tool-definition.service.
 *   - `agentScope` is 'screening' | 'coordinator' | 'both'; default to
 *     'coordinator' (guest-facing main AI) unless the manager asks for
 *     the screening path.
 *
 * The spec §11 params include `webhookAuth` and `availableStatuses` which
 * have no backing columns today — accepted for forward-compat and echoed
 * in the data-tool-created part for UI rendering, but not persisted in
 * v1. Auth credentials belong in env (secretName) and are injected by
 * webhook-tool.service at call time; the BUILD agent should only ever
 * reference the secret *name*, never a raw secret.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { invalidateToolCache } from '../../services/tool-definition.service';
import {
  finalizeBuildTransactionIfComplete,
  markBuildTransactionPartial,
  validateBuildTransaction,
} from './build-transaction';
import { asCallToolResult, asError, type ToolContext } from './types';
import { sanitiseArtifactPayload } from '../lib/sanitise-artifact-payload';
import { emitArtifactHistory } from '../lib/artifact-history';
import { validateRationale } from '../lib/rationale-validator';
import { openRitualWindow } from '../lib/ritual-state';

// snake_case — same convention the main AI's system tools use
// (get_sop, get_faq, search_available_properties, …). Prevents drift
// between camelCase and snake_case across tools.
const SNAKE_TOOL_NAME = /^[a-z][a-z0-9_]{1,59}$/;

const RESERVATION_STATUSES = [
  'INQUIRY',
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
] as const;

const DESCRIPTION = `create_tool_definition: Create a new custom webhook-backed tool for the main AI to call.
WHEN TO USE: In BUILD mode, when the manager describes an action the AI should be able to take that isn't in the system tool suite (get_sop, get_faq, search_available_properties, create_document_checklist, check_extend_availability, mark_document_received) — e.g. "the AI should be able to check the cleaning schedule." Also callable in TUNE mode in rare MISSING_CAPABILITY → artifact-fix cases, though typically a CapabilityRequest is the right output there.
WHEN NOT TO USE: Do NOT use to modify an existing tool definition — use propose_suggestion(category='TOOL_CONFIG') or search_replace. Do NOT use without concrete webhook details — name, URL, auth, parameter schema all required.
PARAMETERS:
  name (string, snake_case, unique per tenant)
  description (string, 3-4 sentences minimum per Anthropic guidance)
  parameters (JSON schema)
  webhookUrl (string, https)
  webhookAuth (object, { type: 'bearer'|'basic'|'none', secretName })
  availableStatuses (array of reservation statuses)
  rationale (string, 15–280 chars) — REQUIRED. One-sentence explanation of WHY this tool is being created (e.g. "Manager asked for a way to check the cleaning schedule mid-turn so the AI doesn't have to escalate every scheduling question.")
  transactionId (string, optional)
  dryRun (boolean, optional) — when true, validate + return SANITISED preview, no DB write
RETURNS: { toolDefinitionId, version, previewUrl } or { dryRun: true, preview, diff }`;

const webhookAuthSchema = z.object({
  type: z.enum(['bearer', 'basic', 'none']),
  secretName: z.string().min(1).max(80).optional(),
});

export function buildCreateToolDefinitionTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext
) {
  return tool(
    'create_tool_definition',
    DESCRIPTION,
    {
      name: z.string().regex(SNAKE_TOOL_NAME, 'name must be snake_case, 2–60 chars').max(60),
      displayName: z.string().min(2).max(80).optional(),
      description: z
        .string()
        .min(40, 'description should be 3-4 sentences minimum — Anthropic guidance'),
      parameters: z.record(z.string(), z.unknown()),
      webhookUrl: z
        .string()
        .url()
        .refine((u) => u.startsWith('https://'), 'webhookUrl must be https://'),
      webhookAuth: webhookAuthSchema,
      availableStatuses: z
        .array(z.enum(RESERVATION_STATUSES as unknown as [string, ...string[]]))
        .min(1, 'availableStatuses cannot be empty'),
      agentScope: z.enum(['screening', 'coordinator', 'both']).optional(),
      webhookTimeoutMs: z.number().int().min(1000).max(60000).optional(),
      rationale: z.string(),
      transactionId: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.create_tool_definition', {
        name: args.name,
        authType: args.webhookAuth.type,
        transactionId: args.transactionId ?? null,
      });
      try {
        const rationaleCheck = validateRationale(args.rationale);
        if (!rationaleCheck.ok) {
          span.end({ error: 'RATIONALE_INVALID' });
          return asError(`create_tool_definition: ${rationaleCheck.error}`);
        }
        const rationale = rationaleCheck.rationale;

        const txCheck = await validateBuildTransaction(
          c.prisma,
          c.tenantId,
          args.transactionId
        );
        if (!txCheck.ok) {
          span.end({ error: 'TX_INVALID' });
          return asError(txCheck.error);
        }

        const existing = await c.prisma.toolDefinition.findFirst({
          where: { tenantId: c.tenantId, name: args.name },
          select: { id: true },
        });
        if (existing) {
          span.end({ error: 'TOOL_EXISTS' });
          return asError(
            `create_tool_definition: a tool named "${args.name}" already exists for this tenant (${existing.id}). Use propose_suggestion(category='TOOL_CONFIG') or search_replace to modify the description, or pick a different name.`
          );
        }

        const displayName = args.displayName ?? titleCase(args.name);

        // D1 dry-run seam — return SANITISED preview without writing.
        // Sanitiser parity: same function backs D2 history storage so a
        // secret hidden in the preview is hidden in the persisted row too.
        if (args.dryRun) {
          const rawPreview = {
            tenantId: c.tenantId,
            name: args.name,
            displayName,
            description: args.description,
            defaultDescription: args.description,
            parameters: args.parameters,
            agentScope: args.agentScope ?? 'coordinator',
            type: 'custom' as const,
            enabled: true,
            webhookUrl: args.webhookUrl,
            webhookTimeout: args.webhookTimeoutMs ?? 10000,
            webhookAuth: { type: args.webhookAuth.type, secretName: args.webhookAuth.secretName ?? null },
            availableStatuses: args.availableStatuses,
            buildTransactionId: args.transactionId ?? null,
          };
          const sanitisedPreview = sanitiseArtifactPayload(rawPreview);
          const out = {
            ok: true,
            dryRun: true,
            artifactType: 'tool_definition' as const,
            preview: sanitisedPreview,
            rationale,
            diff: {
              kind: 'create' as const,
              name: args.name,
              displayName,
              agentScope: args.agentScope ?? 'coordinator',
            },
          };
          span.end({ dryRun: true, ok: true });
          return asCallToolResult(out);
        }

        const created = await c.prisma.toolDefinition.create({
          data: {
            tenantId: c.tenantId,
            name: args.name,
            displayName,
            description: args.description,
            // Default description mirrors the initial write — lets the
            // rollback path restore to the BUILD-time baseline via
            // toolDefinition.update({ description: defaultDescription }).
            defaultDescription: args.description,
            parameters: args.parameters as any,
            agentScope: args.agentScope ?? 'coordinator',
            type: 'custom',
            enabled: true,
            webhookUrl: args.webhookUrl,
            webhookTimeout: args.webhookTimeoutMs ?? 10000,
            buildTransactionId: args.transactionId ?? null,
          },
          select: { id: true, name: true, displayName: true, agentScope: true },
        });

        // Tool schema is cached 5min by tool-definition.service. Invalidate
        // so the main AI sees the new tool on its next turn rather than
        // waiting for TTL. `{SYSTEM_TOOLS_AVAILABLE}` template variables
        // resolve against this cache at prompt-build time, so no separate
        // tenant-config invalidation is needed for net-new tools.
        invalidateToolCache(c.tenantId);
        await finalizeBuildTransactionIfComplete(
          c.prisma,
          c.tenantId,
          args.transactionId
        );

        // D2 — observational history row. tool_definition rows are
        // sanitised inside emitArtifactHistory — parity with D1 preview.
        const emission = await emitArtifactHistory(c.prisma, {
          tenantId: c.tenantId,
          artifactType: 'tool_definition',
          artifactId: created.id,
          operation: 'CREATE',
          newBody: {
            name: created.name,
            displayName: created.displayName,
            description: args.description,
            parameters: args.parameters,
            agentScope: created.agentScope,
            webhookUrl: args.webhookUrl,
            webhookTimeout: args.webhookTimeoutMs ?? 10000,
            webhookAuth: { type: args.webhookAuth.type, secretName: args.webhookAuth.secretName ?? null },
            availableStatuses: args.availableStatuses,
          },
          actorUserId: c.userId,
          actorEmail: c.actorEmail ?? null,
          conversationId: c.conversationId,
          metadata: {
            rationale,
            ...(args.transactionId ? { buildTransactionId: args.transactionId } : {}),
          },
        });
        // 054-A F3 — open verification ritual tied to this history row.
        openRitualWindow(c, emission.historyId);

        const previewUrl = `/tools/${created.id}`;
        const payload = {
          ok: true,
          toolDefinitionId: created.id,
          name: created.name,
          displayName: created.displayName,
          agentScope: created.agentScope,
          webhookUrl: args.webhookUrl,
          availableStatuses: args.availableStatuses,
          previewUrl,
          transactionId: args.transactionId ?? null,
        };
        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-tool-created',
            id: `tool:${created.id}`,
            data: {
              ...payload,
              description: args.description,
              parameters: args.parameters,
              webhookAuth: { type: args.webhookAuth.type, secretName: args.webhookAuth.secretName ?? null },
              createdAt: new Date().toISOString(),
            },
          });
        }
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        await markBuildTransactionPartial(c.prisma, c.tenantId, args.transactionId, {
          failedTool: 'create_tool_definition',
          message: msg,
        });
        if (err?.code === 'P2002') {
          span.end({ error: 'UNIQUE_CONSTRAINT' });
          return asError(
            `create_tool_definition: unique-constraint collision on (tenant, name). Pick a different name or edit the existing tool.`
          );
        }
        span.end({ error: String(err) });
        return asError(`create_tool_definition failed: ${msg}`);
      }
    }
  );
}

function titleCase(snake: string): string {
  return snake
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}
