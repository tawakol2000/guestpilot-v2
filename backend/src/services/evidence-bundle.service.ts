/**
 * Feature 041 sprint 01 §2 — Evidence bundle assembler.
 *
 * Packages a triggering event (an edit, reject, complaint, thumbs-down, or
 * future cluster/escalation trigger) into a single JSON snapshot the future
 * tuning agent will consume via a tool call. The bundle is the primary input
 * the tuning agent reasons against — rich evidence beats thin context.
 *
 * No caller yet. Sprint 02 will wire this into the diagnostic pipeline, which
 * replaces the two-step analyzer deleted this sprint.
 *
 * Design choices:
 * - Primary source for "what the main AI did" is `AiApiLog.ragContext`
 *   (persisted in our own Postgres). This is always reachable.
 * - Langfuse trace is supplementary: when keys are configured and the SDK
 *   reaches the API, we attach the raw trace payload via
 *   `api.traceList({ sessionId, ... })` filtered by metadata.messageId.
 *   Missing/unreachable Langfuse degrades silently.
 * - Hostaway entities come from Postgres (Property, Reservation, Guest),
 *   which is kept in sync by the existing webhook + polling paths. We don't
 *   hit the Hostaway API synchronously here — the bundle should be cheap.
 * - SOP variants and property overrides are captured by category + status
 *   as they were *at bundle time*, because the tuning agent will sometimes
 *   diff them against what's in the trace.
 */
import { PrismaClient } from '@prisma/client';
import type { AiApiLog, FaqEntry, SopPropertyOverride, SopVariant, TuningSuggestion } from '@prisma/client';
import { Langfuse } from 'langfuse';

// ─── Trigger event (input to the assembler) ──────────────────────────────────

export type EvidenceTriggerType =
  | 'MANUAL'
  | 'EDIT_TRIGGERED'
  | 'REJECT_TRIGGERED'
  | 'COMPLAINT_TRIGGERED'
  | 'THUMBS_DOWN_TRIGGERED'
  | 'CLUSTER_TRIGGERED'
  | 'ESCALATION_TRIGGERED';

export interface EvidenceTriggerEvent {
  /** Trigger category; must match `TuningConversationTriggerType` enum. */
  triggerType: EvidenceTriggerType;
  /** Tenant that owns the artifacts and message. */
  tenantId: string;
  /** The main-AI Message that produced the disputed reply. Optional for
   *  future non-message triggers (cluster rollup, etc.). */
  messageId?: string;
  /** Optional Langfuse trace id if the caller already knows it. If unset, the
   *  assembler searches by sessionId + metadata.messageId. */
  langfuseTraceId?: string;
  /** How many prior messages to include in `conversationContext.messages`. */
  messageWindow?: number;
  /** Free-form notes from the caller (e.g. manager's complaint text). */
  note?: string;
}

// ─── Bundle shape (exported for sprint 02+ consumers) ────────────────────────

export interface EvidenceBundle {
  /** When the bundle was assembled. */
  assembledAt: string;
  trigger: EvidenceTriggerEvent & { resolvedAt: string };

  /** The AI output that is being disputed / reviewed. */
  disputedMessage: {
    id: string;
    content: string;
    originalAiText: string | null;
    editedByUserId: string | null;
    sentAt: string;
    role: string;
    channel: string;
    previewState: string | null;
  } | null;

  /** Conversation context: last N messages, oldest first. */
  conversationContext: {
    conversationId: string;
    channel: string;
    status: string;
    summary: string | null;
    summaryUpdatedAt: string | null;
    messages: Array<{
      id: string;
      role: string;
      content: string;
      sentAt: string;
    }>;
  } | null;

