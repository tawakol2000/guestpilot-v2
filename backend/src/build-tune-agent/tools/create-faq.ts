/**
 * create_faq — write a new FaqEntry (global or property-scoped).
 *
 * BUILD-mode tool. Optional transactionId links the write to an approved
 * plan_build_changes transaction, enabling plan-level rollback.
 *
 * The FaqEntry schema does not currently persist `triggers`; we accept the
 * param for forward compatibility and echo it in the data-faq-created part
 * so the UI can render it, but v1 does not write it to the DB. (Sprint 046
 * may add a triggers column if demand materialises.)
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { FAQ_CATEGORIES } from '../../config/faq-categories';
import { startAiSpan } from '../../services/observability.service';
import {
  finalizeBuildTransactionIfComplete,
  markBuildTransactionPartial,
  validateBuildTransaction,
} from './build-transaction';
import { asCallToolResult, asError, type ToolContext } from './types';

// The spec §11 tool description is load-bearing for dispatch. WHEN TO USE
// / WHEN NOT TO USE text copied verbatim.
const DESCRIPTION = `create_faq: Create a new FAQ entry in the tenant's knowledge base.
WHEN TO USE: In BUILD mode, when the manager surfaces a factual piece of information guests ask about (wifi password shape, parking arrangement, check-in instructions, amenity specifics). Also callable in TUNE mode via allowed_tools for FAQ-gap corrections. In TUNE mode this competes with propose_suggestion(category='FAQ') — prefer propose_suggestion if the FAQ already exists and needs editing; use create_faq only for net new entries.
WHEN NOT TO USE: Do NOT use for policy statements (use create_sop). Do NOT use for information that belongs in the system prompt (use write_system_prompt or propose_suggestion).
PARAMETERS:
  category (string, FAQ taxonomy from config/faq-categories.ts)
  question (string, the canonical form of the guest's question)
  answer (string, ≤400 tokens)
  propertyId (string, optional) — null for global, set for property-scoped
  triggers (array of strings, optional)
  transactionId (string, optional)
RETURNS: { faqEntryId, version, previewUrl }`;

export function buildCreateFaqTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'create_faq',
    DESCRIPTION,
    {
      category: z.enum(FAQ_CATEGORIES as unknown as [string, ...string[]]),
      question: z.string().min(3).max(500),
      answer: z.string().min(1).max(4000),
      propertyId: z.string().optional(),
      triggers: z.array(z.string().min(1).max(200)).max(20).optional(),
      transactionId: z.string().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.create_faq', {
        category: args.category,
        hasProperty: Boolean(args.propertyId),
        transactionId: args.transactionId ?? null,
      });
      try {
        const txCheck = await validateBuildTransaction(
          c.prisma,
          c.tenantId,
          args.transactionId
        );
        if (!txCheck.ok) {
          span.end({ error: 'TX_INVALID' });
          return asError(txCheck.error);
        }

        // If propertyId is set, confirm it belongs to this tenant.
        if (args.propertyId) {
          const prop = await c.prisma.property.findFirst({
            where: { id: args.propertyId, tenantId: c.tenantId },
            select: { id: true },
          });
          if (!prop) {
            span.end({ error: 'PROPERTY_NOT_FOUND' });
            return asError(
              `create_faq: property ${args.propertyId} not found for this tenant.`
            );
          }
        }

        const scope = args.propertyId ? 'PROPERTY' : 'GLOBAL';
        const created = await c.prisma.faqEntry.create({
          data: {
            tenantId: c.tenantId,
            propertyId: args.propertyId ?? null,
            question: args.question.trim(),
            answer: args.answer.trim(),
            category: args.category,
            scope: scope as any,
            status: 'ACTIVE',
            source: 'MANUAL',
            buildTransactionId: args.transactionId ?? null,
          },
          select: { id: true },
        });

        await finalizeBuildTransactionIfComplete(
          c.prisma,
          c.tenantId,
          args.transactionId
        );
        const previewUrl = `/faqs/${created.id}`;
        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-faq-created',
            id: `faq:${created.id}`,
            data: {
              faqEntryId: created.id,
              category: args.category,
              question: args.question.trim(),
              answer: args.answer.trim(),
              scope,
              propertyId: args.propertyId ?? null,
              triggers: args.triggers ?? [],
              transactionId: args.transactionId ?? null,
              previewUrl,
              createdAt: new Date().toISOString(),
            },
          });
        }

        const payload = {
          ok: true,
          faqEntryId: created.id,
          scope,
          previewUrl,
          transactionId: args.transactionId ?? null,
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        await markBuildTransactionPartial(c.prisma, c.tenantId, args.transactionId, {
          failedTool: 'create_faq',
          message: msg,
        });
        // Surface unique-constraint collision in a readable form.
        if (err?.code === 'P2002') {
          span.end({ error: 'UNIQUE_CONSTRAINT' });
          return asError(
            `create_faq: an FAQ with this question already exists for this scope (tenant/property). Edit the existing entry via propose_suggestion(category='FAQ') instead of creating a duplicate.`
          );
        }
        span.end({ error: String(err) });
        return asError(`create_faq failed: ${msg}`);
      }
    }
  );
}
