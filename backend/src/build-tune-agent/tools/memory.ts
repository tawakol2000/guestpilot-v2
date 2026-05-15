/**
 * memory — durable tenant memory tool. Passthrough to our AgentMemory-backed
 * service. Mirrors the shape of Anthropic's `memory_20250818` primitive but
 * lives in our tool layer because the Claude Agent SDK v0.2.109 does not
 * expose `memory_20250818` as a first-class SDK tool.
 *
 * Commands: view, create, update, delete. Tenant-scoped. Keys follow the
 * namespacing convention in memory/README.md (`preferences/*`, `facts/*`,
 * `decisions/*`, `rejections/*`).
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  viewMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  listMemoryByPrefix,
} from '../memory/service';
import { asCallToolResult, asError, type ToolContext } from './types';

export function buildMemoryTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'studio_memory',
    "Durable tenant-scoped memory for the agent. Ops: 'view' reads a key; 'list' lists keys by prefix (preferences/, facts/, decisions/, rejections/); 'create' writes a new key (fails if exists); 'update' upserts; 'delete' removes. Keep values small and structured. Use preferences/ for durable rules, decisions/ for stamped choices, facts/ for learned tenant context. verbosity: 'concise' (default) on view returns key + truncated value; 'detailed' returns the full value verbatim. " +
    "KEY NAMING. The key is surfaced in <memory_snapshot> on every future turn next to a 280-char value summary; pick a key that telegraphs the directive, not just the topic, so the agent recognises the rule even before reading the value. Use kebab-case after the namespace prefix and embed the verb when the rule is a constraint. Good: preferences/no-sop-for-screening, preferences/concise-sop-tone, preferences/escalate-late-checkin-after-23h. Bad: preferences/screening (topic only), preferences/note-1 (semantically empty), preferences/rule (collides instantly). For decisions/, stamp the date: decisions/2026-05-03-parking-override. For facts/, name what the fact asserts: facts/luxury-properties, facts/arabic-guests-common. NEVER reuse a key for an unrelated rule — create a new one.",
    {
      op: z.enum(['view', 'list', 'create', 'update', 'delete']),
      key: z.string().min(1).max(200).optional(),
      prefix: z.string().min(1).max(200).optional(),
      value: z.any().optional(),
      source: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      verbosity: z.enum(['concise', 'detailed']).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.memory', { op: args.op, key: args.key, prefix: args.prefix });
      // 2026-05-15: cap value size at 8000 chars on write ops. Without this
      // an agent can write a 1MB blob and it'd land in <memory_snapshot>
      // on every future turn. We also apply this to the truncated list/view
      // rendering below to keep output deterministic.
      const isWriteOp = args.op === 'create' || args.op === 'update';
      if (isWriteOp && args.value !== undefined) {
        const asStr =
          typeof args.value === 'string' ? args.value : JSON.stringify(args.value);
        if (asStr.length > 8000) {
          return asError(
            `memory.${args.op}: value too large (${asStr.length} chars; max 8000). Split into multiple keys or summarise.`,
          );
        }
      }
      // 2026-05-15: harness parity — never mutate AgentMemory under
      // STUDIO_HARNESS_DRY_RUN. Return a synthetic ok payload so the agent's
      // downstream flow exercises end-to-end without leaking rows.
      if (
        process.env.STUDIO_HARNESS_DRY_RUN === 'true' &&
        (args.op === 'create' || args.op === 'update' || args.op === 'delete')
      ) {
        const payload = {
          ok: true,
          dryRun: true,
          op: args.op,
          key: args.key,
        };
        span.end(payload);
        return asCallToolResult(payload);
      }
      try {
        switch (args.op) {
          case 'view': {
            if (!args.key) return asError('memory.view requires key.');
            const rec = await viewMemory(c.prisma, c.tenantId, args.key);
            const detailed = args.verbosity === 'detailed';
            const truncated =
              !detailed && rec && typeof (rec as any).value === 'string'
                ? {
                    ...rec,
                    value:
                      ((rec as any).value as string).length > 200
                        ? `${((rec as any).value as string).slice(0, 200)}…`
                        : (rec as any).value,
                  }
                : rec;
            const payload = { key: args.key, record: truncated };
            span.end({ key: args.key, detailed });
            return asCallToolResult(payload);
          }
          case 'list': {
            const prefix = args.prefix ?? 'preferences/';
            const rows = await listMemoryByPrefix(c.prisma, c.tenantId, prefix, args.limit ?? 30);
            // 2026-05-15: truncate each value to 280 chars by default
            // (matches <memory_snapshot> rendering). detailed verbosity
            // returns full values verbatim for an audit-style read.
            const detailed = args.verbosity === 'detailed';
            const truncatedRows = detailed
              ? rows
              : rows.map((r: any) => {
                  const v = r?.value;
                  if (typeof v === 'string' && v.length > 280) {
                    return { ...r, value: `${v.slice(0, 280)}…` };
                  }
                  if (v && typeof v === 'object') {
                    const j = JSON.stringify(v);
                    if (j.length > 280) {
                      return { ...r, value: `${j.slice(0, 280)}…` };
                    }
                  }
                  return r;
                });
            const payload = { prefix, count: rows.length, records: truncatedRows };
            span.end({ prefix, count: rows.length, detailed });
            return asCallToolResult(payload);
          }
          case 'create': {
            if (!args.key) return asError('memory.create requires key.');
            if (args.value === undefined) return asError('memory.create requires value.');
            const r = await createMemory(c.prisma, c.tenantId, args.key, args.value, args.source);
            if (!r.ok) {
              span.end({ error: r.error });
              return asError(
                `memory.create: key '${args.key}' already exists. Use op:'update' to overwrite.`
              );
            }
            const payload = { ok: true, key: args.key };
            span.end(payload);
            return asCallToolResult(payload);
          }
          case 'update': {
            if (!args.key) return asError('memory.update requires key.');
            if (args.value === undefined) return asError('memory.update requires value.');
            const rec = await updateMemory(c.prisma, c.tenantId, args.key, args.value, args.source);
            const payload = { ok: true, record: rec };
            span.end(payload);
            return asCallToolResult(payload);
          }
          case 'delete': {
            if (!args.key) return asError('memory.delete requires key.');
            const r = await deleteMemory(c.prisma, c.tenantId, args.key);
            const payload = { ok: true, deleted: r.deleted, key: args.key };
            span.end(payload);
            return asCallToolResult(payload);
          }
          default:
            return asError(`memory: unsupported op ${args.op}`);
        }
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`memory failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
