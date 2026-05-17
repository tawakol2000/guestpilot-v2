/**
 * Feature 041 sprint 02 §4 — Suggestion writer with 48h cooldown.
 *
 * Consumes a DiagnosticResult from diagnostic.service.ts and:
 *   - NO_FIX              → writes nothing, returns null (first-class abstain).
 *   - MISSING_CAPABILITY  → creates a CapabilityRequest, returns null
 *                           (the manager backlog, not the artifact queue).
 *   - Everything else     → creates a TuningSuggestion with the new sprint-02
 *                           taxonomy fields populated and the 48h cooldown
 *                           check applied.
 *
 * Cooldown: if an ACCEPTED suggestion already exists for the same
 * (diagnosticCategory, artifact target) within the last 48h, this writer
 * skips (logs + returns null). Simple last-write-wins — no oscillation
 * detection yet, per the brief (oscillation is deferred beyond sprint 02).
 *
 * Note on `actionType`: the old Feature-040 enum is preserved intact (no
 * schema change) and is still required on TuningSuggestion. We map the new
 * 8-category taxonomy onto the closest existing action type so the write
 * succeeds. Sprint 03's new UI will consume `diagnosticCategory` as the
 * primary dispatch key; `actionType` becomes secondary / legacy.
 */
import {
  PrismaClient,
  TuningActionType,
  TuningConversationTriggerType,
  TuningDiagnosticCategory,
  type TuningSuggestion,
} from '@prisma/client';
import type { DiagnosticResult } from './diagnostic.service';
import { getCategoryAcceptance30d } from './category-stats.service';

const COOLDOWN_WINDOW_MS = 48 * 60 * 60 * 1000;

// Sprint 08 §4 — criticalFailure detection thresholds.
// A suggestion is a critical failure iff:
//   category ∈ { SOP_CONTENT, SOP_ROUTING, SYSTEM_PROMPT }
//   AND confidence >= 0.85
//   AND magnitude === 'WHOLESALE'
// Graduation blocks while any criticalFailure row exists in the last 30d.
const CRITICAL_FAILURE_CONFIDENCE = 0.85;
const CRITICAL_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  'SOP_CONTENT',
  'SOP_ROUTING',
  'SYSTEM_PROMPT',
]);

// Sprint 08 §5 — per-category confidence gating thresholds. Kept in sync with
// tuning-dashboards.controller.ts so the dashboard "gated" flag and the
// pipeline's AUTO_SUPPRESSED writes describe the same condition.
const CATEGORY_GATING_ACCEPTANCE_THRESHOLD = 0.3;
const CATEGORY_GATING_CONFIDENCE_FLOOR = 0.75;
const CATEGORY_GATING_MIN_SAMPLE = 5;

export interface WriteSuggestionContext {
  // sprint-04 will populate this when the suggestion is proposed inside a
  // tuning chat; V1 triggers all leave it null.
  conversationId?: string | null;
}

export interface WriteSuggestionOutcome {
  suggestion: TuningSuggestion | null;
  capabilityRequestId: string | null;
  /** Short reason string to help the caller log. */
  note: string;
}

/**
 * Persist or abstain based on the diagnostic result. Always returns an
 * outcome; never throws unless the underlying DB call throws.
 */
