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

const COOLDOWN_WINDOW_MS = 48 * 60 * 60 * 1000;

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

  // 3a. 48h cooldown on the same (category, target).
  const cooldownHit = await checkCooldown(prisma, {
    tenantId: result.tenantId,
    category: result.category as TuningDiagnosticCategory,
    targetId: result.artifactTarget.id,
  });
  if (cooldownHit) {
    console.log(
      `[SuggestionWriter] Cooldown hit for category=${result.category} target=${result.artifactTarget.id ?? 'null'} — skipping (last ACCEPTED at ${cooldownHit.toISOString()}).`
    );
    return { suggestion: null, capabilityRequestId: null, note: 'COOLDOWN_48H' };
  }

  const actionType = mapCategoryToActionType(result.category);
  const targetFields = buildTargetFields(result);

  const suggestion = await prisma.tuningSuggestion.create({
    data: {
      tenantId: result.tenantId,
      sourceMessageId: result.sourceMessageId,
      actionType,
      status: 'PENDING',
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
    },
  });
  console.log(
    `[SuggestionWriter] wrote TuningSuggestion ${suggestion.id} category=${result.category} subLabel="${result.subLabel}" conf=${result.confidence.toFixed(2)}`
  );
  return { suggestion, capabilityRequestId: null, note: 'CREATED' };
}

// ─── Cooldown ────────────────────────────────────────────────────────────────

async function checkCooldown(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    category: TuningDiagnosticCategory;
    targetId: string | null;
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

function buildTargetFields(result: DiagnosticResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const id = result.artifactTarget.id;
  if (!id) return out;
  switch (result.category) {
    case 'SOP_CONTENT':
    case 'SOP_ROUTING':
      out.sopCategory = id;
      // sopStatus is unknown from the diagnostic payload — leave null so the
      // sprint-03 UI can prompt the manager to pick the status. Setting it
      // incorrectly would cause the legacy accept endpoint to write to the
      // wrong variant.
      break;
    case 'PROPERTY_OVERRIDE':
      out.sopCategory = id;
      // sopPropertyId similarly unknown — sprint-03 UI supplies it.
      break;
    case 'FAQ':
      out.faqEntryId = id;
      break;
    case 'SYSTEM_PROMPT':
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
