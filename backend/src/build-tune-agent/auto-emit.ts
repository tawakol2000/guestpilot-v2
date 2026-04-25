/**
 * Sprint 060-D Phase 6 — runtime auto-emit for session-summary +
 * interview-progress.
 *
 * Replaces the `emit_session_summary` and `emit_interview_progress`
 * tools. The runtime tracks tool activity during the turn and observes
 * the `session/{conversationId}/slot/*` memory delta; at turn end it
 * emits the cards itself, removing mechanical model attention for two
 * cards the runtime can compute deterministically.
 *
 * Cards continue to flow as `data-session-diff-summary` and
 * `data-interview-progress` SSE parts — the frontend renderer is
 * unchanged.
 */
import type { PrismaClient } from '@prisma/client';
import { DATA_PART_TYPES, type InterviewProgressData } from './data-parts';
import {
  ALL_SLOT_KEYS,
  LOAD_BEARING_SET,
} from '../services/tenant-state.service';
import { listMemoryByPrefix } from './memory/service';

/** SSE part type literal — frontend keys off this. */
export const SESSION_DIFF_SUMMARY_PART_TYPE = 'data-session-diff-summary';
const DEFAULT_MARKER = '<!-- DEFAULT: change me -->';

export interface SessionDiffSummaryData {
  written: { created: number; edited: number; reverted: number };
  tested: { runs: number; totalVariants: number; passed: number };
  plans: { cancelled: number };
  note: string | null;
}

/**
 * Tally tool calls invoked during the turn. Buckets are intentionally
 * coarse — we count by tool name, not outcome, so the implementation
 * stays decoupled from each tool's success/error shape. Renderer copes
 * with subsets (per the original tool's contract).
 *
 * Note: `studio_suggestion` calls (any op) count as a single edited
 * action; without observing inputs we can't distinguish propose vs
 * apply. The renderer treats `edited >= 1` as "the agent surfaced a
 * suggestion this turn" which is the operator-facing meaning.
 */
export function buildSessionDiffSummary(
  toolCallsInvoked: string[],
): SessionDiffSummaryData {
  let created = 0;
  let edited = 0;
  let reverted = 0;
  let testRuns = 0;
  for (const raw of toolCallsInvoked) {
    const name = stripMcpPrefix(raw);
    if (
      name === 'studio_create_sop' ||
      name === 'studio_create_faq' ||
      name === 'studio_create_tool_definition' ||
      name === 'studio_create_system_prompt'
    ) {
      created += 1;
    } else if (name === 'studio_suggestion') {
      edited += 1;
    } else if (name === 'studio_rollback') {
      reverted += 1;
    } else if (name === 'studio_test_pipeline') {
      testRuns += 1;
    }
  }
  return {
    written: { created, edited, reverted },
    tested: { runs: testRuns, totalVariants: 0, passed: 0 },
    plans: { cancelled: 0 },
    note: null,
  };
}

/** True when at least one tracked tool fired (controls whether to emit). */
export function hasTurnActivity(summary: SessionDiffSummaryData): boolean {
  const w = summary.written;
  return (
    w.created > 0 ||
    w.edited > 0 ||
    w.reverted > 0 ||
    summary.tested.runs > 0 ||
    summary.plans.cancelled > 0
  );
}

/**
 * Emit the session-diff-summary card if any tracked tool fired this turn.
 * Pure-conversation turns (no tool activity) emit nothing.
 */
export function maybeEmitSessionDiffSummary(args: {
  toolCallsInvoked: string[];
  emitDataPart: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void;
  assistantMessageId: string;
}): SessionDiffSummaryData | null {
  const summary = buildSessionDiffSummary(args.toolCallsInvoked);
  if (!hasTurnActivity(summary)) return null;
  args.emitDataPart({
    type: SESSION_DIFF_SUMMARY_PART_TYPE,
    id: `session-summary:${args.assistantMessageId}`,
    data: summary,
  });
  return summary;
}