export async function writeSuggestionFromDiagnostic(
  result: DiagnosticResult,
  context: WriteSuggestionContext,
  prisma: PrismaClient
): Promise<WriteSuggestionOutcome> {
  // 1. NO_FIX — first-class abstain. Log + return null.
  if (result.category === 'NO_FIX') {
    console.log(
      `[SuggestionWriter] NO_FIX (subLabel="${result.subLabel}" conf=${result.confidence.toFixed(2)}) — no suggestion created.`
    );
    return { suggestion: null, capabilityRequestId: null, note: 'NO_FIX' };
  }

  // 2. MISSING_CAPABILITY — creates a CapabilityRequest (manager backlog).
  if (result.category === 'MISSING_CAPABILITY') {
    const cap = result.capabilityRequest ?? {
      title: result.subLabel || 'Unspecified capability request',
      description: result.rationale || '(no description produced by model)',
      rationale: result.rationale || '',
    };
    const row = await prisma.capabilityRequest.create({
      data: {
        tenantId: result.tenantId,
        title: safeString(cap.title, 200),
        description: cap.description,
        rationale: cap.rationale,
      },
      select: { id: true },
    });
    console.log(`[SuggestionWriter] MISSING_CAPABILITY → CapabilityRequest ${row.id} created.`);
    return { suggestion: null, capabilityRequestId: row.id, note: 'MISSING_CAPABILITY' };
  }

  // 3. All other categories write a TuningSuggestion.
  if (!result.sourceMessageId) {
    console.warn('[SuggestionWriter] No sourceMessageId on diagnostic result — cannot persist suggestion.');
    return { suggestion: null, capabilityRequestId: null, note: 'NO_SOURCE_MESSAGE_ID' };
  }

  // 3a. 48h cooldown on the same (category, target, sopStatus).
  //
  // Sprint 09 fix 10: previously scoped only by (category, sopCategory),
  // so a fix applied to check-in@CONFIRMED blocked a different fix on
  // check-in@INQUIRY. Pass sopStatus through when available so the
  // cooldown narrows to the exact variant being written.
  const cooldownHit = await checkCooldown(prisma, {
    tenantId: result.tenantId,
    category: result.category as TuningDiagnosticCategory,
    targetId: result.artifactTarget.id,
    sopStatus: null, // Diagnostic currently doesn't emit sopStatus; placeholder for when it does.
  });
  if (cooldownHit) {
    console.log(
      `[SuggestionWriter] Cooldown hit for category=${result.category} target=${result.artifactTarget.id ?? 'null'} — skipping (last ACCEPTED at ${cooldownHit.toISOString()}).`
    );
    return { suggestion: null, capabilityRequestId: null, note: 'COOLDOWN_48H' };
  }

  let actionType = mapCategoryToActionType(result.category);
  const targetFields = buildTargetFields(result);

  // 2026-05-16: when the diagnostic proposes a NEW FAQ entry (category='FAQ'
  // with no existing faqEntryId), surface the model-emitted faqProposal
  // (normalized question + FAQ_CATEGORIES slug + GLOBAL/PROPERTY scope) into
  // the dedicated TuningSuggestion columns so the FAQ admin page can render
  // it as a real Q&A card pre-acceptance — not just an answer floating
  // without a question.
  if (result.category === 'FAQ' && !result.artifactTarget.id && result.faqProposal) {
    actionType = TuningActionType.CREATE_FAQ;
    targetFields.faqQuestion = result.faqProposal.question;
    targetFields.faqCategory = result.faqProposal.category;
    targetFields.faqScope = result.faqProposal.scope;
    targetFields.faqAnswer = result.proposedText ?? null;
  }

  // ─── Sprint 08 §4: criticalFailure detection ────────────────────────────
  const isCriticalFailure =
    CRITICAL_FAILURE_CATEGORIES.has(result.category) &&
    result.confidence >= CRITICAL_FAILURE_CONFIDENCE &&
    result.diagMeta.magnitude === 'WHOLESALE';

  // ─── Sprint 08 §5: per-category confidence gating ───────────────────────
  // If the category's 30-day acceptance rate is below the threshold AND we
  // have enough signal to trust it (sample size ≥ 5), require elevated
  // confidence (≥ 0.75) to surface. Below the floor, write AUTO_SUPPRESSED
  // instead of PENDING — the row is kept for record / DPO signal but is
  // hidden from the default queue.
  let status: 'PENDING' | 'AUTO_SUPPRESSED' = 'PENDING';
  let gatingNote: string | null = null;
  try {
    const { acceptanceRate, sampleSize } = await getCategoryAcceptance30d(
      prisma,
      result.tenantId,
      result.category as TuningDiagnosticCategory,
    );
    const gated =
      acceptanceRate !== null &&
      sampleSize >= CATEGORY_GATING_MIN_SAMPLE &&
      acceptanceRate < CATEGORY_GATING_ACCEPTANCE_THRESHOLD;
    if (gated && result.confidence < CATEGORY_GATING_CONFIDENCE_FLOOR) {
      status = 'AUTO_SUPPRESSED';
      gatingNote = `gated category acceptance=${(acceptanceRate * 100).toFixed(
        0,
      )}% n=${sampleSize} conf=${result.confidence.toFixed(2)} < ${CATEGORY_GATING_CONFIDENCE_FLOOR}`;
    }
  } catch (err) {
    // Gating must never block writes.
    console.warn('[SuggestionWriter] category gating lookup failed (non-fatal):', err);
  }

  const suggestion = await prisma.tuningSuggestion.create({
    data: {
      tenantId: result.tenantId,
      sourceMessageId: result.sourceMessageId,
      actionType,
      status,
      rationale: result.rationale || '',
      proposedText: result.proposedText ?? null,
      beforeText: result.diagMeta.originalText || null,
      ...targetFields,
      // ── sprint 02 taxonomy fields ──
      diagnosticCategory: result.category as TuningDiagnosticCategory,
      diagnosticSubLabel: result.subLabel,
      triggerType: result.triggerType,
      evidenceBundleId: result.evidenceBundleId,
      confidence: result.confidence,
      // applyMode stays null until the sprint-03 UI writes it.
      conversationId: context.conversationId ?? null,
      // ── sprint 08 §4 ──
      criticalFailure: isCriticalFailure,
    },
  });
  console.log(
    `[SuggestionWriter] wrote TuningSuggestion ${suggestion.id} category=${result.category} subLabel="${result.subLabel}" conf=${result.confidence.toFixed(2)} status=${status}${isCriticalFailure ? ' CRITICAL_FAILURE' : ''}${gatingNote ? ` (${gatingNote})` : ''}`,
  );
  return {
    suggestion,
    capabilityRequestId: null,
    note: status === 'AUTO_SUPPRESSED' ? 'AUTO_SUPPRESSED' : 'CREATED',
  };
}

