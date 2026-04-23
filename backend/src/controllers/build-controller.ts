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
  writeCrossSessionRejection,
  type RejectionIntent,
} from '../build-tune-agent/memory/service';
import {
  isBuildTraceViewEnabled,
  isRawPromptEditorEnabled,
} from '../build-tune-agent/config';
import { listToolCalls } from '../services/build-tool-call-log.service';
import {
  getBuildArtifact,
  getBuildArtifactPrevBody,
  getToolArtifactPrevJson,
  type BuildArtifactType,
} from '../services/build-artifact.service';
import {
  applyArtifactUpdate,
  type ApplyArtifactType,
} from '../build-tune-agent/lib/artifact-apply';

/**
 * Sprint 053-A D4 — convert a stored prev-body JSON shape back into the
 * per-type apply body. CREATE rows have null prevBody so are rejected
 * upstream; this function handles only non-null bodies.
 */
function buildRevertBody(
  artifactType: string,
  prevBody: unknown,
): Record<string, unknown> | null {
  if (!prevBody || typeof prevBody !== 'object') return null;
  const p = prevBody as Record<string, unknown>;
  switch (artifactType) {
    case 'sop':
    case 'property_override':
      return typeof p.content === 'string' ? { content: p.content } : null;
    case 'faq':
      return {
        ...(typeof p.question === 'string' ? { question: p.question } : {}),
        ...(typeof p.answer === 'string' ? { answer: p.answer } : {}),
      };
    case 'system_prompt':
      return typeof p.text === 'string' ? { text: p.text } : null;
    case 'tool_definition':
      return {
        ...(typeof p.description === 'string' ? { description: p.description } : {}),
        ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
        ...(typeof p.webhookUrl === 'string' ? { webhookUrl: p.webhookUrl } : {}),
        ...(typeof p.webhookTimeout === 'number' ? { webhookTimeout: p.webhookTimeout } : {}),
        ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      };
    default:
      return null;
  }
}
/**
 * Sprint 058-A F3 — mirror of `buildRevertBody` but reading from the
 * `newBody` JSON blob (the body that row applied). `newBody` is the
 * same shape the `/apply` endpoint accepts, so this mostly passes
 * fields through while guarding against bad stored payloads.
 */
function buildRevertBodyFromNew(
  artifactType: string,
  newBody: unknown,
): Record<string, unknown> | null {
  if (!newBody || typeof newBody !== 'object') return null;
  const p = newBody as Record<string, unknown>;
  switch (artifactType) {
    case 'sop':
    case 'property_override':
      return typeof p.content === 'string' ? { content: p.content } : null;
    case 'faq':
      return {
        ...(typeof p.question === 'string' ? { question: p.question } : {}),
        ...(typeof p.answer === 'string' ? { answer: p.answer } : {}),
      };
    case 'system_prompt':
      return typeof p.text === 'string' ? { text: p.text } : null;
    case 'tool_definition':
    case 'tool':
      return {
        ...(typeof p.description === 'string' ? { description: p.description } : {}),
        ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
        ...(typeof p.webhookUrl === 'string' ? { webhookUrl: p.webhookUrl } : {}),
        ...(typeof p.webhookTimeout === 'number' ? { webhookTimeout: p.webhookTimeout } : {}),
        ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      };
    default:
      return null;
  }
}
import {
  assembleSystemPromptRegions,
  type AgentMode,
  type SystemPromptContext,
} from '../build-tune-agent/system-prompt';
import { listMemoryByPrefix } from '../build-tune-agent/memory/service';
import { composeSpanHandler, type ComposeSpanRateLimiter } from '../build-tune-agent/compose-span';
import {
  enhancePromptDraft,
  checkEnhanceRateLimit,
  type RateLimitBucket as EnhanceRateLimitBucket,
} from '../services/enhance-prompt.service';
import { SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT } from '../services/ai.service';

// Sprint 056-A F1 — in-memory rate limiter keyed by conversationId or tenantId.
// Window = 60s, limit = 10 requests. Shared across all requests to this process.
const composeSpanRateLimiter: ComposeSpanRateLimiter = new Map();

// Sprint 058-A F8 — same-process enhance-prompt rate limiter. 20 req/min
// keyed by conversationId (or tenantId if none in scope).
const enhancePromptRateLimiter = new Map<string, EnhanceRateLimitBucket>();

/**
 * Bugfix (2026-04-23): the BUILD agent's `<tenant_state>` block was
 * hard-coded to `systemPromptStatus: 'EMPTY'` at both call sites below,
 * which caused the Studio agent to reason as though every tenant had
 * zero system prompt (screenshot: "currently EMPTY per the tenant
 * state"). This helper reads the actual TenantAiConfig and reports:
 *
 *   - EMPTY       — coordinator + screening both null/whitespace. For
 *                   real tenants this is impossible after the
 *                   auto-seed in tenant-config.service.ts L60, but we
 *                   keep the branch for defence-in-depth.
 *   - DEFAULT     — coordinator matches SEED_COORDINATOR_PROMPT
 *                   verbatim (or matches it with the template-variable
 *                   migration block appended). The tenant hasn't
 *                   edited it yet.
 *   - CUSTOMISED  — coordinator diverges from the seed. Operator has
 *                   made edits or wrote their own prompt.
 *
 * `systemPromptVersion` starts at 0 (fresh seed), bumps to 1 on the
 * legacy template-variable migration, and keeps incrementing on each
 * save. We report version directly as `editCount` — imperfect but
 * monotonic and useful signal for the agent.
 */
