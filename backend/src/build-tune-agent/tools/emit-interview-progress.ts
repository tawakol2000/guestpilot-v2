/**
 * Sprint 046 — emit_interview_progress tool.
 *
 * Pure emitter: the agent passes a `title` + `slots[]` payload and the
 * tool streams a `data-interview-progress` part the Studio frontend
 * renders as an InterviewProgressCard. No DB reads, no side-effects —
 * the tool body just converts the agent's intent into a card.
 *
 * Agent invokes this mid-interview (greenfield onboarding, deep audit,
 * anything that spans multiple questions) to show the operator how
 * many load-bearing slots remain.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { DATA_PART_TYPES, type InterviewProgressData } from '../data-parts';
import { asCallToolResult, type ToolContext } from './types';

const SLOT_STATUS = ['pending', 'asking', 'filled', 'skipped'] as const;

export function buildEmitInterviewProgressTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'emit_interview_progress',
    'Show the operator a mid-interview progress card. Pass the interview title (e.g. "Greenfield onboarding") and the slot list with per-slot status. Slots flagged `loadBearing: true` render with a warn pill — these are the questions where skipping means the agent falls back to defaults. Emit whenever the slot-fill state changes so the operator can see where they stand without waiting for the next question.',
    {
      title: z.string().min(1).max(80),
      slots: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1).max(160),
          status: z.enum(SLOT_STATUS),
          answer: z.string().max(200).optional(),
          loadBearing: z.boolean().optional(),
        }),
      ).min(1).max(24),
    },
    async (args) => {
      const c = ctx();
      const data: InterviewProgressData = {
        title: args.title,
        slots: args.slots.map((s) => ({
          id: s.id,
          label: s.label,
          status: s.status,
          answer: s.answer,
          loadBearing: s.loadBearing,
        })),
      };
      c.emitDataPart?.({
        type: DATA_PART_TYPES.interview_progress,
        data,
      });
      return asCallToolResult({
        ok: true,
        emitted: DATA_PART_TYPES.interview_progress,
        slotCount: data.slots.length,
        filled: data.slots.filter((s) => s.status === 'filled').length,
      });
    },
  );
}