/** Snapshot of slot keys + values prior to the turn — used to detect delta. */
export type SlotSnapshot = Record<string, string>;

export async function snapshotSlots(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
): Promise<SlotSnapshot> {
  const prefix = `session/${conversationId}/slot/`;
  const rows = await listMemoryByPrefix(prisma, tenantId, prefix, 50);
  const out: SlotSnapshot = {};
  for (const row of rows) {
    const key = row.key.slice(prefix.length);
    if (!ALL_SLOT_KEYS.has(key)) continue;
    out[key] = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  }
  return out;
}

/** True when post-turn slot snapshot differs from pre-turn snapshot. */
export function snapshotsDiffer(before: SlotSnapshot, after: SlotSnapshot): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (before[k] !== after[k]) return true;
  }
  return false;
}

const SLOT_LABELS: Record<string, string> = {
  property_identity: 'Property identity',
  checkin_time: 'Check-in time',
  checkout_time: 'Check-out time',
  escalation_contact: 'Escalation contact',
  payment_policy: 'Payment policy',
  brand_voice: 'Brand voice',
  cleaning_policy: 'Cleaning policy',
  amenities_list: 'Amenities',
  local_recommendations: 'Local recommendations',
  emergency_contact: 'Emergency contact',
  noise_policy: 'Noise policy',
  pet_policy: 'Pet policy',
  smoking_policy: 'Smoking policy',
  max_occupancy: 'Max occupancy',
  id_verification: 'ID verification',
  long_stay_discount: 'Long-stay discount',
  cancellation_policy: 'Cancellation policy',
  channel_coverage: 'Channel coverage',
  timezone: 'Timezone',
  ai_autonomy: 'AI autonomy',
};

export function buildInterviewProgressData(
  snapshot: SlotSnapshot,
  title: string,
): InterviewProgressData {
  const slots = Array.from(ALL_SLOT_KEYS).map((slotKey) => {
    const raw = snapshot[slotKey];
    const filled = typeof raw === 'string' && raw.length > 0;
    const status: InterviewProgressData['slots'][number]['status'] = filled
      ? 'filled'
      : 'pending';
    const answer =
      filled && typeof raw === 'string'
        ? raw.includes(DEFAULT_MARKER)
          ? '(default)'
          : raw.length > 80
            ? `${raw.slice(0, 77)}…`
            : raw
        : undefined;
    return {
      id: slotKey,
      label: SLOT_LABELS[slotKey] ?? slotKey,
      status,
      answer,
      loadBearing: LOAD_BEARING_SET.has(slotKey),
    };
  });
  return { title, slots };
}

/**
 * Emit interview-progress on BUILD turns where the slot snapshot changed
 * since the prior turn. TUNE turns and BUILD turns with no slot delta
 * emit nothing.
 */
export async function maybeEmitInterviewProgress(args: {
  prisma: PrismaClient;
  tenantId: string;
  conversationId: string;
  mode: 'BUILD' | 'TUNE';
  beforeSnapshot: SlotSnapshot;
  emitDataPart: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void;
  assistantMessageId: string;
}): Promise<InterviewProgressData | null> {
  if (args.mode !== 'BUILD') return null;
  const after = await snapshotSlots(args.prisma, args.tenantId, args.conversationId);
  if (!snapshotsDiffer(args.beforeSnapshot, after)) return null;
  const data = buildInterviewProgressData(after, 'Interview progress');
  args.emitDataPart({
    type: DATA_PART_TYPES.interview_progress,
    id: `interview-progress:${args.assistantMessageId}`,
    data,
  });
  return data;
}

function stripMcpPrefix(toolName: string): string {
  const m = toolName.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
  if (m) return m[1];
  // Tool names in toolCallsInvoked may already be unprefixed (the SDK
  // path pushes block.name which is the raw MCP-prefixed name; the
  // direct path may push unprefixed names). Handle both.
  const idx = toolName.lastIndexOf('__');
  return idx >= 0 ? toolName.slice(idx + 2) : toolName;
}
