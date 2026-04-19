/**
 * Tenant-state service (sprint 045, Gate 5).
 *
 * Aggregates the per-tenant facts the BUILD-mode runtime needs to
 * populate `<tenant_state>` in the system prompt's dynamic suffix
 * (per spec §9 + §10), plus the in-session interview-progress widget
 * the BUILD agent uses to decide when to graduate to write_system_prompt.
 *
 * Lives in `backend/src/services/` (not in `build-tune-agent/`) because
 * it's called from `controllers/build-controller.ts` outside the agent
 * package — keeping it here avoids forcing controllers to import the
 * agent's MCP / SDK loader.
 *
 * Two read-only entry points:
 *   - getTenantStateSummary(tenantId)        → spec §9 TenantStateSummary
 *   - getInterviewProgressSummary(tenantId,  → spec §10 InterviewProgressSummary
 *                                 conversationId)
 *
 * Cache strategy: none. Both are tenant-scoped reads called once per
 * BUILD turn. Adding a cache layer here would risk staleness right after
 * write_system_prompt / create_* — exactly the moment the manager wants
 * to see the new state reflected. Cheap counts, fine to recompute.
 */
import type { PrismaClient } from '@prisma/client';
import { listMemoryByPrefix } from '../build-tune-agent/memory/service';

// Slot inventory mirrored from `tools/write-system-prompt.ts`. Kept in
// sync by `__tests__/template.test.ts` (slot-key alignment assertion)
// and by `tenant-state.service.test.ts` (count assertion below).
const LOAD_BEARING_SLOTS = [
  'property_identity',
  'checkin_time',
  'checkout_time',
  'escalation_contact',
  'payment_policy',
  'brand_voice',
] as const;

const NON_LOAD_BEARING_SLOTS = [
  'cleaning_policy',
  'amenities_list',
  'local_recommendations',
  'emergency_contact',
  'noise_policy',
  'pet_policy',
  'smoking_policy',
  'max_occupancy',
  'id_verification',
  'long_stay_discount',
  'cancellation_policy',
  'channel_coverage',
  'timezone',
  'ai_autonomy',
] as const;

export const ALL_SLOT_KEYS = new Set<string>([
  ...LOAD_BEARING_SLOTS,
  ...NON_LOAD_BEARING_SLOTS,
]);
export const LOAD_BEARING_SET = new Set<string>(LOAD_BEARING_SLOTS);
export const TOTAL_SLOTS = ALL_SLOT_KEYS.size;

const DEFAULT_MARKER = '<!-- DEFAULT: change me -->';

// ─── TenantStateSummary ────────────────────────────────────────────────────

export interface LastBuildTransactionSummary {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  itemCount: number;
}

/**
 * Spec §9 — wire shape consumed by `runTuningAgentTurn` to render the
 * BUILD-only `<tenant_state>` block, and by the frontend to render the
 * GREENFIELD/BROWNFIELD opening banner.
 *
 * `lastBuildTransaction` is omitted (not present) when the tenant has
 * never opened BUILD before — different from `null`, which would imply
 * "we looked and the field is empty." Per the session-4 brief.
 */
export interface TenantStateSummary {
  sopCount: number;
  faqCounts: { global: number; perProperty: number };
  customToolCount: number;
  propertyCount: number;
  isGreenfield: boolean;
  /** Present only when at least one BuildTransaction row exists. */
  lastBuildTransaction?: LastBuildTransactionSummary;
}

/**
 * Aggregate the tenant's current configuration into a TenantStateSummary.
 * Called once per `/api/build/turn` request (and on `/api/build/tenant-state`
 * for the page-load banner).
 *
 * GREENFIELD definition (spec §9, brief): no SOPs AND no global FAQs AND
 * no custom tools. Property-scoped FAQs alone do not disqualify because a
 * fresh Hostaway import seeds property-scoped knowledge from listing
 * descriptions; global knowledge is the human-curated signal.
 */
