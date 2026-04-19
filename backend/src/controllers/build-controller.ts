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
import type { ToolContext } from '../build-tune-agent/tools/types';
import {
  getTenantStateSummary,
  getInterviewProgressSummary,
} from '../services/tenant-state.service';

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