  /** Hostaway entity metadata snapshotted from our DB. */
  entities: {
    property: {
      id: string;
      hostawayListingId: string;
      name: string;
      address: string;
      listingDescription: string;
      customKnowledgeBase: unknown;
    } | null;
    reservation: {
      id: string;
      hostawayReservationId: string;
      checkIn: string;
      checkOut: string;
      guestCount: number;
      channel: string;
      status: string;
      aiMode: string;
      screeningAnswers: unknown;
    } | null;
    guest: {
      id: string;
      hostawayGuestId: string;
      name: string;
      email: string;
      phone: string;
      nationality: string;
    } | null;
  };

  /** What the main AI did during this run, from our own DB (AiApiLog). */
  mainAiTrace: {
    aiApiLogId: string | null;
    agentName: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    error: string | null;
    ragContext: unknown; // classifier decision, tools used, FAQ hits, etc.
    createdAt: string;
  } | null;

  /** Raw Langfuse trace if fetchable; null when keys are missing or API is
   *  unreachable. Consumers must treat absence as "not available", not "no
   *  activity". */
  langfuseTrace: unknown | null;
  langfuseTraceRef: {
    sessionId: string;
    messageIdHint: string | null;
    traceId: string | null;
    fetched: boolean;
    error: string | null;
  };

  /** The specific SOP category(ies) classified for this run, plus the SOP
   *  variants + property overrides that were in effect at bundle time. */
  sopsInEffect: Array<{
    category: string;
    toolDescription: string;
    variants: Array<Pick<SopVariant, 'id' | 'status' | 'content' | 'enabled'>>;
    propertyOverrides: Array<Pick<SopPropertyOverride, 'id' | 'status' | 'content' | 'enabled' | 'propertyId'>>;
  }>;

  /** FAQ entries that were retrieved in this run (by id from ragContext). If
   *  ragContext didn't record FAQ ids, this will be the active FAQs for the
   *  conversation's category as a best-effort fallback. */
  faqHits: Array<Pick<FaqEntry, 'id' | 'question' | 'answer' | 'category' | 'scope' | 'propertyId' | 'status'>>;

  /** Prior TuningSuggestion rows for the same property / category over the
   *  configured lookback window (default 90 days). */
  priorSuggestions: Array<Pick<
    TuningSuggestion,
    | 'id'
    | 'actionType'
    | 'status'
    | 'rationale'
    | 'sopCategory'
    | 'sopStatus'
    | 'sopPropertyId'
    | 'faqEntryId'
    | 'faqCategory'
    | 'applyMode'
    | 'confidence'
    | 'createdAt'
    | 'appliedAt'
  >>;

  /** System prompt assembly context for the run. Branch tags come from
   *  tenantConfig + reservation status and are meant to be fluid strings —
   *  consumers should not pattern-match them beyond equality. */
  systemPromptContext: {
    version: number | null;
    agentName: string | null; // 'coordinator' | 'screening' | null when unknown
    reservationStatus: string | null;
    branchTags: string[];
  };
}

// ─── Assembler entry point ───────────────────────────────────────────────────

