/**
 * fetch_evidence_bundle — pull an EvidenceBundle row by id, or assemble one
 * on-demand for a given messageId. Uses sprint-01's assembleEvidenceBundle.
 *
 * Emits a `data-evidence-inline` transient-ish client part so the chat panel
 * can show a compact summary inline with the agent's reply.
 */
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { assembleEvidenceBundle } from '../../services/evidence-bundle.service';
import { asCallToolResult, asError, type ToolContext } from './types';

function clip(val: unknown, max: number): unknown {
  if (typeof val === 'string') return val.length > max ? val.slice(0, max) + `…(+${val.length - max})` : val;
  if (Array.isArray(val)) return val.map((v) => clip(v, max));
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = clip(v, max);
    }
    return out;
  }
  return val;
}

export function buildFetchEvidenceBundleTool(ctx: () => ToolContext) {
  return tool(
    'fetch_evidence_bundle',
    "Fetch the main AI's evidence bundle for a triggering message. Provide either bundleId (prefer) or messageId (on-demand assembly). The bundle has disputed message, 20-message context, Hostaway entity metadata, main-AI ragContext, SOPs in effect, and Langfuse trace if available. Concise returns summary keys; detailed returns the full payload (capped at ~16kb).",
    {
      bundleId: z.string().optional(),
      messageId: z.string().optional(),
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.fetch_evidence_bundle', args);
      try {
        if (!args.bundleId && !args.messageId) {
          span.end({ error: 'NEITHER_ID' });
          return asError('fetch_evidence_bundle requires either bundleId or messageId.');
        }
        let bundlePayload: any;
        let bundleId = args.bundleId ?? null;

        if (args.bundleId) {
          const row = await c.prisma.evidenceBundle.findFirst({
            where: { id: args.bundleId, tenantId: c.tenantId },
          });
          if (!row) {
            span.end({ error: 'NOT_FOUND' });
            return asError(`EvidenceBundle ${args.bundleId} not found for tenant.`);
          }
          bundlePayload = row.payload;
        } else if (args.messageId) {
          const message = await c.prisma.message.findFirst({
            where: { id: args.messageId, tenantId: c.tenantId },
            select: { id: true },
          });
          if (!message) {
            span.end({ error: 'MESSAGE_NOT_FOUND' });
            return asError(`Message ${args.messageId} not found for tenant.`);
          }
          bundlePayload = await assembleEvidenceBundle(
            {
              tenantId: c.tenantId,
              messageId: message.id,
              triggerType: 'MANUAL',
              note: 'tuning-agent on-demand fetch',
            },
            c.prisma
          );
        }

        const detailed = args.verbosity === 'detailed';
        const rendered = detailed ? clip(bundlePayload, 4000) : clip(summarizeBundle(bundlePayload), 1200);

        // Emit a client-side part so the chat UI can render a curated preview.
        if (c.emitDataPart) {
          c.emitDataPart({
            type: 'data-evidence-inline',
            id: `evidence:${bundleId ?? args.messageId}`,
            data: summarizeBundle(bundlePayload),
          });
        }

        span.end({ bundleId, detailed });
        return asCallToolResult({ bundleId, bundle: rendered });
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`fetch_evidence_bundle failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}

/**
 * Compact summary of an evidence bundle suitable for both (a) concise LLM
 * return payload and (b) client-side `data-evidence-inline` rendering.
 */
function summarizeBundle(b: any): any {
  if (!b || typeof b !== 'object') return b;
  return {
    trigger: b.trigger ?? null,
    assembledAt: b.assembledAt,
    disputedMessage: b.disputedMessage
      ? {
          id: b.disputedMessage.id,
          role: b.disputedMessage.role,
          contentExcerpt: (b.disputedMessage.content ?? '').slice(0, 400),
          originalAiText: b.disputedMessage.originalAiText
            ? (b.disputedMessage.originalAiText as string).slice(0, 400)
            : null,
          editedByUserId: b.disputedMessage.editedByUserId,
          sentAt: b.disputedMessage.sentAt,
          channel: b.disputedMessage.channel,
        }
      : null,
    conversationSnippet: b.conversationContext?.messages
      ? b.conversationContext.messages.slice(-5).map((m: any) => ({
          id: m.id,
          role: m.role,
          excerpt: (m.content ?? '').slice(0, 180),
          sentAt: m.sentAt,
        }))
      : [],
    hostaway: b.entities
      ? {
          propertyName: b.entities.property?.name ?? null,
          propertyId: b.entities.property?.id ?? null,
          reservationStatus: b.entities.reservation?.status ?? null,
          reservationChannel: b.entities.reservation?.channel ?? null,
        }
      : null,
    mainAiTrace: b.mainAiTrace
      ? {
          model: b.mainAiTrace.model ?? null,
          tokens: b.mainAiTrace.tokens ?? null,
          costUsd: b.mainAiTrace.costUsd ?? null,
          classifier: b.mainAiTrace.ragContext?.classifier ?? null,
        }
      : null,
    sopsInEffect: Array.isArray(b.sopsInEffect)
      ? b.sopsInEffect.map((s: any) => ({
          category: s.category,
          status: s.status,
          hasOverride: Boolean(s.hasOverride),
        }))
      : [],
    branchTags: b.branchTags ?? [],
  };
}