// ─── Cooldown ────────────────────────────────────────────────────────────────

async function checkCooldown(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    category: TuningDiagnosticCategory;
    targetId: string | null;
    sopStatus?: string | null;
  }
): Promise<Date | null> {
  const since = new Date(Date.now() - COOLDOWN_WINDOW_MS);
  const where: any = {
    tenantId: params.tenantId,
    status: 'ACCEPTED',
    diagnosticCategory: params.category,
    appliedAt: { gte: since },
  };
  // When the model returned a concrete target id, narrow the cooldown to that
  // specific artifact. Without a target id we scope by category alone, which
  // is coarser but still prevents repeated writes for the same kind of fix.
  if (params.targetId) {
    // Match through whichever field the target id lives on per category.
    switch (params.category) {
      case 'SOP_CONTENT':
      case 'SOP_ROUTING':
      case 'PROPERTY_OVERRIDE':
        where.sopCategory = params.targetId;
        // Sprint 09 fix 10: also scope by sopStatus when the caller supplied
        // it, so a suggestion for the CONFIRMED variant doesn't block a
        // separate suggestion for the INQUIRY variant of the same SOP.
        // Back-compat: when sopStatus is null/absent the filter is omitted
        // and the cooldown behaves as before.
        if (params.sopStatus) {
          where.sopStatus = params.sopStatus;
        }
        break;
      case 'FAQ':
        // Target id may be the FaqEntry id.
        where.faqEntryId = params.targetId;
        break;
      case 'SYSTEM_PROMPT':
        where.systemPromptVariant = params.targetId;
        break;
      // TOOL_CONFIG and others: no existing field to scope on; leave category-only.
      default:
        break;
    }
  }
  const latest = await prisma.tuningSuggestion.findFirst({
    where,
    orderBy: { appliedAt: 'desc' },
    select: { appliedAt: true },
  });
  return latest?.appliedAt ?? null;
}