export async function assembleEvidenceBundle(
  triggerEvent: EvidenceTriggerEvent,
  prisma: PrismaClient
): Promise<EvidenceBundle> {
  const assembledAt = new Date().toISOString();
  const messageWindow = Math.max(1, Math.min(100, triggerEvent.messageWindow ?? 20));

  // ─── 1. Disputed Message + conversation ────────────────────────────────
  const message = triggerEvent.messageId
    ? await prisma.message.findFirst({
        where: { id: triggerEvent.messageId, tenantId: triggerEvent.tenantId },
      })
    : null;

  let conversation: Awaited<ReturnType<typeof prisma.conversation.findFirst>> | null = null;
  let contextMessages: Array<{ id: string; role: string; content: string; sentAt: Date }> = [];
  if (message) {
    conversation = await prisma.conversation.findFirst({
      where: { id: message.conversationId, tenantId: triggerEvent.tenantId },
    });
    const recent = await prisma.message.findMany({
      where: {
        conversationId: message.conversationId,
        tenantId: triggerEvent.tenantId,
        sentAt: { lte: message.sentAt },
      },
      orderBy: { sentAt: 'desc' },
      take: messageWindow,
      select: { id: true, role: true, content: true, sentAt: true },
    });
    contextMessages = recent.slice().reverse();
  }

  // ─── 2. Hostaway entities (Property / Reservation / Guest) ─────────────
  let entities: EvidenceBundle['entities'] = { property: null, reservation: null, guest: null };
  if (conversation) {
    const [property, reservation, guest] = await Promise.all([
      prisma.property.findUnique({ where: { id: conversation.propertyId } }),
      prisma.reservation.findUnique({ where: { id: conversation.reservationId } }),
      prisma.guest.findUnique({ where: { id: conversation.guestId } }),
    ]);
    entities = {
      property: property
        ? {
            id: property.id,
            hostawayListingId: property.hostawayListingId,
            name: property.name,
            address: property.address,
            listingDescription: property.listingDescription,
            customKnowledgeBase: property.customKnowledgeBase,
          }
        : null,
      reservation: reservation
        ? {
            id: reservation.id,
            hostawayReservationId: reservation.hostawayReservationId,
            checkIn: reservation.checkIn.toISOString(),
            checkOut: reservation.checkOut.toISOString(),
            guestCount: reservation.guestCount,
            channel: String(reservation.channel),
            status: String(reservation.status),
            aiMode: reservation.aiMode,
            screeningAnswers: reservation.screeningAnswers,
          }
        : null,
      guest: guest
        ? {
            id: guest.id,
            hostawayGuestId: guest.hostawayGuestId,
            name: guest.name,
            email: guest.email,
            phone: guest.phone,
            nationality: guest.nationality,
          }
        : null,
    };
  }

  // ─── 3. Main-AI trace from AiApiLog (our DB source of truth) ──────────
  let mainAiTrace: EvidenceBundle['mainAiTrace'] = null;
  let aiApiLogRow: AiApiLog | null = null;
  if (message?.aiApiLogId) {
    aiApiLogRow = await prisma.aiApiLog.findUnique({ where: { id: message.aiApiLogId } });
  } else if (message) {
    // Fallback: most recent AiApiLog on this conversation before or at the message
    aiApiLogRow = await prisma.aiApiLog.findFirst({
      where: { conversationId: message.conversationId, tenantId: triggerEvent.tenantId, createdAt: { lte: message.sentAt } },
      orderBy: { createdAt: 'desc' },
    });
  }
  if (aiApiLogRow) {
    mainAiTrace = {
      aiApiLogId: aiApiLogRow.id,
      agentName: aiApiLogRow.agentName,
      model: aiApiLogRow.model,
      inputTokens: aiApiLogRow.inputTokens,
      outputTokens: aiApiLogRow.outputTokens,
      costUsd: aiApiLogRow.costUsd,
      durationMs: aiApiLogRow.durationMs,
      error: aiApiLogRow.error,
      ragContext: aiApiLogRow.ragContext,
      createdAt: aiApiLogRow.createdAt.toISOString(),
    };
  }

  // ─── 4. Langfuse trace (best-effort) ───────────────────────────────────
  const { trace: langfuseTrace, ref: langfuseTraceRef } = await fetchLangfuseTrace(
    triggerEvent,
    conversation?.id ?? null
  );

  // ─── 5. SOPs in effect at bundle time ─────────────────────────────────
  const ragContext = (aiApiLogRow?.ragContext as Record<string, unknown> | null) ?? null;
  const classifiedCategories: string[] = Array.isArray(ragContext?.sopCategories)
    ? (ragContext!.sopCategories as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const reservationStatus = entities.reservation?.status ?? 'DEFAULT';
  const sopsInEffect = await buildSopsInEffect(
    prisma,
    triggerEvent.tenantId,
    entities.property?.id ?? null,
    classifiedCategories,
    reservationStatus
  );

  // ─── 6. FAQ hits ──────────────────────────────────────────────────────
  const faqHits = await buildFaqHits(
    prisma,
    triggerEvent.tenantId,
    entities.property?.id ?? null,
    ragContext
  );

  // ─── 7. Prior TuningSuggestions (last 90 days) ────────────────────────
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const priorSuggestions = await prisma.tuningSuggestion.findMany({
    where: {
      tenantId: triggerEvent.tenantId,
      createdAt: { gte: ninetyDaysAgo },
      OR: [
        ...(classifiedCategories.length
          ? [{ sopCategory: { in: classifiedCategories } }]
          : []),
        ...(entities.property?.id
          ? [{ sopPropertyId: entities.property.id }, { faqPropertyId: entities.property.id }]
          : []),
      ].filter((clause) => Object.keys(clause).length > 0),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      actionType: true,
      status: true,
      rationale: true,
      sopCategory: true,
      sopStatus: true,
      sopPropertyId: true,
      faqEntryId: true,
      faqCategory: true,
      applyMode: true,
      confidence: true,
      createdAt: true,
      appliedAt: true,
    },
  });

  // ─── 8. System prompt assembly context ────────────────────────────────
  const tenantConfig = await prisma.tenantAiConfig.findUnique({
    where: { tenantId: triggerEvent.tenantId },
    select: { systemPromptVersion: true },
  });
  const branchTags = buildBranchTags(reservationStatus, ragContext);

  return {
    assembledAt,
    trigger: { ...triggerEvent, resolvedAt: assembledAt },
    disputedMessage: message
      ? {
          id: message.id,
          content: message.content,
          originalAiText: message.originalAiText,
          editedByUserId: message.editedByUserId,
          sentAt: message.sentAt.toISOString(),
          role: String(message.role),
          channel: String(message.channel),
          previewState: message.previewState ? String(message.previewState) : null,
        }
      : null,
    conversationContext: conversation
      ? {
          conversationId: conversation.id,
          channel: String(conversation.channel),
          status: String(conversation.status),
          summary: conversation.conversationSummary,
          summaryUpdatedAt: conversation.summaryUpdatedAt?.toISOString() ?? null,
          messages: contextMessages.map((m) => ({
            id: m.id,
            role: String(m.role),
            content: m.content,
            sentAt: m.sentAt.toISOString(),
          })),
        }
      : null,
    entities,
    mainAiTrace,
    langfuseTrace,
    langfuseTraceRef,
    sopsInEffect,
    faqHits,
    priorSuggestions,
    systemPromptContext: {
      version: tenantConfig?.systemPromptVersion ?? null,
      agentName: typeof ragContext?.agentName === 'string' ? (ragContext!.agentName as string) : null,
      reservationStatus: entities.reservation?.status ?? null,
      branchTags,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function buildSopsInEffect(
  prisma: PrismaClient,
  tenantId: string,
  propertyId: string | null,
  categories: string[],
  reservationStatus: string
): Promise<EvidenceBundle['sopsInEffect']> {
  if (categories.length === 0) return [];
  const sopDefs = await prisma.sopDefinition.findMany({
    where: { tenantId, category: { in: categories } },
    include: {
      variants: { where: { OR: [{ status: reservationStatus }, { status: 'DEFAULT' }] } },
      propertyOverrides: propertyId
        ? {
            where: {
              propertyId,
              OR: [{ status: reservationStatus }, { status: 'DEFAULT' }],
            },
          }
        : false,
    },
  });
  return sopDefs.map((def) => ({
    category: def.category,
    toolDescription: def.toolDescription,
    variants: def.variants.map((v) => ({
      id: v.id,
      status: v.status,
      content: v.content,
      enabled: v.enabled,
    })),
    propertyOverrides: (def.propertyOverrides ?? []).map((o) => ({
      id: o.id,
      status: o.status,
      content: o.content,
      enabled: o.enabled,
      propertyId: o.propertyId,
    })),
  }));
}

async function buildFaqHits(
  prisma: PrismaClient,
  tenantId: string,
  propertyId: string | null,
  ragContext: Record<string, unknown> | null
): Promise<EvidenceBundle['faqHits']> {
  // Preferred: ragContext has `faqHitIds` recorded by the tool loop. Fall
  // back to `faqCategories` + scoped lookup if only categories were logged.
  const hitIds = Array.isArray(ragContext?.faqHitIds)
    ? (ragContext!.faqHitIds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (hitIds.length > 0) {
    const rows = await prisma.faqEntry.findMany({
      where: { id: { in: hitIds }, tenantId },
      select: {
        id: true,
        question: true,
        answer: true,
        category: true,
        scope: true,
        propertyId: true,
        status: true,
      },
    });
    return rows;
  }
  const faqCategories = Array.isArray(ragContext?.faqCategories)
    ? (ragContext!.faqCategories as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  if (faqCategories.length === 0) return [];
  const rows = await prisma.faqEntry.findMany({
    where: {
      tenantId,
      category: { in: faqCategories },
      status: 'ACTIVE',
      OR: [{ scope: 'GLOBAL' }, ...(propertyId ? [{ propertyId }] : [])],
    },
    take: 40,
    select: {
      id: true,
      question: true,
      answer: true,
      category: true,
      scope: true,
      propertyId: true,
      status: true,
    },
  });
  return rows;
}

function buildBranchTags(reservationStatus: string, ragContext: Record<string, unknown> | null): string[] {
  const tags: string[] = [];
  if (reservationStatus === 'INQUIRY' || reservationStatus === 'PENDING') tags.push('persona:screening');
  else tags.push('persona:coordinator');
  if (ragContext?.hasImage) tags.push('input:has-image');
  if (ragContext?.memorySummarized) tags.push('context:memory-summarized');
  if (Array.isArray(ragContext?.sopCategories) && (ragContext!.sopCategories as unknown[]).length > 0) {
    tags.push(`sop:${(ragContext!.sopCategories as unknown[]).join('+')}`);
  }
  return tags;
}

async function fetchLangfuseTrace(
  triggerEvent: EvidenceTriggerEvent,
  sessionId: string | null
): Promise<{ trace: unknown | null; ref: EvidenceBundle['langfuseTraceRef'] }> {
  const ref: EvidenceBundle['langfuseTraceRef'] = {
    sessionId: sessionId ?? '',
    messageIdHint: triggerEvent.messageId ?? null,
    traceId: triggerEvent.langfuseTraceId ?? null,
    fetched: false,
    error: null,
  };
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    ref.error = 'LANGFUSE_KEYS_MISSING';
    return { trace: null, ref };
  }
  try {
    const client = new Langfuse({
      publicKey: LANGFUSE_PUBLIC_KEY,
      secretKey: LANGFUSE_SECRET_KEY,
      baseUrl: LANGFUSE_HOST || 'https://cloud.langfuse.com',
    });
    if (triggerEvent.langfuseTraceId) {
      const got = await (client.api as any).traceGet(triggerEvent.langfuseTraceId);
      ref.fetched = true;
      return { trace: got, ref };
    }
    if (sessionId) {
      // Search traces by sessionId; optionally filter by metadata.messageId.
      const list = await (client.api as any).traceList({ sessionId, limit: 50 });
      const traces: any[] = Array.isArray(list?.data) ? list.data : [];
      const match = triggerEvent.messageId
        ? traces.find((t) => {
            const md = (t?.metadata as Record<string, unknown> | undefined) ?? {};
            return md.messageId === triggerEvent.messageId;
          }) ?? traces[0] ?? null
        : traces[0] ?? null;
      if (match) {
        ref.traceId = match.id ?? null;
        ref.fetched = true;
        return { trace: match, ref };
      }
      ref.error = 'NO_MATCHING_TRACE';
      return { trace: null, ref };
    }
    ref.error = 'NO_LOOKUP_KEY';
    return { trace: null, ref };
  } catch (err) {
    ref.error = err instanceof Error ? err.message : String(err);
    return { trace: null, ref };
  }
}
