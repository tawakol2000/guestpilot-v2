/**
 * create_sop — write a new SOP (SopDefinition + SopVariant, or
 * SopPropertyOverride if propertyId is set).
 *
 * Schema invariants (prisma/schema.prisma):
 *   - SopDefinition is @@unique(tenantId, category). If a definition
 *     already exists for the category, reuse it and create a new variant
 *     against it.
 *   - SopVariant is @@unique(sopDefinitionId, status). A duplicate status
 *     on an existing definition is a user error — surface it.
 *   - SopPropertyOverride is @@unique(sopDefinitionId, propertyId, status).
 *
 * Optional transactionId tags the variant/override so the plan-level
 * rollback path (tools/version-history.ts buildRollbackTool, transaction
 * branch) can DELETE it atomically.
 *
 * `triggers` is accepted for forward-compat and echoed in the data part,
 * but not persisted — SopDefinition.toolDescription is the canonical
 * classifier hint and is populated from `title + body summary` at this
 * tier. Future sprints may add a dedicated triggers column.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { invalidateSopCache } from '../../services/sop.service';
import {
  finalizeBuildTransactionIfComplete,
  markBuildTransactionPartial,
  validateBuildTransaction,
} from './build-transaction';
import { asCallToolResult, asError, type ToolContext } from './types';
import { emitArtifactHistory } from '../lib/artifact-history';
import { validateRationale } from '../lib/rationale-validator';
import { openRitualWindow } from '../lib/ritual-state';

const SOP_STATUSES = [
  'DEFAULT',
  'INQUIRY',
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
] as const;
type SopStatus = (typeof SOP_STATUSES)[number];

// Kebab-case canonical form. Prevents drift between "parking-info",
// "Parking Info", "parkingInfo" across BUILD sessions.
const KEBAB_CATEGORY = /^[a-z][a-z0-9]*(-[a-z0-9]+){0,7}$/;

const DESCRIPTION = `create_sop: Create a new Standard Operating Procedure artifact.
WHEN TO USE: In BUILD mode, when the manager describes a policy or procedure that doesn't yet exist and you have enough detail to write a draft (two or more converging incidents OR an explicit policy statement the manager has confirmed). Also callable in TUNE mode in the rare case a MISSING_CAPABILITY correction reveals an entire SOP is absent — but only with user confirmation to switch to BUILD mode. In TUNE mode allowed_tools will deny this call; surface the need to switch.
WHEN NOT TO USE: Do NOT use to modify an existing SOP — use search_replace or propose_suggestion instead. Do NOT use as a guess after a single vague incident — probe for cues first.
PARAMETERS:
  sopCategory (string, 3-8 words, kebab-case canonical name — must not collide with an existing sopCategory for this tenant)
  status (enum DEFAULT | INQUIRY | PENDING | CONFIRMED | CHECKED_IN | CHECKED_OUT) — the reservation status this SOP applies to. Prefer DEFAULT if the policy is status-agnostic.
  propertyId (string, optional) — if set, creates a SopPropertyOverride for this property. If null, creates a global SopVariant.
  title (string, 3-8 words, human-readable)
  body (string, ≤800 tokens, use the canonical hospitality template structure)
  triggers (array of strings, guest-message patterns that invoke this SOP at classification time)
  rationale (string, 15–280 chars) — REQUIRED. One-sentence explanation of WHY this SOP is being created (e.g. "Tightened the late-checkout SOP to cap approvals at 2pm per the policy clarification the manager gave this turn.")
  transactionId (string, optional) — if part of a plan_build_changes plan, pass the plan's id.
  dryRun (boolean, optional) — when true, validate + return preview, no DB write
RETURNS: { sopId, variantId, version, previewUrl } or { dryRun: true, preview, diff }`;

export function buildCreateSopTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'create_sop',
    DESCRIPTION,
    {
      sopCategory: z
        .string()
        .min(3)
        .max(80)
        .regex(KEBAB_CATEGORY, 'sopCategory must be kebab-case (e.g. "late-checkout-policy")'),
      status: z.enum(SOP_STATUSES as unknown as [string, ...string[]]),
      propertyId: z.string().optional(),
      title: z.string().min(3).max(80),
      body: z.string().min(20).max(8000),
      triggers: z.array(z.string().min(1).max(200)).max(20).optional(),
      // Bugfix (2026-04-23): was `z.string()` unbounded — empty/short
      // rationales passed Zod and then failed the downstream
      // `validateRationale(15..280)` check with a generic message.
      // Fail at the schema boundary so the agent gets actionable
      // "minimum 15 chars" guidance on its retry turn.
      rationale: z.string().min(15).max(280),
      transactionId: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.create_sop', {
        category: args.sopCategory,
        status: args.status,
        hasProperty: Boolean(args.propertyId),
        transactionId: args.transactionId ?? null,
      });
      try {
        const rationaleCheck = validateRationale(args.rationale);
        if (!rationaleCheck.ok) {
          span.end({ error: 'RATIONALE_INVALID' });
          return asError(`create_sop: ${rationaleCheck.error}`);
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

        if (args.propertyId) {
          const prop = await c.prisma.property.findFirst({
            where: { id: args.propertyId, tenantId: c.tenantId },
            select: { id: true },
          });
          if (!prop) {
            span.end({ error: 'PROPERTY_NOT_FOUND' });
            return asError(
              `create_sop: property ${args.propertyId} not found for this tenant.`
            );
          }
        }

        const status = args.status as SopStatus;
        const titleLine = args.title.trim();
        const toolDescription = `${titleLine}. ${summariseFirstLine(args.body)}`.slice(0, 500);

        // D1 dry-run seam — read-only existence checks then return preview.
        // Read existing definition so we can include the would-be sopId
        // in the preview when the category already exists. We deliberately
        // do not upsert in dry-run; an absent definition surfaces as null.
        if (args.dryRun) {
          const existingDef = await c.prisma.sopDefinition.findUnique({
            where: { tenantId_category: { tenantId: c.tenantId, category: args.sopCategory } },
            select: { id: true },
          });
          if (args.propertyId && existingDef) {
            const existingOverride = await c.prisma.sopPropertyOverride.findUnique({
              where: {
                sopDefinitionId_propertyId_status: {
                  sopDefinitionId: existingDef.id,
                  propertyId: args.propertyId,
                  status,
                },
              },
              select: { id: true },
            });
            if (existingOverride) {
              span.end({ error: 'OVERRIDE_EXISTS', dryRun: true });
              return asError(
                `create_sop: a property override for category "${args.sopCategory}" status ${status} on this property already exists (${existingOverride.id}). Use search_replace or propose_suggestion to modify it.`
              );
            }
          } else if (!args.propertyId && existingDef) {
            const existingVariant = await c.prisma.sopVariant.findUnique({
              where: { sopDefinitionId_status: { sopDefinitionId: existingDef.id, status } },
              select: { id: true },
            });
            if (existingVariant) {
              span.end({ error: 'VARIANT_EXISTS', dryRun: true });
              return asError(
                `create_sop: a global variant for category "${args.sopCategory}" status ${status} already exists (${existingVariant.id}). Use search_replace or propose_suggestion to modify it, or pass a different status.`
              );
            }
          }
          const previewPayload = {
            tenantId: c.tenantId,
            sopCategory: args.sopCategory,
            status,
            propertyId: args.propertyId ?? null,
            title: titleLine,
            body: args.body,
            triggers: args.triggers ?? [],
            toolDescription,
            kind: args.propertyId ? ('override' as const) : ('variant' as const),
            buildTransactionId: args.transactionId ?? null,
          };
          const out = {
            ok: true,
            dryRun: true,
            artifactType: 'sop' as const,
            preview: previewPayload,
            rationale,
            diff: {
              kind: 'create' as const,
              sopCategory: args.sopCategory,
              status,
              scope: args.propertyId ? 'override' : 'variant',
              titlePreview: titleLine.slice(0, 80),
            },
          };
          span.end({ dryRun: true, ok: true });
          return asCallToolResult(out);
        }

        // Reuse-or-create SopDefinition under @@unique(tenantId, category).
        const definition = await c.prisma.sopDefinition.upsert({
          where: { tenantId_category: { tenantId: c.tenantId, category: args.sopCategory } },
          update: {},
          create: {
            tenantId: c.tenantId,
            category: args.sopCategory,
            toolDescription,
            enabled: true,
          },
          select: { id: true, category: true },
        });

        if (args.propertyId) {
          // SopPropertyOverride path — duplicate-safe via @@unique check.
          const existing = await c.prisma.sopPropertyOverride.findUnique({
            where: {
              sopDefinitionId_propertyId_status: {
                sopDefinitionId: definition.id,
                propertyId: args.propertyId,
                status,
              },
            },
            select: { id: true },
          });
          if (existing) {
            span.end({ error: 'OVERRIDE_EXISTS' });
            return asError(
              `create_sop: a property override for category "${args.sopCategory}" status ${status} on this property already exists (${existing.id}). Use search_replace or propose_suggestion to modify it.`
            );
          }
          const override = await c.prisma.sopPropertyOverride.create({
            data: {
              sopDefinitionId: definition.id,
              propertyId: args.propertyId,
              status,
              content: args.body,
              enabled: true,
              buildTransactionId: args.transactionId ?? null,
            },
            select: { id: true },
          });
          invalidateSopCache(c.tenantId);
          await finalizeBuildTransactionIfComplete(
            c.prisma,
            c.tenantId,
            args.transactionId
          );
          // D2 — observational history row (override branch).
          const emission = await emitArtifactHistory(c.prisma, {
            tenantId: c.tenantId,
            artifactType: 'property_override',
            artifactId: override.id,
            operation: 'CREATE',
            newBody: {
              sopCategory: definition.category,
              status,
              propertyId: args.propertyId,
              content: args.body,
              title: titleLine,
            },
            actorUserId: c.userId,
            actorEmail: c.actorEmail ?? null,
            conversationId: c.conversationId,
            metadata: {
              rationale,
              sopDefinitionId: definition.id,
              ...(args.transactionId ? { buildTransactionId: args.transactionId } : {}),
            },
          });
          // 054-A F3 — open verification ritual tied to this history row.
          openRitualWindow(c, emission.historyId, {
            artifactType: 'property_override',
            artifactId: override.id,
            operation: 'CREATE',
          });
          const previewUrl = `/sops/${definition.id}/override/${override.id}`;
          const payload = {
            ok: true,
            sopId: definition.id,
            sopCategory: definition.category,
            variantId: override.id,
            kind: 'override' as const,
            status,
            propertyId: args.propertyId,
            previewUrl,
            transactionId: args.transactionId ?? null,
          };
          if (c.emitDataPart) {
            c.emitDataPart({
              type: 'data-sop-created',
              id: `sop:${override.id}`,
              data: {
                ...payload,
                title: titleLine,
                body: args.body,
                triggers: args.triggers ?? [],
                createdAt: new Date().toISOString(),
              },
            });
          }
          span.end(payload);
          return asCallToolResult(payload);
        }

        // Global SopVariant path.
        const existingVariant = await c.prisma.sopVariant.findUnique({
          where: {
            sopDefinitionId_status: { sopDefinitionId: definition.id, status },
          },
          select: { id: true },
        });
        if (existingVariant) {
          span.end({ error: 'VARIANT_EXISTS' });
          return asError(
            `create_sop: a global variant for category "${args.sopCategory}" status ${status} already exists (${existingVariant.id}). Use search_replace or propose_suggestion to modify it, or pass a different status.`
          );
        }
        const variant = await c.prisma.sopVariant.create({
          data: {
            sopDefinitionId: definition.id,
            status,
            content: args.body,
            enabled: true,
            buildTransactionId: args.transactionId ?? null,
          },
          select: { id: true },
        });
        invalidateSopCache(c.tenantId);
        await finalizeBuildTransactionIfComplete(
          c.prisma,
          c.tenantId,
          args.transactionId
        );
        // D2 — observational history row (variant branch).
        const emission = await emitArtifactHistory(c.prisma, {
          tenantId: c.tenantId,
          artifactType: 'sop',
          artifactId: variant.id,
          operation: 'CREATE',
          newBody: {
            sopCategory: definition.category,
            status,
            content: args.body,
            title: titleLine,
          },
          actorUserId: c.userId,
          actorEmail: c.actorEmail ?? null,
          conversationId: c.conversationId,
          metadata: {
            rationale,
            sopDefinitionId: definition.id,
            ...(args.transactionId ? { buildTransactionId: args.transactionId } : {}),
          },
        });
        // 054-A F3 — open verification ritual tied to this history row.
        openRitualWindow(c, emission.historyId, {
          artifactType: 'sop',
          artifactId: variant.id,
          operation: 'CREATE',
        });
        const previewUrl = `/sops/${definition.id}/variant/${variant.id}`;
        const payload = {
          ok: true,
          sopId: definition.id,
          sopCategory: definition.category,
          variantId: variant.id,
          kind: 'variant' as const,
          status,
          previewUrl,
          transactionId: args.transactionId ?? null,
        };
        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-sop-created',
            id: `sop:${variant.id}`,
            data: {
              ...payload,
              title: titleLine,
              body: args.body,
              triggers: args.triggers ?? [],
              createdAt: new Date().toISOString(),
            },
          });
        }
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Bugfix (2026-04-22): handle benign P2002 BEFORE marking the
        // transaction PARTIAL — duplicate-create is not a plan-integrity
        // failure. Same pattern as create_faq.ts.
        if (err?.code === 'P2002') {
          span.end({ error: 'UNIQUE_CONSTRAINT' });
          return asError(
            `create_sop: a unique-constraint collision occurred. Another SOP with the same (category, status, property) tuple exists — edit it rather than recreate.`
          );
        }
        await markBuildTransactionPartial(c.prisma, c.tenantId, args.transactionId, {
          failedTool: 'create_sop',
          message: msg,
        });
        span.end({ error: String(err) });
        return asError(`create_sop failed: ${msg}`);
      }
    }
  );
}

function summariseFirstLine(body: string): string {
  const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return firstLine.trim().slice(0, 200);
}
