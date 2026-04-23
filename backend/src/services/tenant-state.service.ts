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
import { SEED_SOP_CONTENT } from './sop.service';
import { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT } from './ai.service';

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

/**
 * Decide whether a memory slot value counts as "filled" for
 * interview-progress purposes.
 *
 * Rules (post 2026-04-22 bugfix):
 *   - null / undefined → empty, NOT filled.
 *   - string, whitespace only → empty, NOT filled.
 *   - string containing the DEFAULT_MARKER sentinel → treated as
 *     still-default, NOT filled.
 *   - any non-empty structured JSON (object, array, number, boolean) →
 *     filled. The DEFAULT_MARKER sentinel is a TEXT-PROMPT convention;
 *     applying it to stringified JSON previously produced false positives
 *     when an operator stored e.g. `{"note": "<!-- DEFAULT: ... -->"}` as
 *     quoted documentation — the serialised form contained the sentinel
 *     even though the slot was genuinely configured.
 *   - trivially empty structured forms (`""`, `[]`, `{}`) are also NOT
 *     filled — operators sometimes persist placeholders which are
 *     indistinguishable from an unanswered slot.
 *
 * Exported for unit testing in isolation (pure function, no DB).
 */
export function isSlotValueFilled(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === 'string') {
    if (!raw.trim()) return false;
    if (raw.includes(DEFAULT_MARKER)) return false;
    return true;
  }
  // Non-string (number, boolean, object, array). Serialise only to detect
  // trivially-empty forms.
  let stringified: string;
  try {
    stringified = JSON.stringify(raw);
  } catch {
    // Non-serialisable (cyclic, BigInt). Treat as filled — operator
    // wrote SOMETHING, we just can't reason about it.
    return true;
  }
  if (!stringified || !stringified.trim()) return false;
  if (stringified === '""' || stringified === '[]' || stringified === '{}') return false;
  return true;
}

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
  /**
   * Of `sopCount`, how many still have their DEFAULT variant body
   * byte-for-byte matching the canonical seed in SEED_SOP_CONTENT —
   * i.e. the operator has never edited them. Derived client-side
   * (no schema field) by loading all DEFAULT variants and comparing
   * to the seed dictionary.
   */
  sopsDefaulted: number;
  faqCounts: { global: number; perProperty: number };
  customToolCount: number;
  propertyCount: number;
  isGreenfield: boolean;
  /**
   * Bugfix (2026-04-23): originally only lived on the agent's
   * <tenant_state> render path. The Studio right-rail "CURRENT STATE"
   * card reads the same `TenantStateSummary` shape via
   * `/api/build/tenant-state` + the `get_current_state(scope:'summary')`
   * tool — so keeping the field service-side ensures every consumer
   * reports the same truth.
   *
   *   EMPTY       — coordinator + screening both null/whitespace.
   *   DEFAULT     — coordinator matches SEED_COORDINATOR_PROMPT
   *                 verbatim (or startsWith it — the legacy migration
   *                 appends a template-variable block).
   *   CUSTOMISED  — coordinator diverges from the seed.
   */
  systemPromptStatus: 'EMPTY' | 'DEFAULT' | 'CUSTOMISED';
  /** TenantAiConfig.systemPromptVersion. 0 for fresh seed. */
  systemPromptEditCount: number;
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
    // Bugfix (2026-04-23): count SOPs still on seed content so the
    // BUILD agent's <tenant_state> can report a real number instead
    // of the hard-coded 0. Selects only DEFAULT variants (status =
    // 'DEFAULT' is the fallback body used when no status-specific
    // variant exists — parity with the compare target).
    defaultVariants,
    // Bugfix (2026-04-23): TenantAiConfig carries the real system-prompt
    // state (coordinator + screening text + version). The earlier fix
    // only consulted this inside build-controller.ts, so the right-rail
    // CURRENT STATE card — fed by `/api/build/tenant-state` — kept
    // rendering "Empty" regardless. Moving the lookup into the service
    // means every consumer (rail, agent prompt, tool response, banner
    // caption) sees the same status.
    aiCfg,
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
    prisma.sopVariant.findMany({
      where: { status: 'DEFAULT', sopDefinition: { tenantId } },
      select: { content: true, sopDefinition: { select: { category: true } } },
    }),
    prisma.tenantAiConfig.findUnique({
      where: { tenantId },
      select: {
        systemPromptCoordinator: true,
        systemPromptScreening: true,
        systemPromptVersion: true,
      },
    }),
  ]);

  // Byte-for-byte match against SEED_SOP_CONTENT. If the category isn't
  // in the seed dictionary (e.g. operator-created SOP with a fresh
  // category), it can't be "defaulted" — count only known-seeded
  // categories whose content equals the seed.
  let sopsDefaulted = 0;
  for (const v of defaultVariants) {
    const cat = v.sopDefinition?.category;
    if (!cat) continue;
    const seed = SEED_SOP_CONTENT[cat];
    if (seed === undefined) continue;
    if (v.content === seed) sopsDefaulted += 1;
  }

  const isGreenfield = sopCount === 0 && faqGlobal === 0 && customToolCount === 0;

  // Derive the system-prompt status from TenantAiConfig. Matches the
  // earlier build-controller helper byte-for-byte; keeping the logic
  // here so every wire consumer reports the same value.
  const coord = (aiCfg?.systemPromptCoordinator ?? '').trim();
  const screen = (aiCfg?.systemPromptScreening ?? '').trim();
  const systemPromptEditCount = aiCfg?.systemPromptVersion ?? 0;
  let systemPromptStatus: 'EMPTY' | 'DEFAULT' | 'CUSTOMISED';
  if (!coord && !screen) {
    systemPromptStatus = 'EMPTY';
  } else {
    const seedCoord = SEED_COORDINATOR_PROMPT.trim();
    const seedScreen = SEED_SCREENING_PROMPT.trim();
    const coordIsSeed = coord === seedCoord || coord.startsWith(seedCoord);
    const screenIsSeed =
      !screen || screen === seedScreen || screen.startsWith(seedScreen);
    systemPromptStatus = coordIsSeed && screenIsSeed ? 'DEFAULT' : 'CUSTOMISED';
  }

  const summary: TenantStateSummary = {
    sopCount,
    sopsDefaulted,
    faqCounts: { global: faqGlobal, perProperty: faqPerProperty },
    customToolCount,
    propertyCount,
    isGreenfield,
    systemPromptStatus,
    systemPromptEditCount,
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
  /**
   * Slot keys whose memory value contains the DEFAULT_MARKER sentinel.
   * These don't count toward graduation but the agent should flag them
   * for explicit operator review — the rendered <interview_progress>
   * block surfaces them as "Defaulted slots flagged for review: …".
   * Empty array when nothing is defaulted (common on fresh sessions).
   */
  defaultedSlots: string[];
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
  const defaultedSlots: string[] = [];
  let loadBearingFilled = 0;

  for (const row of rows) {
    const slotKey = row.key.slice(prefix.length);
    if (!ALL_SLOT_KEYS.has(slotKey)) continue;
    // Detect the DEFAULT marker explicitly. `isSlotValueFilled` lumps
    // "never answered" and "answered with default" into one NOT-FILLED
    // bucket, but the agent wants to distinguish them: defaulted slots
    // were acknowledged by the manager and need an explicit review
    // pass, while empty slots are just open questions.
    const raw = row.value;
    const isDefaulted =
      typeof raw === 'string' && raw.includes(DEFAULT_MARKER);
    if (isDefaulted) {
      defaultedSlots.push(slotKey);
      continue;
    }
    if (!isSlotValueFilled(raw)) continue;
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
    defaultedSlots,
  };
}