function computeSystemPromptStatus(cfg: {
  systemPromptCoordinator: string | null;
  systemPromptScreening: string | null;
  systemPromptVersion: number;
} | null): { status: 'EMPTY' | 'DEFAULT' | 'CUSTOMISED'; editCount: number } {
  const coord = (cfg?.systemPromptCoordinator ?? '').trim();
  const screen = (cfg?.systemPromptScreening ?? '').trim();
  const editCount = cfg?.systemPromptVersion ?? 0;
  if (!coord && !screen) return { status: 'EMPTY', editCount };
  const seedCoord = SEED_COORDINATOR_PROMPT.trim();
  const seedScreen = SEED_SCREENING_PROMPT.trim();
  const coordIsSeed = coord === seedCoord || coord.startsWith(seedCoord);
  const screenIsSeed = !screen || screen === seedScreen || screen.startsWith(seedScreen);
  if (coordIsSeed && screenIsSeed) return { status: 'DEFAULT', editCount };
  return { status: 'CUSTOMISED', editCount };
}

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
      const rawPromptEditorEnabled = isRawPromptEditorEnabled();
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
      res.json({ traceViewEnabled, rawPromptEditorEnabled, isAdmin });
    },

    /**
     * GET /api/build/system-prompt — admin-only read-through of the
     * three system-prompt regions for a given conversation.
     *
     * Gated twice, mirroring /traces:
     *   1. ENABLE_RAW_PROMPT_EDITOR env flag → 404 when off (don't leak
     *      the endpoint's existence).
     *   2. Tenant.isAdmin === true → 403 otherwise.
     *
     * Query params:
     *   conversationId  (required) — the Studio conversation we're
     *                   rendering the prompt for.
     *   mode            (optional) — 'BUILD' (default) | 'TUNE'. Drives
     *                   which mode addendum and which dynamic suffix
     *                   blocks get included.
     *
     * Sprint 047 Session C ships read-through only. The edit path lands
     * in a later session; the same gates will reuse this route.
     */
    async getSystemPrompt(
      req: AuthenticatedRequest,
      res: Response
    ): Promise<void> {
      if (!isRawPromptEditorEnabled()) {
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
        const conversationId = q.conversationId ? String(q.conversationId) : null;
        if (!conversationId) {
          res.status(400).json({ error: 'MISSING_CONVERSATION_ID' });
          return;
        }
        const rawMode = q.mode ? String(q.mode).toUpperCase() : 'BUILD';
        const mode: AgentMode =
          rawMode === 'TUNE' ? 'TUNE' : 'BUILD';

        // Tenant-scope the conversation before building the prompt.
        const conv = await prisma.tuningConversation.findFirst({
          where: { id: conversationId, tenantId: req.tenantId },
          select: { id: true, anchorMessageId: true },
        });
        if (!conv) {
          res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
          return;
        }

        // Mirror the runtime's prompt-context assembly, minus anything
        // that would require running an agent turn. The dynamic suffix
        // is therefore best-effort: a missing tenant-state / interview-
        // progress block falls back to null rather than 500-ing.
        const [memory, pending, pendingTotal, tenantState, interviewProgress, aiCfg] =
          await Promise.all([
            listMemoryByPrefix(prisma, req.tenantId, 'preferences/', 30),
            prisma.tuningSuggestion.findMany({
              where: { tenantId: req.tenantId, status: 'PENDING' },
              orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
              take: 10,
              select: {
                id: true,
                diagnosticCategory: true,
                diagnosticSubLabel: true,
                confidence: true,
                rationale: true,
                createdAt: true,
              },
            }),
            prisma.tuningSuggestion.count({
              where: { tenantId: req.tenantId, status: 'PENDING' },
            }),
            getTenantStateSummary(prisma, req.tenantId).catch(() => null),
            getInterviewProgressSummary(
              prisma,
              req.tenantId,
              conversationId
            ).catch(() => null),
            // Bugfix (2026-04-23): pull the tenant's actual system prompt
            // state so <tenant_state> reports the truth instead of the
            // hard-coded 'EMPTY'/0 values that used to live below.
            prisma.tenantAiConfig
              .findUnique({
                where: { tenantId: req.tenantId },
                select: {
                  systemPromptCoordinator: true,
                  systemPromptScreening: true,
                  systemPromptVersion: true,
                },
              })
              .catch(() => null),
          ]);
        const spStatus = computeSystemPromptStatus(aiCfg);

        const countsByCategory = pending.reduce<Record<string, number>>(
          (acc, s) => {
            const k = s.diagnosticCategory ?? 'LEGACY';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
          },
          {}
        );

        const runtimeTenantState = tenantState
          ? {
              posture: (tenantState.isGreenfield
                ? 'GREENFIELD'
                : 'BROWNFIELD') as 'GREENFIELD' | 'BROWNFIELD',
              systemPromptStatus: spStatus.status,
              systemPromptEditCount: spStatus.editCount,
              sopsDefined: tenantState.sopCount,
              sopsDefaulted: 0,
              faqsGlobal: tenantState.faqCounts.global,
              faqsPropertyScoped: tenantState.faqCounts.perProperty,
              customToolsDefined: tenantState.customToolCount,
              propertiesImported: tenantState.propertyCount,
              lastBuildSessionAt:
                tenantState.lastBuildTransaction?.createdAt ?? null,
            }
          : null;

        const runtimeInterviewProgress = interviewProgress
          ? {
              loadBearingFilled: interviewProgress.loadBearingFilled,
              loadBearingTotal: 6,
              nonLoadBearingFilled:
                interviewProgress.filledSlots.length -
                interviewProgress.loadBearingFilled,
              nonLoadBearingTotal: 14,
              defaultedSlots: [] as string[],
            }
          : null;

        const ctx: SystemPromptContext = {
          tenantId: req.tenantId,
          conversationId,
          anchorMessageId: conv.anchorMessageId ?? null,
          selectedSuggestionId: null,
          memorySnapshot: memory,
          pending: {
            total: pendingTotal,
            countsByCategory,
            topThree: pending.slice(0, 3).map((s) => ({
              id: s.id,
              diagnosticCategory: s.diagnosticCategory,
              diagnosticSubLabel: s.diagnosticSubLabel,
              confidence: s.confidence,
              rationale: s.rationale,
              createdAt: s.createdAt.toISOString(),
            })),
          },
          mode,
          tenantState: runtimeTenantState,
          interviewProgress: runtimeInterviewProgress,
        };

        const regions = assembleSystemPromptRegions(ctx);
        res.json({
          mode,
          conversationId,
          regions: {
            shared: regions.sharedPrefix,
            modeAddendum: regions.modeAddendum,
            dynamic: regions.dynamicSuffix,
          },
          assembled: regions.assembled,
          /** Byte-count per region — cheap proxy for token cost. */
          bytes: {
            shared: Buffer.byteLength(regions.sharedPrefix, 'utf8'),
            modeAddendum: Buffer.byteLength(regions.modeAddendum, 'utf8'),
            dynamic: Buffer.byteLength(regions.dynamicSuffix, 'utf8'),
            total: Buffer.byteLength(regions.assembled, 'utf8'),
          },
        });
      } catch (err) {
        console.error('[build-controller] getSystemPrompt failed:', err);
        res.status(500).json({ error: 'SYSTEM_PROMPT_FAILED' });
      }
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
      const [tenantState, interviewProgress, aiCfg] = await Promise.all([
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
        // Bugfix (2026-04-23): read the real system-prompt state so the
        // BUILD agent's <tenant_state> block stops reporting EMPTY on a
        // seeded tenant. Falls back to null on error — the helper
        // returns a sane EMPTY default in that case, preserving the
        // previous degrade-to-null contract.
        prisma.tenantAiConfig
          .findUnique({
            where: { tenantId },
            select: {
              systemPromptCoordinator: true,
              systemPromptScreening: true,
              systemPromptVersion: true,
            },
          })
          .catch((err) => {
            console.warn('[build-controller] tenant-ai-config read failed:', err);
            return null;
          }),
      ]);
      const spStatus = computeSystemPromptStatus(aiCfg);

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
            systemPromptStatus: spStatus.status,
            systemPromptEditCount: spStatus.editCount,
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
          artifact?:
            | 'system_prompt'
            | 'sop'
            | 'faq'
            | 'tool_definition'
            | 'property_override';
          artifactId?: string;
          sectionId?: string;
          slotKey?: string;
        };
        category?: string;
        subLabel?: string;
        // Sprint 047 Session C — cross-session rejection memory. Optional
        // rationale from the manager (if/when the reject card grows a
        // free-text field). Stored on RejectionMemory.rationale so the
        // propose_suggestion precheck can tell the agent *why*.
        rationale?: string;
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

        // Sprint 047 Session C — durable parallel write. Best-effort:
        // missing cross-session memory must not block the session-scoped
        // write, per NEXT.md §3 ("missing memory ≠ no-suggestion").
        const artifact = body.target?.artifact ?? '';
        try {
          await writeCrossSessionRejection(prisma, tenantId, {
            artifact,
            fixHash,
            intent,
            category: body.intent?.category ?? body.category ?? null,
            subLabel: body.intent?.subLabel ?? body.subLabel ?? null,
            rationale: body.rationale ?? null,
            sourceConversationId: conversationId,
          });
        } catch (crossErr) {
          console.warn(
            '[build-controller] cross-session rejection write failed (continuing):',
            crossErr
          );
        }

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

    /**
     * Sprint 051 A B1 — GET /api/build/artifact/:type/:id.
     *
     * Viewer-only read-seam for the Studio artifact drawer. Tenant-
     * scoped; a cross-tenant or missing id returns 404 with a typed
     * body the drawer renders as a "missing artifact" banner.
     *
     * Query params:
     *   prevSince   (optional, ISO) — when present, the response also
     *               carries `prevBody` (oldest SopVariantHistory /
     *               FaqEntryHistory row whose editedAt ≥ prevSince).
     *               Backs B2's "View changes" toggle.
     */
    async getArtifact(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      const type = (req.params.type ?? '') as BuildArtifactType;
      const id = req.params.id ? String(req.params.id) : '';
      const validTypes: BuildArtifactType[] = [
        'sop',
        'faq',
        'system_prompt',
        'tool',
        'property_override',
      ];
      if (!validTypes.includes(type)) {
        res.status(400).json({ error: 'INVALID_ARTIFACT_TYPE' });
        return;
      }
      if (!id) {
        res.status(400).json({ error: 'MISSING_ARTIFACT_ID' });
        return;
      }
      try {
        const result = await getBuildArtifact(prisma, req.tenantId, type, id);
        if ('notFound' in result) {
          res.status(404).json({ error: 'ARTIFACT_NOT_FOUND', type, id });
          return;
        }
        const prevSince = req.query?.prevSince
          ? String(req.query.prevSince)
          : null;
        if (!prevSince) {
          res.json(result);
          return;
        }
        const prev = await getBuildArtifactPrevBody(
          prisma,
          req.tenantId,
          type,
          id,
          prevSince,
        );
        // Sprint 053-A D2 — tool artifacts now carry prev JSON fields sourced
        // from the BuildArtifactHistory table (unlocks the 052-A diff toggle).
        let toolPrev: Awaited<ReturnType<typeof getToolArtifactPrevJson>> = null;
        if (type === 'tool') {
          toolPrev = await getToolArtifactPrevJson(
            prisma,
            req.tenantId,
            id,
            prevSince,
          );
        }
        res.json({
          ...result,
          prevBody: prev.prevBody,
          prevReason: prev.reason ?? null,
          ...(toolPrev ?? {}),
        });
      } catch (err) {
        console.error('[build-controller] getArtifact failed:', err);
        res.status(500).json({ error: 'ARTIFACT_READ_FAILED' });
      }
    },

    /**
     * Sprint 053-A D4 — GET /api/build/artifacts/history
     *
     * Admin-only. Returns recent BuildArtifactHistory rows, session-scoped
     * when `?conversationId=` is passed. Tenant isolation is enforced via
     * `req.tenantId`: a tenant-A user passing a tenant-B conversationId
     * receives an empty `rows` array, not an error.
     *
     * Query params:
     *   conversationId (optional) — scope rows to one BUILD session.
     *   limit          (optional, 1-50, default 10) — row cap.
     */
    async listArtifactHistory(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      if (!isRawPromptEditorEnabled()) {
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
        const conversationId =
          typeof q.conversationId === 'string' ? q.conversationId : null;
        // Bugfix (2026-04-22): the previous endpoint accepted no
        // artifact-scoped filters, so the Versions tab in the drawer
        // had to pull a wide page (limit:50) and filter client-side.
        // On a busy tenant the last 50 rows could be dominated by
        // unrelated artifacts and the tab rendered empty for an
        // artifact that DID have history. Accept artifactType +
        // artifactId as optional server-side filters.
        const artifactType =
          typeof q.artifactType === 'string' ? q.artifactType : null;
        const artifactId =
          typeof q.artifactId === 'string' ? q.artifactId : null;
        const rawLimit =
          typeof q.limit === 'string' ? parseInt(q.limit, 10) : 10;
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(50, rawLimit))
          : 10;
        const rows = await prisma.buildArtifactHistory.findMany({
          where: {
            tenantId: req.tenantId,
            ...(conversationId ? { conversationId } : {}),
            ...(artifactType
              ? artifactType === 'tool'
                // Match the frontend convention: drawer renders
                // tool_definition rows under the 'tool' label.
                ? { artifactType: { in: ['tool', 'tool_definition'] } }
                : { artifactType }
              : {}),
            ...(artifactId ? { artifactId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            artifactType: true,
            artifactId: true,
            operation: true,
            actorEmail: true,
            conversationId: true,
            createdAt: true,
            prevBody: true,
            newBody: true,
            metadata: true,
            // Sprint 058-A F6 — version labels surface in the Versions tab + ledger.
            versionLabel: true,
          },
        });
        res.json({
          rows: rows.map((r) => ({
            ...r,
            createdAt: r.createdAt.toISOString(),
          })),
        });
      } catch (err) {
        console.error('[build-controller] listArtifactHistory failed:', err);
        res.status(500).json({ error: 'HISTORY_READ_FAILED' });
      }
    },

    /**
     * Sprint 053-A D4 — POST /api/build/artifacts/history/:historyId/revert
     *
     * Admin-only. Reads the named history row's prevBody and applies it
     * as the artifact's new content. dryRun:true returns a preview
     * without writing. dryRun:false performs the revert AND writes a new
     * BuildArtifactHistory row with operation:"REVERT" and
     * metadata.revertsHistoryId.
     *
     * CREATE rows cannot be reverted via this endpoint (that would be a
     * DELETE, explicitly parked for 054-A).
     */
    async revertArtifactFromHistory(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      if (!isRawPromptEditorEnabled()) {
        res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.tenantId },
          select: { isAdmin: true, email: true },
        });
        if (!tenant?.isAdmin) {
          res.status(403).json({ error: 'ADMIN_ONLY' });
          return;
        }
        const historyId = String(req.params.historyId ?? '');
        const row = await prisma.buildArtifactHistory.findFirst({
          where: { id: historyId, tenantId: req.tenantId },
        });
        if (!row) {
          res.status(404).json({ error: 'HISTORY_NOT_FOUND' });
          return;
        }
        if (row.operation === 'CREATE') {
          res.status(422).json({
            ok: false,
            error: 'CANNOT_REVERT_CREATE',
          });
          return;
        }
        if (row.prevBody == null) {
          res.status(422).json({
            ok: false,
            error: 'NO_PREV_BODY',
          });
          return;
        }
        const b = req.body ?? {};
        const dryRun = Boolean(b.dryRun);
        const body = buildRevertBody(row.artifactType, row.prevBody);
        if (!body) {
          res.status(422).json({
            ok: false,
            error: 'UNREVERTABLE_TYPE',
            artifactType: row.artifactType,
          });
          return;
        }
        // Map stored artifactType to applyArtifact's ApplyArtifactType
        // (tool_definition → tool for the apply executor).
        const applyType: ApplyArtifactType =
          row.artifactType === 'tool_definition'
            ? 'tool'
            : (row.artifactType as ApplyArtifactType);
        const result = await applyArtifactUpdate(prisma, {
          tenantId: req.tenantId,
          type: applyType,
          id: row.artifactId,
          dryRun,
          body,
          actorUserId: (req as any).userId ?? null,
          actorEmail: tenant.email ?? null,
          conversationId: row.conversationId,
        });
        if (!result.ok) {
          res.status(422).json(result);
          return;
        }
        // On non-dry-run success, stamp the most recent history row for
        // this artifact with REVERT operation + metadata.revertsHistoryId.
        // applyArtifactUpdate already wrote a row (UPDATE op); we update
        // it in-place to REVERT so consumers see a revert-of-N as a
        // single row rather than a stray UPDATE.
        if (!dryRun) {
          const mostRecent = await prisma.buildArtifactHistory.findFirst({
            where: {
              tenantId: req.tenantId,
              artifactType: row.artifactType,
              artifactId: row.artifactId,
            },
            orderBy: { createdAt: 'desc' },
          });
          if (mostRecent && mostRecent.id !== row.id) {
            // Bugfix (2026-04-22): the previous version replaced the
            // metadata object outright, destroying every prior key
            // (rationale, buildTransactionId, testResult ritual variants,
            // version, operator-edit provenance). Spread the existing
            // metadata so revertsHistoryId is added without dropping
            // anything else. The other revert-write paths (rollback
            // tool, version-history endpoint) already preserve metadata
            // — this controller path was the odd one out.
            const existingMeta =
              mostRecent.metadata && typeof mostRecent.metadata === 'object'
                && !Array.isArray(mostRecent.metadata)
                ? (mostRecent.metadata as Record<string, unknown>)
                : {};
            await prisma.buildArtifactHistory.update({
              where: { id: mostRecent.id },
              data: {
                operation: 'REVERT',
                metadata: {
                  ...existingMeta,
                  revertsHistoryId: row.id,
                },
              },
            }).catch((err) => {
              console.error('[build] revert stamp failed (logged):', err);
            });
          }
        }
        res.json(result);
      } catch (err) {
        console.error('[build-controller] revertArtifact failed:', err);
        res.status(500).json({ error: 'REVERT_FAILED' });
      }
    },

    /**
     * Sprint 056-A F1 — POST /api/build/compose-span
     *
     * Non-streaming. Accepts a text selection + instruction, returns a
     * proposed replacement string scoped to the selection span only.
     * Uses a restricted agent query with allowedTools: [] and maxTurns: 1.
     *
     * Rate limit: 10/min per conversationId (or tenantId fallback).
     * Tenant-scope: artifactId must belong to the calling tenant.
     */
    async composeSpan(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      await composeSpanHandler(
        req,
        res,
        prisma,
        composeSpanRateLimiter,
      );
    },

    /**
     * Sprint 053-A D3 — POST /api/build/artifacts/:type/:id/apply
     *
     * Admin-only, gated twice (same posture as the raw-prompt editor):
     *   1. ENABLE_RAW_PROMPT_EDITOR env flag → 404 when off.
     *   2. Tenant.isAdmin === true → 403 otherwise.
     *
     * Body: { dryRun: boolean, body: <per-type payload> }.
     * dryRun:true → returns { ok, dryRun: true, preview, diff }, no writes.
     * dryRun:false → updates the artifact + emits a history row + returns
     * { ok, dryRun: false, artifactType, artifactId }.
     *
     * Dispatches to the same artifact-apply executor that the drawer's
     * Preview button targets — single source of truth for UPDATE writes.
     */
    async applyArtifact(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      if (!isRawPromptEditorEnabled()) {
        res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.tenantId },
          select: { isAdmin: true, email: true },
        });
        if (!tenant?.isAdmin) {
          res.status(403).json({ error: 'ADMIN_ONLY' });
          return;
        }
        const rawType = String(req.params.type ?? '') as ApplyArtifactType;
        const id = String(req.params.id ?? '');
        const validTypes: ApplyArtifactType[] = [
          'sop',
          'faq',
          'system_prompt',
          'tool',
          'property_override',
        ];
        if (!validTypes.includes(rawType)) {
          res.status(400).json({ error: 'INVALID_ARTIFACT_TYPE' });
          return;
        }
        if (!id) {
          res.status(400).json({ error: 'MISSING_ARTIFACT_ID' });
          return;
        }
        const b = req.body ?? {};
        const dryRun = Boolean(b.dryRun);
        const body =
          b.body && typeof b.body === 'object' && !Array.isArray(b.body)
            ? (b.body as Record<string, unknown>)
            : {};
        const conversationId =
          typeof b.conversationId === 'string' ? b.conversationId : null;
        // Sprint 055-A F3 — thread operator-edit metadata through to history row.
        const metadata =
          b.metadata && typeof b.metadata === 'object' && !Array.isArray(b.metadata)
            ? (b.metadata as Record<string, unknown>)
            : null;
        const result = await applyArtifactUpdate(prisma, {
          tenantId: req.tenantId,
          type: rawType,
          id,
          dryRun,
          body,
          actorUserId: (req as any).userId ?? null,
          actorEmail: tenant.email ?? null,
          conversationId,
          metadata,
        });
        if (!result.ok) {
          res.status(422).json(result);
          return;
        }
        res.json(result);
      } catch (err) {
        console.error('[build-controller] applyArtifact failed:', err);
        res.status(500).json({ error: 'ARTIFACT_APPLY_FAILED' });
      }
    },

    /**
     * Sprint 058-A F8 — POST /api/build/enhance-prompt
     *
     * Body: { draft: string, conversationId?: string }
     *
     * Runs the composer draft through GPT-5-Nano for clarity/concision
     * rewriting (preserves facts, max 3 sentences, no added scope). Non-
     * streaming. Tenant-scoped via JWT; rate-limited in-process at 20
     * requests per 60 seconds per conversation (or per tenant if no
     * conversationId is provided).
     *
     * On Nano failure / missing API key, returns 200 with `{ ok: false,
     * reason }` so the Studio can render a calm "couldn't enhance" toast
     * rather than an error banner.
     */
    async enhancePrompt(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const body = req.body ?? {};
        const draft = typeof body.draft === 'string' ? body.draft : '';
        const conversationId =
          typeof body.conversationId === 'string' && body.conversationId.length > 0
            ? body.conversationId
            : null;

        const rateKey = conversationId
          ? `conv:${req.tenantId}:${conversationId}`
          : `tenant:${req.tenantId}`;
        const rate = checkEnhanceRateLimit(enhancePromptRateLimiter, rateKey);
        if (!rate.ok) {
          res.setHeader(
            'Retry-After',
            String(Math.ceil(rate.retryAfterMs / 1000)),
          );
          res
            .status(429)
            .json({ ok: false, reason: 'rate_limited', retryAfterMs: rate.retryAfterMs });
          return;
        }

        if (conversationId) {
          const owned = await prisma.tuningConversation.findFirst({
            where: { id: conversationId, tenantId: req.tenantId },
            select: { id: true },
          });
          if (!owned) {
            res.status(404).json({ ok: false, reason: 'CONVERSATION_NOT_FOUND' });
            return;
          }
        }

        const result = await enhancePromptDraft(draft);
        res.json(result);
      } catch (err) {
        console.error('[build-controller] enhancePrompt failed:', err);
        res.status(500).json({ ok: false, reason: 'server_error' });
      }
    },

    /**
     * Sprint 058-A F9d — GET /api/build/sessions/:conversationId/artifacts
     *
     * Session-artifacts hydration endpoint. Returns every
     * BuildArtifactHistory row attached to the given conversation so the
     * Studio's session-artifacts rail can seed itself on page reload.
     */
    async sessionArtifacts(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      try {
        const conversationId = String(req.params.conversationId ?? '');
        if (!conversationId) {
          res.status(400).json({ error: 'MISSING_CONVERSATION_ID' });
          return;
        }
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.tenantId },
          select: { isAdmin: true },
        });
        if (!tenant?.isAdmin) {
          res.status(403).json({ error: 'ADMIN_ONLY' });
          return;
        }

        const rows = await prisma.buildArtifactHistory.findMany({
          where: { tenantId: req.tenantId, conversationId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            artifactType: true,
            artifactId: true,
            operation: true,
            actorEmail: true,
            conversationId: true,
            createdAt: true,
            metadata: true,
          },
        });

        res.json({
          rows: rows.map((r) => ({
            historyId: r.id,
            artifactType: r.artifactType,
            artifactId: r.artifactId,
            operation: r.operation,
            actorEmail: r.actorEmail,
            conversationId: r.conversationId,
            touchedAt: r.createdAt.toISOString(),
            metadata: r.metadata,
          })),
        });
      } catch (err) {
        console.error('[build-controller] sessionArtifacts failed:', err);
        res.status(500).json({ error: 'SESSION_ARTIFACTS_FAILED' });
      }
    },

    /**
     * Sprint 058-A F3 — POST /api/build/history/:id/revert-to
     *
     * Arbitrary-version revert. Given a target `BuildArtifactHistory` row,
     * restore the artifact to the state that row represented — i.e. use
     * `newBody` (the body the row applied). Writes through the same apply
     * layer as the 053-A D4 `/revert` endpoint so sanitiser + history row
     * generation stays single-sourced. The new history row carries
     * `metadata.revertedToHistoryId` so downstream consumers can chain
     * the lineage.
     *
     * Tenant-scoped. Admin-only. Rejects targets belonging to a different
     * artifact than the caller intends (not applicable here — the target
     * row is resolved by id, which already carries its artifactType +
     * artifactId). Returns 404 when the row isn't visible to the caller.
     */
    async revertToVersion(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      if (!isRawPromptEditorEnabled()) {
        res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: req.tenantId },
          select: { isAdmin: true, email: true },
        });
        if (!tenant?.isAdmin) {
          res.status(403).json({ error: 'ADMIN_ONLY' });
          return;
        }
        const historyId = String(req.params.id ?? '');
        if (!historyId) {
          res.status(400).json({ error: 'MISSING_HISTORY_ID' });
          return;
        }
        const row = await prisma.buildArtifactHistory.findFirst({
          where: { id: historyId, tenantId: req.tenantId },
        });
        if (!row) {
          res.status(404).json({ error: 'HISTORY_NOT_FOUND' });
          return;
        }
        if (row.newBody == null) {
          res.status(422).json({ ok: false, error: 'NO_NEW_BODY' });
          return;
        }
        const dryRun = Boolean((req.body ?? {}).dryRun);
        const body = buildRevertBodyFromNew(row.artifactType, row.newBody);
        if (!body) {
          res.status(422).json({
            ok: false,
            error: 'UNREVERTABLE_TYPE',
            artifactType: row.artifactType,
          });
          return;
        }
        const applyType: ApplyArtifactType =
          row.artifactType === 'tool_definition'
            ? 'tool'
            : (row.artifactType as ApplyArtifactType);
        const result = await applyArtifactUpdate(prisma, {
          tenantId: req.tenantId,
          type: applyType,
          id: row.artifactId,
          dryRun,
          body,
          actorUserId: (req as any).userId ?? null,
          actorEmail: tenant.email ?? null,
          conversationId: row.conversationId,
          metadata: { revertedToHistoryId: row.id },
        });
        if (!result.ok) {
          res.status(422).json(result);
          return;
        }
        // On non-dry-run, stamp the newly-written row as REVERT so the
        // ledger reads "Reverted to <target>" rather than a stray UPDATE.
        if (!dryRun) {
          const mostRecent = await prisma.buildArtifactHistory.findFirst({
            where: {
              tenantId: req.tenantId,
              artifactType: row.artifactType,
              artifactId: row.artifactId,
            },
            orderBy: { createdAt: 'desc' },
          });
          if (mostRecent && mostRecent.id !== row.id) {
            await prisma.buildArtifactHistory
              .update({
                where: { id: mostRecent.id },
                data: {
                  operation: 'REVERT',
                  metadata: { revertedToHistoryId: row.id },
                },
              })
              .catch((err) => {
                console.error('[build] revertToVersion stamp failed (logged):', err);
              });
          }
        }
        res.json(result);
      } catch (err) {
        console.error('[build-controller] revertToVersion failed:', err);
        res.status(500).json({ error: 'REVERT_TO_FAILED' });
      }
    },

    /**
     * Sprint 058-A F6 — POST /api/build/history/:id/tag
     *
     * Attach a short human-readable version label to a history row. Used
     * by the Versions tab (F3) so operators can tag a row as "stable" or
     * "before-early-checkin-rework" and revert to it by name later.
     *
     * Validation: label is 1–40 chars of [A-Za-z0-9_-]. Tenant-scoped.
     */
    async tagHistoryRow(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      try {
        const historyId = String(req.params.id ?? '');
        if (!historyId) {
          res.status(400).json({ error: 'MISSING_HISTORY_ID' });
          return;
        }
        const rawLabel = (req.body ?? {}).label;
        const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
        if (!label) {
          res.status(400).json({ error: 'MISSING_LABEL' });
          return;
        }
        if (label.length > 40) {
          res.status(400).json({ error: 'LABEL_TOO_LONG', max: 40 });
          return;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(label)) {
          res.status(400).json({ error: 'INVALID_LABEL_CHARSET' });
          return;
        }
        const row = await prisma.buildArtifactHistory.findFirst({
          where: { id: historyId, tenantId: req.tenantId },
          select: { id: true },
        });
        if (!row) {
          res.status(404).json({ error: 'HISTORY_NOT_FOUND' });
          return;
        }
        const updated = await prisma.buildArtifactHistory.update({
          where: { id: historyId },
          data: { versionLabel: label },
          select: {
            id: true,
            versionLabel: true,
            artifactType: true,
            artifactId: true,
          },
        });
        res.json({ ok: true, row: updated });
      } catch (err) {
        console.error('[build-controller] tagHistoryRow failed:', err);
        res.status(500).json({ error: 'TAG_FAILED' });
      }
    },

    /**
     * Sprint 058-A F6 — DELETE /api/build/history/:id/tag
     *
     * Clear the versionLabel on a history row. Tenant-scoped. Idempotent
     * on rows that weren't tagged — the response shape is the same.
     */
    async untagHistoryRow(
      req: AuthenticatedRequest,
      res: Response,
    ): Promise<void> {
      try {
        const historyId = String(req.params.id ?? '');
        if (!historyId) {
          res.status(400).json({ error: 'MISSING_HISTORY_ID' });
          return;
        }
        const row = await prisma.buildArtifactHistory.findFirst({
          where: { id: historyId, tenantId: req.tenantId },
          select: { id: true },
        });
        if (!row) {
          res.status(404).json({ error: 'HISTORY_NOT_FOUND' });
          return;
        }
        const updated = await prisma.buildArtifactHistory.update({
          where: { id: historyId },
          data: { versionLabel: null },
          select: {
            id: true,
            versionLabel: true,
            artifactType: true,
            artifactId: true,
          },
        });
        res.json({ ok: true, row: updated });
      } catch (err) {
        console.error('[build-controller] untagHistoryRow failed:', err);
        res.status(500).json({ error: 'UNTAG_FAILED' });
      }
    },

    // ─── Sprint 058-A F2 — cancel a pending plan item ───────────────────────
    /**
     * POST /api/build/plan-items/:transactionId/cancel
     * Body: { index: number }
     *
     * Advisory: writes `index` into `BuildTransaction.cancelledItemIndexes`.
     * The agent's next `create_*` tool-call pre-flight reads this array and
     * returns `{ ok: false, reason: 'plan_item_cancelled' }` for a matching
     * index (tool-layer hook lands separately). Does NOT kill an in-flight
     * write. Tenant-scoped. Idempotent.
     */
    async cancelPlanItem(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const transactionId = req.params.transactionId;
      if (!transactionId) {
        res.status(400).json({ error: 'MISSING_TRANSACTION_ID' });
        return;
      }
      const rawIndex = (req.body ?? {}).index;
      const index =
        typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0
          ? rawIndex
          : null;
      if (index === null) {
        res.status(400).json({ error: 'MISSING_OR_INVALID_INDEX' });
        return;
      }
      try {
        const tx = await prisma.buildTransaction.findFirst({
          where: { id: transactionId, tenantId },
          select: {
            id: true,
            status: true,
            plannedItems: true,
            cancelledItemIndexes: true,
          },
        });
        if (!tx) {
          res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
          return;
        }
        const items = Array.isArray(tx.plannedItems) ? (tx.plannedItems as unknown[]) : [];
        if (index >= items.length) {
          res.status(400).json({ error: 'INDEX_OUT_OF_RANGE' });
          return;
        }
        if (
          tx.status === 'COMPLETED' ||
          tx.status === 'PARTIAL' ||
          tx.status === 'ROLLED_BACK'
        ) {
          res.status(200).json({ ok: true, alreadyExecuting: true, index });
          return;
        }
        const existing: number[] = Array.isArray(tx.cancelledItemIndexes)
          ? (tx.cancelledItemIndexes as number[])
          : [];
        if (existing.includes(index)) {
          res.status(200).json({ ok: true, index, alreadyCancelled: true });
          return;
        }
        const nextList = [...existing, index];
        await prisma.buildTransaction.update({
          where: { id: tx.id },
          data: { cancelledItemIndexes: nextList },
        });
        res.status(200).json({ ok: true, index, cancelledItemIndexes: nextList });
      } catch (err) {
        console.error('[build-controller] cancelPlanItem failed:', err);
        res.status(500).json({ error: 'CANCEL_PLAN_ITEM_FAILED' });
      }
    },
  };
}