// ─── Pre-diagnostic cooldown probe ──────────────────────────────────────────
// 2026-05-17: cheap (single index-backed query) check used BEFORE running
// the full gpt-5.4 k=3 diagnostic. Returns the most recent ACCEPTED
// suggestion in a high-cooldown category within the 48h window, or null.
//
// Why: the existing checkCooldown() runs AFTER the diagnostic — meaning
// every cooldown-suppressed edit still burns ~$0.21 + 2 minutes on a
// gpt-5.4 run whose output is immediately thrown away. A pre-check lets
// us short-circuit the analyzer for the common case (operator polishes
// the same artifact twice in a day).
//
// What this probe DOESN'T do: predict the exact category the diagnostic
// would produce. We use it as a coarse signal — combined with an edit-
// similarity check at the call site (only skip on SMALL edits where the
// model is likely to pick the same cooldown category), the false-skip
// risk is acceptable. Wholesale rewrites (similarity < 0.5) bypass this
// gate entirely and always run.
const HIGH_COOLDOWN_CATEGORIES: readonly TuningDiagnosticCategory[] = [
  'SYSTEM_PROMPT',
  'SOP_CONTENT',
  'SOP_ROUTING',
  'FAQ',
  'PROPERTY_OVERRIDE',
] as const;

export interface RecentAcceptanceProbeResult {
  category: TuningDiagnosticCategory;
  appliedAt: Date;
  targetLabel: string;
}

export async function probeRecentHighCooldownAcceptance(
  prisma: PrismaClient,
  tenantId: string,
  /**
   * 2026-05-17: optional category scope. When supplied, the probe only fires
   * if a recent ACCEPTED suggestion is in one of these categories. Lets the
   * pre-classifier (`category-pre-classifier.service.ts`) ask the narrow
   * question "is the category I just predicted on cooldown?" instead of the
   * coarse "is any high-cooldown category on cooldown?". When omitted,
   * defaults to the full HIGH_COOLDOWN_CATEGORIES set (original behavior).
   */
  categoryScope?: readonly TuningDiagnosticCategory[],
): Promise<RecentAcceptanceProbeResult | null> {
  const since = new Date(Date.now() - COOLDOWN_WINDOW_MS);
  const scope = (categoryScope && categoryScope.length > 0
    ? categoryScope
    : HIGH_COOLDOWN_CATEGORIES) as TuningDiagnosticCategory[];
  const hit = await prisma.tuningSuggestion.findFirst({
    where: {
      tenantId,
      status: 'ACCEPTED',
      diagnosticCategory: { in: scope },
      appliedAt: { gte: since },
    },
    orderBy: { appliedAt: 'desc' },
    select: {
      diagnosticCategory: true,
      appliedAt: true,
      systemPromptVariant: true,
      sopCategory: true,
      faqEntryId: true,
    },
  });
  if (!hit || !hit.diagnosticCategory || !hit.appliedAt) return null;
  const targetLabel =
    hit.systemPromptVariant ??
    hit.sopCategory ??
    hit.faqEntryId ??
    '(unspecified)';
  return {
    category: hit.diagnosticCategory,
    appliedAt: hit.appliedAt,
    targetLabel,
  };
}

// ─── Category → legacy action type mapping ───────────────────────────────────
// The existing `TuningActionType` enum is preserved (old-branch compatibility).
// New taxonomy categories map to the closest existing action type so the
// required `actionType` column stays populated. Sprint 03's new UI will use
// `diagnosticCategory` as the primary dispatch key.

