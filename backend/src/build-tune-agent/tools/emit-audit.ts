/**
 * emit_audit — sprint 046 Session B, plan §5.4.
 *
 * Thin wrapper around `emitDataPart` so the agent is forced to commit to
 * a card-shaped payload (`data-audit-report`) when surfacing the result
 * of a "review my setup" triage pass. Per the mode triage rules: one
 * row per artifact checked (not one row per finding), and exactly one
 * top-finding id that pairs with a follow-up suggested_fix card.
 *
 * Mode: both. No DB write.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  DATA_PART_TYPES,
  type AuditReportData,
  type AuditReportRow,
} from '../data-parts';
import { asCallToolResult, asError, type ToolContext } from './types';

const DESCRIPTION = `Surface the result of a review/audit pass as a compact audit-report card. Emits a data-audit-report structured part. Use AFTER a single get_current_state(scope:'all') call when the manager asks "review my setup" / "audit" / "what should I fix". Rules: (a) exactly one row per artifact TYPE checked, not one row per finding; (b) status must be one of ok|warn|gap|danger|unknown; (c) topFindingId pairs with the single suggested_fix card the triage rules require you to emit next; set to null only when the audit finds zero fixes worth proposing. Does NOT write to the database. Callable in both BUILD and TUNE modes.`;

const rowSchema = z.object({
  artifact: z.enum(['system_prompt', 'sop', 'faq', 'tool_definition', 'property']),
  artifactId: z.string().optional(),
  label: z.string().min(1).max(120),
  status: z.enum(['ok', 'warn', 'gap', 'danger', 'unknown']),
  note: z.string().min(1).max(300),
  findingId: z.string().optional(),
});

export function buildEmitAuditTool(tool: typeof ToolFactory, ctx: () => ToolContext) {
  return tool(
    'emit_audit',
    DESCRIPTION,
    {
      rows: z.array(rowSchema).min(1).max(12),
      topFindingId: z.string().nullable(),
      summary: z.string().max(200).optional(),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.emit_audit', {
        rowCount: args.rows.length,
        hasTopFinding: args.topFindingId !== null,
      });
      try {
        // topFindingId must reference a row's findingId when set.
        if (args.topFindingId !== null) {
          const idx = args.rows.findIndex((r) => r.findingId === args.topFindingId);
          if (idx < 0) {
            return asError(
              `emit_audit: topFindingId '${args.topFindingId}' does not match any row.findingId.`
            );
          }
        }

        const rows: AuditReportRow[] = args.rows.map((r) => ({
          artifact: r.artifact,
          artifactId: r.artifactId,
          label: r.label,
          status: r.status,
          note: r.note,
          findingId: r.findingId,
        }));

        const data: AuditReportData = {
          rows,
          topFindingId: args.topFindingId,
          summary: args.summary,
        };
        const id = `audit:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        if (c.emitDataPart) {
          c.emitDataPart({
            type: DATA_PART_TYPES.audit_report,
            id,
            data,
          });
        }
        const payload = {
          ok: true,
          auditId: id,
          rowsEmitted: rows.length,
          topFindingId: args.topFindingId,
          hint:
            args.topFindingId !== null
              ? 'Follow up with ONE suggested_fix card targeting the top finding; do not enumerate the rest.'
              : 'Audit found no fixes worth proposing. End the turn here — do not emit a suggested_fix.',
        };
        span.end(payload);
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`emit_audit failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
