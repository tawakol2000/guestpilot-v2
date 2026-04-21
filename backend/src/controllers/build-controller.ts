/**
 * Build-mode controller (sprint 045, Gate 5).
 *
 * Four endpoints, all behind JWT auth + the ENABLE_BUILD_MODE env gate
 * (gate enforcement lives in `routes/build.ts`, not here):
 *
 *   GET  /api/build/tenant-state         → TenantStateSummary (spec §9)
 *   POST /api/build/turn                 → SSE stream from runTuningAgentTurn
 *   POST /api/build/plan/:id/approve     → record approvedByUserId + approvedAt
 *   POST /api/build/plan/:id/rollback    → invoke rollback tool with transactionId
 *
 * Approve is intentionally a thin record: the BuildTransaction status
 * remains PLANNED; create_* tools call validateBuildTransaction which
 * flips it to EXECUTING on first artifact write. Approve only adds the
 * audit fields so the frontend / future audit reports can see who
 * sanctioned the plan and when.
 *
 * Rollback delegates to the existing rollback tool (built once per
 * request via the same stub-tool pattern used in the integration
 * tests). This keeps the rollback logic single-sourced — controller
 * and agent share exactly the same code path.
 */
import { Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from 'ai';
import crypto from 'crypto';
import { AuthenticatedRequest } from '../types';
import { runTuningAgentTurn } from '../build-tune-agent';
import { buildRollbackTool } from '../build-tune-agent/tools/version-history';
import {
  buildSuggestionActionTool,
} from '../build-tune-agent/tools/suggestion-action';
import {
  applyArtifactChangeFromUi,
  type ApplyFromUiInput,
} from '../build-tune-agent/tools/suggestion-action';
import type { ToolContext } from '../build-tune-agent/tools/types';
import {
  getTenantStateSummary,
  getInterviewProgressSummary,
} from '../services/tenant-state.service';
import {
  computeRejectionFixHash,
  writeRejectionMemory,
  type RejectionIntent,
} from '../build-tune-agent/memory/service';
import { isBuildTraceViewEnabled } from '../build-tune-agent/config';
import { listToolCalls } from '../services/build-tool-call-log.service';

function extractLatestUserText(messages: UIMessage[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return '';
  const parts = (last as any).parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  const content = (last as any).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

export function makeBuildController(prisma: PrismaClient) {
  return {
    /** GET /api/build/tenant-state → spec §9 TenantStateSummary. */
    async tenantState(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      try {
        const summary = await getTenantStateSummary(prisma, tenantId);
        res.json(summary);
      } catch (err) {
        console.error('[build-controller] tenantState failed:', err);
        res.status(500).json({ error: 'TENANT_STATE_FAILED' });
      }
    },

    /**
     * GET /api/build/capabilities — returns admin-only UI toggles for
     * the Studio right-rail. Never 404s; always returns a shape. The
     * frontend uses this to decide whether to render the gear menu
     * trace-drawer entry.
     */
    async capabilities(req: AuthenticatedRequest, res: Response): Promise<void> {
      const traceViewEnabled = isBuildTraceViewEnabled();
      let isAdmin = false;
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.tenantId },
          select: { isAdmin: true },
        });
        isAdmin = Boolean(tenant?.isAdmin);
      } catch (err) {
        console.warn('[build-controller] capabilities lookup failed:', err);
      }
      res.json({ traceViewEnabled, isAdmin });
    },

    /**
     * GET /api/build/traces — admin-only BuildToolCallLog page.
     *
     * Two layers of gating:
     *   1. ENABLE_BUILD_TRACE_VIEW env flag → 404 when off (don't even
     *      signal the endpoint exists).
     *   2. Tenant.isAdmin === true → 403 otherwise.
     *
     * Tenant-scoped. Cursor paginated (id-based). Optional filters on
     * conversationId, tool, turn.
     */
    async listTraces(req: AuthenticatedRequest, res: Response): Promise<void> {
      if (!isBuildTraceViewEnabled()) {
        res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.tenantId },
          select: { isAdmin: true },
        });
        if (!tenant?.isAdmin) {
          res.status(403).json({ error: 'ADMIN_ONLY' });
          return;
        }
        const q = req.query ?? {};
        const limit = q.limit ? parseInt(String(q.limit), 10) : undefined;
        const turn = q.turn ? parseInt(String(q.turn), 10) : undefined;
        const page = await listToolCalls(prisma, {
          tenantId: req.tenantId,
          conversationId: q.conversationId ? String(q.conversationId) : null,
          tool: q.tool ? String(q.tool) : null,
          turn: Number.isFinite(turn) ? (turn as number) : null,
          cursorId: q.cursor ? String(q.cursor) : null,
          limit: Number.isFinite(limit) ? (limit as number) : null,
        });
        res.json({
          rows: page.rows.map((r) => ({
            id: r.id,
            conversationId: r.conversationId,
            turn: r.turn,
            tool: r.tool,
            paramsHash: r.paramsHash,
            durationMs: r.durationMs,
            success: r.success,
            errorMessage: r.errorMessage,
            createdAt: r.createdAt.toISOString(),
          })),
          nextCursor: page.nextCursor,
        });
      } catch (err) {
        console.error('[build-controller] listTraces failed:', err);
        res.status(500).json({ error: 'TRACES_LIST_FAILED' });
      }
    },

    /**
     * POST /api/build/turn — runs a BUILD-mode `runTuningAgentTurn` and
     * streams the SSE response. Body shape mirrors `/api/tuning/chat`
     * (Vercel AI SDK `useChat` payload).
     */
    async turn(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const userId = (req as any).userId ?? null;
      const body = (req.body ?? {}) as {
        messages?: UIMessage[];
        conversationId?: string;
        body?: { conversationId?: string };
      };
      const conversationId =
        body.conversationId ?? body.body?.conversationId;
      if (!conversationId) {
        res.status(400).json({ error: 'MISSING_CONVERSATION_ID' });
        return;
      }
      const userText = extractLatestUserText(body.messages);
      if (!userText) {
        res.status(400).json({ error: 'MISSING_USER_MESSAGE' });
        return;
      }

      // Tenant scoping check on the conversation row before we kick off
      // an agent turn — same rule the tuning-chat controller enforces.
      const conv = await prisma.tuningConversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { id: true },
      });
      if (!conv) {
        res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
        return;
      }

      // Persist incoming user message — same pattern as tuning-chat. We
      // skip on persist failure rather than 500, because BUILD turns
      // can run on a not-yet-persisted conversation and the next turn
      // will still see history via the SDK session id.
      try {
        await prisma.tuningMessage.create({
          data: {
            conversationId,
            role: 'user',
            parts: [{ type: 'text', text: userText }] as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.error('[build-controller] user message persist failed:', err);
        res.status(500).json({ error: 'USER_MESSAGE_PERSIST_FAILED' });
        return;
      }

      // Aggregate tenant state + interview progress before assembling the
      // agent prompt. Failure here degrades to nulls — the agent still
      // runs, but the dynamic suffix omits the tenant-state block.
      const [tenantState, interviewProgress] = await Promise.all([
        getTenantStateSummary(prisma, tenantId).catch((err) => {
          console.warn('[build-controller] tenant-state aggregate failed:', err);
          return null;
        }),
        getInterviewProgressSummary(prisma, tenantId, conversationId).catch(
          (err) => {
            console.warn('[build-controller] interview-progress aggregate failed:', err);
            return null;
          }
        ),
      ]);

      // Adapt tenant-state.service.TenantStateSummary → the runtime's
      // SystemPromptContext.tenantState shape. The two were defined
      // independently (service speaks API shape, runtime speaks
      // dynamic-suffix shape) — kept separate so neither leaks fields
      // into the other layer.
      const runtimeTenantState = tenantState
        ? {
            posture: (tenantState.isGreenfield ? 'GREENFIELD' : 'BROWNFIELD') as
              | 'GREENFIELD'
              | 'BROWNFIELD',
            systemPromptStatus: 'EMPTY' as 'EMPTY' | 'DEFAULT' | 'CUSTOMISED',
            systemPromptEditCount: 0,
            sopsDefined: tenantState.sopCount,
            sopsDefaulted: 0,
            faqsGlobal: tenantState.faqCounts.global,
            faqsPropertyScoped: tenantState.faqCounts.perProperty,
            customToolsDefined: tenantState.customToolCount,
            propertiesImported: tenantState.propertyCount,
            lastBuildSessionAt: tenantState.lastBuildTransaction?.createdAt ?? null,
          }
        : null;

      const runtimeInterviewProgress = interviewProgress
        ? {
            loadBearingFilled: interviewProgress.loadBearingFilled,
            loadBearingTotal: 6,
            nonLoadBearingFilled:
              interviewProgress.filledSlots.length - interviewProgress.loadBearingFilled,
            nonLoadBearingTotal: 14,
            defaultedSlots: [] as string[],
          }
        : null;

      const assistantMessageId = `asst:${crypto.randomBytes(8).toString('hex')}`;
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          await runTuningAgentTurn({
            prisma,
            tenantId,
            userId,
            conversationId,
            userMessage: userText,
            selectedSuggestionId: null,
            assistantMessageId,
            writer,
            mode: 'BUILD',
            tenantState: runtimeTenantState,
            interviewProgress: runtimeInterviewProgress,
          });
        },
        onFinish: async (event) => {
          try {
            const responseMessage: any = event.responseMessage;
            const parts: unknown[] = Array.isArray(responseMessage?.parts)
              ? responseMessage.parts
              : [];
            const persistableParts = parts.filter(
              (p: any) => !p || p.transient !== true
            );
            await prisma.tuningMessage.create({
              data: {
                conversationId,
                role: 'assistant',
                parts: persistableParts as unknown as Prisma.InputJsonValue,
              },
            });
            await prisma.tuningConversation.update({
              where: { id: conversationId },
              data: { updatedAt: new Date() },
            });
          } catch (err) {
            console.warn('[build-controller] assistant persist failed:', err);
          }
        },
        onError: (err) => {
          const errorText = err instanceof Error ? err.message : String(err);
          console.error('[build-controller] stream error:', errorText);
          return errorText;
        },
      });

      pipeUIMessageStreamToResponse({ response: res, stream });
    },

    /**
     * POST /api/build/plan/:id/approve — record approvedByUserId +
     * approvedAt on the BuildTransaction row. Idempotent: re-approving
     * an already-approved plan returns 200 with the existing fields, no
     * overwrite. Tenant-scoped via the existing where clause.
     */
    async approvePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const userId = (req as any).userId ?? null;
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'MISSING_PLAN_ID' });
        return;
      }
      try {
        const tx = await prisma.buildTransaction.findFirst({
          where: { id, tenantId },
          select: {
            id: true,
            status: true,
            approvedAt: true,
            approvedByUserId: true,
          },
        });
        if (!tx) {
          res.status(404).json({ error: 'PLAN_NOT_FOUND' });
          return;
        }
        if (tx.approvedAt) {
          // Idempotent — already approved.
          res.json({
            id: tx.id,
            status: tx.status,
            approvedAt: tx.approvedAt.toISOString(),
            approvedByUserId: tx.approvedByUserId,
            alreadyApproved: true,
          });
          return;
        }
        const updated = await prisma.buildTransaction.update({
          where: { id },
          data: {
            approvedAt: new Date(),
            approvedByUserId: userId,
          },
          select: {
            id: true,
            status: true,
            approvedAt: true,
            approvedByUserId: true,
          },
        });
        res.json({
          id: updated.id,
          status: updated.status,
          approvedAt: updated.approvedAt!.toISOString(),
          approvedByUserId: updated.approvedByUserId,
          alreadyApproved: false,
        });
      } catch (err) {
        console.error('[build-controller] approvePlan failed:', err);
        res.status(500).json({ error: 'APPROVE_FAILED' });
      }
    },

    /**
     * POST /api/build/suggested-fix/:fixId/accept — (sprint 047 Session A)
     *
     * Two cases, same endpoint:
     *   - Case A: `fixId` matches a TuningSuggestion row the agent persisted
     *     (legacy TUNE flow). Dispatch into `suggestion_action({action:'apply'})`
     *     directly via the stub-tool pattern — the manager's UI click is
     *     the compliance signal, so the PreToolUse hook is deliberately
     *     bypassed.
     *   - Case B: `fixId` is a `preview:*` ephemeral id emitted by
     *     `propose_suggestion`. No DB row exists yet. The POST body must
     *     carry the payload needed to execute the write (target, before,
     *     after, category, rationale, conversationId). Dispatch into
     *     `applyArtifactChangeFromUi` which persists an ACCEPTED
     *     TuningSuggestion row + executes the artifact write atomically.
     *
     * Idempotent: re-posting the same fixId after a flaky network
     * returns 200 without double-applying.
     */
    async acceptSuggestedFix(
      req: AuthenticatedRequest,
      res: Response
    ): Promise<void> {
      const { tenantId } = req;
      const userId = (req as any).userId ?? null;
      const fixId = req.params.fixId;
      if (!fixId) {
        res.status(400).json({ error: 'MISSING_FIX_ID' });
        return;
      }

      const isPreviewId = fixId.startsWith('preview:');
      const body = (req.body ?? {}) as {
        conversationId?: string;
        target?: ApplyFromUiInput['target'] & Record<string, unknown>;
        before?: string;
        after?: string;
        category?: string;
        subLabel?: string;
        rationale?: string;
      };

      // Case A — existing TuningSuggestion row.
      if (!isPreviewId) {
        try {
          const hit = await prisma.tuningSuggestion.findFirst({
            where: { id: fixId, tenantId },
            select: { id: true, status: true, appliedAt: true },
          });
          if (!hit) {
            res.status(404).json({ error: 'FIX_NOT_FOUND' });
            return;
          }
          // Idempotent re-click on an already-applied row.
          if (hit.status === 'ACCEPTED') {
            res.json({
              ok: true,
              applied: true,
              alreadyApplied: true,
              appliedVia: 'suggestion_action',
              suggestionId: hit.id,
              appliedAt: hit.appliedAt?.toISOString() ?? null,
            });
            return;
          }
          if (hit.status !== 'PENDING' && hit.status !== 'AUTO_SUPPRESSED') {
            res.status(409).json({
              error: 'FIX_NOT_APPLICABLE',
              status: hit.status,
            });
            return;
          }
          // Stub-tool dispatch — same pattern as rollbackPlan.
          let captured: any = null;
          function stubTool(_name: string, _desc: string, _schema: any, handler: any) {
            captured = handler;
            return { name: _name, handler };
          }
          const ctx: ToolContext = {
            prisma,
            tenantId,
            conversationId: body.conversationId ?? null,
            userId,
            lastUserSanctionedApply: true,
          };
          buildSuggestionActionTool(stubTool as any, () => ctx);
          if (!captured) {
            res.status(500).json({ error: 'SUGGESTION_ACTION_TOOL_NOT_REGISTERED' });
            return;
          }
          const result = await captured({ suggestionId: fixId, action: 'apply' });
          if (result?.isError) {
            const message = result.content?.[0]?.text ?? 'apply failed';
            res.status(500).json({ error: message });
            return;
          }
          const payload = result?.structuredContent ?? {};
          res.json({
            ok: true,
            applied: true,
            alreadyApplied: false,
            appliedVia: 'suggestion_action',
            suggestionId: payload.suggestionId ?? fixId,
            target: payload.target,
          });
          return;
        } catch (err) {
          console.error('[build-controller] acceptSuggestedFix (case A) failed:', err);
          res.status(500).json({ error: 'ACCEPT_FAILED' });
          return;
        }
      }

      // Case B — ephemeral `preview:*` id. Validate body + dispatch.
      const conversationId = body.conversationId;
      if (!conversationId) {
        res.status(400).json({ error: 'MISSING_CONVERSATION_ID' });
        return;
      }
      if (typeof body.after !== 'string' || body.after.length === 0) {
        res.status(400).json({ error: 'MISSING_AFTER_TEXT' });
        return;
      }
      const category = body.category;
      if (
        category !== 'SOP_CONTENT' &&
        category !== 'SOP_ROUTING' &&
        category !== 'FAQ' &&
        category !== 'SYSTEM_PROMPT' &&
        category !== 'TOOL_CONFIG' &&
        category !== 'PROPERTY_OVERRIDE'
      ) {
        res.status(400).json({ error: 'INVALID_CATEGORY', category });
        return;
      }

      try {
        // Tenant scoping on the conversation before we commit a write.
        const conv = await prisma.tuningConversation.findFirst({
          where: { id: conversationId, tenantId },
          select: { id: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }
        const result = await applyArtifactChangeFromUi({
          prisma,
          tenantId,
          userId,
          conversationId,
          previewId: fixId,
          sanctionedBy: 'ui',
          category,
          subLabel: body.subLabel,
          rationale: body.rationale ?? '(accepted from Studio UI)',
          before: body.before ?? '',
          after: body.after,
          target: {
            sopCategory: body.target?.sopCategory,
            sopStatus: body.target?.sopStatus,
            sopPropertyId: body.target?.sopPropertyId,
            faqEntryId: body.target?.faqEntryId,
            systemPromptVariant: body.target?.systemPromptVariant,
          },
        });
        res.json({
          ok: true,
          applied: true,
          alreadyApplied: result.alreadyApplied,
          appliedVia: 'suggestion_action',
          suggestionId: result.suggestionId,
          appliedAt: result.appliedAt.toISOString(),
          target: result.target,
        });
      } catch (err: any) {
        console.error('[build-controller] acceptSuggestedFix (case B) failed:', err);
        res.status(500).json({ error: err?.message ?? 'ACCEPT_FAILED' });
      }
    },

    /**
     * POST /api/build/suggested-fix/:fixId/reject — (sprint 046 Session D)
     *
     * Writes a session-scoped rejection-memory row under
     * `session/{conversationId}/rejected/{fixHash}` so a subsequent
     * propose_suggestion in the same conversation skips re-proposing a
     * semantically-equivalent fix (plan §4.4). Body must carry the fix
     * intent (artifactId / sectionId|slotKey / category / subLabel) —
     * the frontend card already has these on hand from the
     * `data-suggested-fix` payload it rendered.
     */
    async rejectSuggestedFix(
      req: AuthenticatedRequest,
      res: Response
    ): Promise<void> {
      const { tenantId } = req;
      const fixId = req.params.fixId;
      if (!fixId) {
        res.status(400).json({ error: 'MISSING_FIX_ID' });
        return;
      }
      const body = (req.body ?? {}) as {
        conversationId?: string;
        intent?: Partial<RejectionIntent> & {
          category?: string;
          subLabel?: string;
        };
        target?: {
          artifactId?: string;
          sectionId?: string;
          slotKey?: string;
        };
        category?: string;
        subLabel?: string;
      };
      const conversationId = body.conversationId;
      if (!conversationId) {
        res.status(400).json({ error: 'MISSING_CONVERSATION_ID' });
        return;
      }

      // Derive a RejectionIntent from whatever shape the client sent.
      // Prefer an explicit intent block, fall back to (target, category,
      // subLabel) which are always on the data-suggested-fix payload.
      const artifactId =
        body.intent?.artifactId ??
        body.target?.artifactId ??
        '';
      const sectionOrSlot =
        body.intent?.sectionOrSlotKey ??
        body.target?.sectionId ??
        body.target?.slotKey ??
        '';
      const category = body.intent?.semanticIntent
        ? undefined
        : body.category ?? body.intent?.category ?? '';
      const subLabel = body.subLabel ?? body.intent?.subLabel ?? '';
      const semanticIntent =
        body.intent?.semanticIntent ?? `${category ?? ''}:${subLabel}`;

      const intent: RejectionIntent = {
        artifactId,
        sectionOrSlotKey: sectionOrSlot,
        semanticIntent,
      };
      const fixHash = computeRejectionFixHash(intent);

      try {
        // Tenant scoping — the conversation must belong to this tenant.
        const conv = await prisma.tuningConversation.findFirst({
          where: { id: conversationId, tenantId },
          select: { id: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }
        await writeRejectionMemory(
          prisma,
          tenantId,
          conversationId,
          fixHash,
          intent
        );
        res.json({
          ok: true,
          applied: false,
          appliedVia: 'rejection-memory',
          fixHash,
          message:
            'Rejection persisted — propose_suggestion in this conversation will skip this fix.',
        });
      } catch (err) {
        console.error('[build-controller] rejectSuggestedFix failed:', err);
        res.status(500).json({ error: 'REJECT_FAILED' });
      }
    },

    /**
     * POST /api/build/plan/:id/rollback — call the rollback tool with
     * transactionId directly. Bypasses the agent because this is a
     * user-triggered action (a button click in the /build UI), not an
     * agent decision. Reuses the rollback tool's transaction-mode path
     * verbatim so the rollback logic stays single-sourced.
     */
    async rollbackPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const userId = (req as any).userId ?? null;
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'MISSING_PLAN_ID' });
        return;
      }
      // Stub `tool()` that captures the handler so we can call it directly
      // without spinning the SDK. Same pattern as
      // src/__tests__/integration/suggestion-action.integration.test.ts.
      let captured: any = null;
      function stubTool(_name: string, _desc: string, _schema: any, handler: any) {
        captured = handler;
        return { name: _name, handler };
      }
      const ctx: ToolContext = {
        prisma,
        tenantId,
        conversationId: null,
        userId,
        lastUserSanctionedApply: false,
      };
      buildRollbackTool(stubTool as any, () => ctx);
      if (!captured) {
        res.status(500).json({ error: 'ROLLBACK_TOOL_NOT_REGISTERED' });
        return;
      }
      try {
        const result = await captured({ transactionId: id });
        // The tool returns { content, structuredContent? } or { content, isError }.
        if (result?.isError) {
          // Pull the human-readable error out of the text content block.
          const message = result.content?.[0]?.text ?? 'rollback failed';
          // 404 if the transaction wasn't found; 409 for already-rolled-back;
          // 500 for anything else. Cheap string sniff matches the tool's
          // own `asError` lines.
          if (/not found/i.test(message)) {
            res.status(404).json({ error: message });
          } else if (/already rolled back/i.test(message)) {
            res.status(409).json({ error: message });
          } else {
            res.status(500).json({ error: message });
          }
          return;
        }
        res.json(result?.structuredContent ?? { ok: true });
      } catch (err: any) {
        console.error('[build-controller] rollbackPlan failed:', err);
        res.status(500).json({ error: err?.message ?? 'ROLLBACK_FAILED' });
      }
    },
  };
}