function mapCategoryToActionType(category: DiagnosticResult['category']): TuningActionType {
  switch (category) {
    case 'SOP_CONTENT':
      return TuningActionType.EDIT_SOP_CONTENT;
    case 'SOP_ROUTING':
      return TuningActionType.EDIT_SOP_ROUTING;
    case 'FAQ':
      return TuningActionType.EDIT_FAQ;
    case 'SYSTEM_PROMPT':
      return TuningActionType.EDIT_SYSTEM_PROMPT;
    case 'TOOL_CONFIG':
      // No perfect match in the legacy enum. EDIT_SYSTEM_PROMPT is the least-
      // wrong fallback — both are "configuration" edits. The new UI reads
      // diagnosticCategory for the real routing.
      return TuningActionType.EDIT_SYSTEM_PROMPT;
    case 'PROPERTY_OVERRIDE':
      // A property override IS an SOP content edit scoped to a property.
      return TuningActionType.EDIT_SOP_CONTENT;
    default:
      // Unreachable for NO_FIX / MISSING_CAPABILITY (handled earlier).
      return TuningActionType.EDIT_SYSTEM_PROMPT;
  }
}

// ─── Target field population (legacy compat) ─────────────────────────────────

// 2026-05-16: shape check. The diagnostic prompt instructs the model
// to populate artifactTarget.id with a CATEGORY SLUG for SOP_*, an
// existing FAQ entry id for FAQ, a variant NAME (coordinator/screening)
// for SYSTEM_PROMPT, and a TOOL NAME for TOOL_CONFIG. The model
// occasionally returns a cuid (variant id, faq category slug, etc.)
// which the writer would silently store in the wrong field — the
// Accept flow then 404s at apply time.
//
// `looksLikeCuid` detects the 25-char cuid format Prisma uses by
// default. When detected for a category that should NOT be a cuid, we
// drop the id (the suggestion still persists, just with a null target
// so the operator picks via the UI rather than a broken auto-target).
const CUID_RE = /^c[a-z0-9]{24}$/;
function looksLikeCuid(s: string): boolean {
  return typeof s === 'string' && CUID_RE.test(s);
}

function buildTargetFields(result: DiagnosticResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const id = result.artifactTarget.id;
  if (!id) return out;
  switch (result.category) {
    case 'SOP_CONTENT':
    case 'SOP_ROUTING':
    case 'PROPERTY_OVERRIDE':
      // sopCategory must be a SLUG like 'sop-early-check-in', NOT a
      // SopVariant cuid. Drop variant-ids the model returned by
      // mistake — the UI can prompt the manager to pick the category.
      if (looksLikeCuid(id)) {
        console.warn(
          `[SuggestionWriter] dropped variant-id "${id}" returned as artifactTarget.id for ${result.category} — expected category slug. Target left null.`
        );
        break;
      }
      out.sopCategory = id;
      // sopStatus is unknown from the diagnostic payload — leave null so the
      // sprint-03 UI can prompt the manager to pick the status. Setting it
      // incorrectly would cause the legacy accept endpoint to write to the
      // wrong variant.
      break;
    case 'FAQ':
      // faqEntryId IS expected to be a cuid (FaqEntry primary key).
      out.faqEntryId = id;
      break;
    case 'SYSTEM_PROMPT':
      // Expected: "coordinator" or "screening" — short string, not a cuid.
      if (looksLikeCuid(id)) {
        console.warn(
          `[SuggestionWriter] dropped cuid "${id}" returned as systemPromptVariant — expected "coordinator" or "screening".`
        );
        break;
      }
      out.systemPromptVariant = id;
      break;
    case 'TOOL_CONFIG':
      // No legacy field — id captured only via diagnosticSubLabel / proposedText.
      break;
  }
  return out;
}

function safeString(s: string, max: number): string {
  return (s ?? '').slice(0, max);
}
