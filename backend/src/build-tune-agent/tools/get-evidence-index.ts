/**
 * studio_get_evidence_index — sprint 060-D phase 7c.
 *
 * Replaces the broad-payload `fetch_evidence_bundle` call. Returns
 * metadata + per-section opaque pointers; bodies are fetched one at
 * a time via studio_get_evidence_section({pointer}).
 *
 * Sections (frozen API seam — names match spec § 4.7):
 *   - reply              the AI's disputed reply
 *   - sop_used           SOPs in effect at bundle time
 *   - reasoning_trace    main-AI trace + Langfuse data
 *   - tool_call(index)   one entry per tool call
 *   - classifier_detail  classifier decision + sop categories
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { assembleEvidenceBundle } from '../../services/evidence-bundle.service';
import { encodePointer } from './lib/pointer';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Return a metadata-only index of an evidence bundle. Provide either bundleId (preferred — looks up the persisted row) or messageId (assembles on demand). Each section carries an opaque section_pointer; resolve via studio_get_evidence_section({pointer}). Sections: reply, sop_used, reasoning_trace, tool_call({index}), classifier_detail.`;

interface ToolCallSummary {
  index: number;
  name: string;
  status: string;
  duration_ms: number | null;
}

export function buildGetEvidenceIndexTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_get_evidence_index',
    DESCRIPTION,
    {
      bundleId: z.string().optional(),
      messageId: z.string().optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_get_evidence_index', args);
      try {
        if (!args.bundleId && !args.messageId) {
          span.end({ error: 'NEITHER_ID' });
          return asError('studio_get_evidence_index requires either bundleId or messageId.');
        }
        const bundleId = await ensureBundleId(c, args);
        if (!bundleId.ok) return asError(bundleId.message);

        const tools = extractToolCallSummaries(bundleId.bundle);

        const ptr = (section: string, metadata?: Record<string, unknown>): string =>
          encodePointer({
            type: 'evidence',
            id: bundleId.bundleId,
            metadata: { section, ...(metadata ?? {}) },
          });

        const payload = {
          bundleId: bundleId.bundleId,
          assembledAt: bundleId.bundle?.assembledAt ?? null,
          reply: { available: !!bundleId.bundle?.disputedMessage, pointer: ptr('reply') },
          sop_used: {
            count: Array.isArray(bundleId.bundle?.sopsInEffect)
              ? bundleId.bundle.sopsInEffect.length
              : 0,
            pointer: ptr('sop_used'),
          },
          reasoning_trace: {
            available:
              !!bundleId.bundle?.mainAiTrace || !!bundleId.bundle?.langfuseTrace,
            pointer: ptr('reasoning_trace'),
          },
          tool_calls: tools.map((tc) => ({
            ...tc,
            pointer: ptr('tool_call', { toolIndex: tc.index }),
          })),
          classifier_detail: {
            available: !!bundleId.bundle?.mainAiTrace?.ragContext,
            pointer: ptr('classifier_detail'),
          },
          summary: bundleId.bundle?.entities
            ? {
                propertyName: bundleId.bundle.entities.property?.name ?? null,
                reservationStatus:
                  bundleId.bundle.entities.reservation?.status ?? null,
              }
            : null,
        };
        span.end({ bundleId: bundleId.bundleId, toolCalls: tools.length });
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_get_evidence_index failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}

interface ResolvedBundle {
  ok: true;
  bundleId: string;
  bundle: any;
}
interface ResolvedBundleErr {
  ok: false;
  message: string;
}

async function ensureBundleId(
  c: ToolContext,
  args: { bundleId?: string; messageId?: string },
): Promise<ResolvedBundle | ResolvedBundleErr> {
  if (args.bundleId) {
    const row = await c.prisma.evidenceBundle.findFirst({
      where: { id: args.bundleId, tenantId: c.tenantId },
    });
    if (!row) {
      return { ok: false, message: `EvidenceBundle ${args.bundleId} not found for tenant.` };
    }
    return { ok: true, bundleId: row.id, bundle: row.payload };
  }
  if (args.messageId) {
    const message = await c.prisma.message.findFirst({
      where: { id: args.messageId, tenantId: c.tenantId },
      select: { id: true },
    });
    if (!message) {
      return { ok: false, message: `Message ${args.messageId} not found for tenant.` };
    }
    const assembled = await assembleEvidenceBundle(
      {
        tenantId: c.tenantId,
        messageId: message.id,
        triggerType: 'MANUAL',
        note: 'tuning-agent on-demand index',
      },
      c.prisma,
    );
    // Persist a temporary row so studio_get_evidence_section can re-load
    // by id. Without this, the bundle would have to be carried in the
    // pointer payload (bloating the token) or re-assembled on every
    // section call (wasted DB work).
    const persisted = await c.prisma.evidenceBundle.create({
      data: {
        tenantId: c.tenantId,
        triggerType: 'MANUAL',
        messageId: message.id,
        payload: assembled as any,
      },
      select: { id: true },
    });
    return { ok: true, bundleId: persisted.id, bundle: assembled };
  }
  return { ok: false, message: 'no bundle id or message id supplied' };
}

function extractToolCallSummaries(bundle: any): ToolCallSummary[] {
  const out: ToolCallSummary[] = [];
  const trace = bundle?.mainAiTrace;
  // ai.service.ts attaches the per-call log to ragContext.tools as
  // Array<{name, input, results, durationMs}>. Older traces may also
  // populate ragContext.toolCalls; fall back for forward-compat.
  const calls = Array.isArray(trace?.ragContext?.tools)
    ? trace.ragContext.tools
    : Array.isArray(trace?.ragContext?.toolCalls)
      ? trace.ragContext.toolCalls
      : [];
  calls.forEach((call: any, i: number) => {
    const name =
      typeof call?.name === 'string'
        ? call.name
        : typeof call?.tool === 'string'
          ? call.tool
          : 'unknown';
    const duration =
      typeof call?.durationMs === 'number'
        ? call.durationMs
        : typeof call?.duration_ms === 'number'
          ? call.duration_ms
          : null;
    out.push({
      index: i,
      name,
      status: call?.error ? 'error' : 'ok',
      duration_ms: duration,
    });
  });
  return out;
}