export async function getTenantStateSummary(
  prisma: PrismaClient,
  tenantId: string
): Promise<TenantStateSummary> {
  const [
    sopCount,
    faqGlobal,
    faqPerProperty,
    customToolCount,
    propertyCount,
    lastTx,
  ] = await Promise.all([
    prisma.sopDefinition.count({ where: { tenantId } }),
    prisma.faqEntry.count({ where: { tenantId, scope: 'GLOBAL' } }),
    prisma.faqEntry.count({ where: { tenantId, scope: 'PROPERTY' } }),
    prisma.toolDefinition.count({ where: { tenantId, type: 'custom' } }),
    prisma.property.count({ where: { tenantId } }),
    prisma.buildTransaction.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        completedAt: true,
        approvedAt: true,
        approvedByUserId: true,
        plannedItems: true,
      },
    }),
  ]);

  const isGreenfield = sopCount === 0 && faqGlobal === 0 && customToolCount === 0;

  const summary: TenantStateSummary = {
    sopCount,
    faqCounts: { global: faqGlobal, perProperty: faqPerProperty },
    customToolCount,
    propertyCount,
    isGreenfield,
  };

  if (lastTx) {
    const items = Array.isArray(lastTx.plannedItems)
      ? (lastTx.plannedItems as unknown[])
      : [];
    summary.lastBuildTransaction = {
      id: lastTx.id,
      status: lastTx.status,
      createdAt: lastTx.createdAt.toISOString(),
      completedAt: lastTx.completedAt ? lastTx.completedAt.toISOString() : null,
      approvedAt: lastTx.approvedAt ? lastTx.approvedAt.toISOString() : null,
      approvedByUserId: lastTx.approvedByUserId,
      itemCount: items.length,
    };
  }

  return summary;
}

// ─── InterviewProgressSummary ──────────────────────────────────────────────

export interface InterviewProgressSummary {
  filledSlots: string[];
  totalSlots: number;
  coveragePercent: number;
  loadBearingFilled: number;
}

/**
 * Read in-session slot fills from agent memory under
 * `session/{conversationId}/slot/{slotKey}`. The BUILD addendum (see
 * `system-prompt.ts`) instructs the agent to persist every confirmed
 * slot value there — this function derives the per-turn progress widget
 * from those entries.
 *
 * Counting rules:
 *   - A slot counts as "filled" when its memory value is a non-empty
 *     string AND does not contain the DEFAULT marker. Defaulted slots
 *     do not count toward graduation (parity with
 *     `write_system_prompt`'s coverage calculator).
 *   - Slots not in LOAD_BEARING + NON_LOAD_BEARING are silently ignored
 *     (defensive: future renames shouldn't crash the BUILD turn).
 *   - `coveragePercent` is rounded to the nearest integer.
 */
export async function getInterviewProgressSummary(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string
): Promise<InterviewProgressSummary> {
  const prefix = `session/${conversationId}/slot/`;
  // Cap at 50 — there are only 20 slots; any extras are ignored. Memory
  // ops are namespaced per tenant by `listMemoryByPrefix`.
  const rows = await listMemoryByPrefix(prisma, tenantId, prefix, 50);

  const filledSlots: string[] = [];
  let loadBearingFilled = 0;

  for (const row of rows) {
    const slotKey = row.key.slice(prefix.length);
    if (!ALL_SLOT_KEYS.has(slotKey)) continue;
    const raw = row.value;
    const stringValue =
      typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    if (!stringValue.trim()) continue;
    if (stringValue.includes(DEFAULT_MARKER)) continue;
    filledSlots.push(slotKey);
    if (LOAD_BEARING_SET.has(slotKey)) loadBearingFilled += 1;
  }

  const coveragePercent =
    TOTAL_SLOTS === 0 ? 0 : Math.round((filledSlots.length / TOTAL_SLOTS) * 100);

  return {
    filledSlots,
    totalSlots: TOTAL_SLOTS,
    coveragePercent,
    loadBearingFilled,
  };
}
