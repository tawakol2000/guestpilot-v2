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
    "Durable tenant-scoped memory for the agent. Ops: 'view' reads a key; 'list' lists keys by prefix (preferences/, facts/, decisions/, rejections/); 'create' writes a new key (fails if exists); 'update' upserts; 'delete' removes. Keep values small and structured. Use preferences/ for durable rules, decisions/ for stamped choices, facts/ for learned tenant context.",
    {
      op: z.enum(['view', 'list', 'create', 'update', 'delete']),
      key: z.string().min(1).max(200).optional(),
      prefix: z.string().min(1).max(200).optional(),
      value: z.any().optional(),
      source: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('tuning-agent.memory', { op: args.op, key: args.key, prefix: args.prefix });
      try {
        switch (args.op) {
          case 'view': {
            if (!args.key) return asError('memory.view requires key.');
            const rec = await viewMemory(c.prisma, c.tenantId, args.key);
            const payload = { key: args.key, record: rec };
            span.end(payload);
            return asCallToolResult(payload);
          }
          case 'list': {
            const prefix = args.prefix ?? 'preferences/';
            const rows = await listMemoryByPrefix(c.prisma, c.tenantId, prefix, args.limit ?? 30);
            const payload = { prefix, count: rows.length, records: rows };
            span.end(payload);
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
