'use client'

// Sprint 045 (Gate 6) — fetch client for /api/build/*. Mirrors lib/api.ts'
// shape so the /build page has the same auth + error story as /tuning.
//
// All endpoints are 404'd server-side when ENABLE_BUILD_MODE is unset; the
// page uses that 404 to render a "not enabled" screen.
//
// Refinement pass (sprint 045 § E1) — every mutation helper exposes a
// toast wrapper (withToast) that surfaces failures as Sonner toasts
// instead of console noise. 404s on tenant-state are deliberately NOT
// toasted because that 404 signals the disabled-screen path, not an
// error.

import { toast } from 'sonner'
import { getToken, ApiError } from './api'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'

export interface BuildLastTransaction {
  id: string
  status: string
  createdAt: string
  completedAt: string | null
  approvedAt: string | null
  approvedByUserId: string | null
  itemCount: number
}

export interface BuildTenantState {
  sopCount: number
  faqCounts: { global: number; perProperty: number }
  customToolCount: number
  propertyCount: number
  isGreenfield: boolean
  lastBuildTransaction?: BuildLastTransaction
}

export class BuildModeDisabledError extends Error {
  constructor() {
    super('BUILD_MODE_DISABLED')
    this.name = 'BuildModeDisabledError'
  }
}

async function buildFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  if (res.status === 404) {
    // Route family is gated by ENABLE_BUILD_MODE — 404 lands before auth,
    // so an unauthenticated probe can't distinguish the gate from a real
    // missing route. Surface as a typed error and let the page render the
    // "not enabled" screen.
    throw new BuildModeDisabledError()
  }
  if (res.status === 401) {
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new ApiError('Unauthorized', 401)
  }
  let data: any
  try {
    data = await res.json()
  } catch {
    if (!res.ok) throw new ApiError(`Request failed: ${res.status}`, res.status)
    throw new ApiError('Invalid JSON response', res.status)
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed: ${res.status}`, res.status, data)
  }
  return data as T
}

/**
 * Wrap a /api/build/* fetch with a toast on failure. Skips 404
 * (BuildModeDisabledError) so the disabled-screen path stays silent.
 */
export async function withBuildToast<T>(
  label: string,
  task: () => Promise<T>,
  options: { retry?: () => void } = {},
): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (err instanceof BuildModeDisabledError) throw err
    const message = friendlyMessage(err)
    if (options.retry) {
      toast.error(label, {
        description: message,
        action: { label: 'Retry', onClick: options.retry },
      })
    } else {
      toast.error(label, { description: message })
    }
    throw err
  }
}

function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status >= 500) return 'The server returned an error. Please try again or contact support.'
    if (typeof err.message === 'string' && err.message.length > 0) return err.message
    return `Request failed (${err.status})`
  }
  if (err instanceof Error && err.message) return err.message
  return 'Please try again or contact support.'
}

export async function apiGetBuildTenantState(): Promise<BuildTenantState> {
  return buildFetch<BuildTenantState>('/api/build/tenant-state')
}

export interface ApprovePlanResponse {
  id: string
  status: string
  approvedAt: string
  approvedByUserId: string | null
  alreadyApproved: boolean
}

export async function apiApproveBuildPlan(transactionId: string): Promise<ApprovePlanResponse> {
  return buildFetch<ApprovePlanResponse>(`/api/build/plan/${transactionId}/approve`, {
    method: 'POST',
    body: '{}',
  })
}

export interface RollbackPlanResponse {
  ok?: boolean
  transactionId?: string
  reverted?: {
    sop: number
    faq: number
    tool: number
    systemPrompt: number
  }
  [k: string]: unknown
}

export async function apiRollbackBuildPlan(transactionId: string): Promise<RollbackPlanResponse> {
  return buildFetch<RollbackPlanResponse>(`/api/build/plan/${transactionId}/rollback`, {
    method: 'POST',
    body: '{}',
  })
}

export function buildTurnEndpoint(): string {
  return `${BASE_URL}/api/build/turn`
}

// ─── Sprint 047 Session B — capabilities + trace view ──────────────────────

export interface BuildCapabilities {
  traceViewEnabled: boolean
  // Sprint 047 Session C — admin-only raw-prompt editor drawer flag.
  // Optional on the wire for back-compat with a pre-C backend (falls
  // back to `false` if the field is absent).
  rawPromptEditorEnabled?: boolean
  isAdmin: boolean
}

export async function apiGetBuildCapabilities(): Promise<BuildCapabilities> {
  return buildFetch<BuildCapabilities>('/api/build/capabilities')
}

export interface BuildTraceRow {
  id: string
  conversationId: string
  turn: number
  tool: string
  paramsHash: string
  durationMs: number
  success: boolean
  errorMessage: string | null
  createdAt: string
}

export interface BuildTracePage {
  rows: BuildTraceRow[]
  nextCursor: string | null
}

export interface ListBuildTracesOptions {
  conversationId?: string
  tool?: string
  turn?: number
  cursor?: string | null
  limit?: number
}

export async function apiListBuildTraces(
  opts: ListBuildTracesOptions = {},
): Promise<BuildTracePage> {
  const qs = new URLSearchParams()
  if (opts.conversationId) qs.set('conversationId', opts.conversationId)
  if (opts.tool) qs.set('tool', opts.tool)
  if (typeof opts.turn === 'number') qs.set('turn', String(opts.turn))
  if (opts.cursor) qs.set('cursor', opts.cursor)
  if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return buildFetch<BuildTracePage>(`/api/build/traces${suffix}`)
}

// ─── Sprint 047 Session C — raw-prompt editor read-through ────────────────

export type BuildAgentMode = 'BUILD' | 'TUNE'

export interface BuildSystemPromptRegions {
  shared: string
  modeAddendum: string
  dynamic: string
}

export interface BuildSystemPromptResponse {
  mode: BuildAgentMode
  conversationId: string
  regions: BuildSystemPromptRegions
  assembled: string
  bytes: {
    shared: number
    modeAddendum: number
    dynamic: number
    total: number
  }
}

export async function apiGetBuildSystemPrompt(
  conversationId: string,
  mode: BuildAgentMode = 'BUILD',
): Promise<BuildSystemPromptResponse> {
  const qs = new URLSearchParams({ conversationId, mode })
  return buildFetch<BuildSystemPromptResponse>(
    `/api/build/system-prompt?${qs.toString()}`,
  )
}

export interface SuggestedFixActionResponse {
  ok: boolean
  applied: boolean
  alreadyApplied?: boolean
  appliedVia?: 'suggestion_action' | 'no-op-stub' | 'rejection-memory'
  suggestionId?: string
  appliedAt?: string | null
  message?: string
  fixHash?: string
  target?: { kind: string; id: string }
}

// Sprint 047 Session A — accept endpoint can now persist ephemeral
// preview:* ids. Callers pass the full data-suggested-fix payload when
// the id is ephemeral; the backend uses the `preview:*` prefix to tell
// the two cases apart.
export interface AcceptSuggestedFixPayload {
  conversationId: string
  category?: string
  subLabel?: string
  rationale?: string
  before?: string
  after?: string
  target?: {
    artifactId?: string
    sectionId?: string
    slotKey?: string
    sopCategory?: string
    sopStatus?: 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN'
    sopPropertyId?: string
    faqEntryId?: string
    systemPromptVariant?: 'coordinator' | 'screening'
  }
}

export async function apiAcceptSuggestedFix(
  fixId: string,
  payload?: AcceptSuggestedFixPayload,
): Promise<SuggestedFixActionResponse> {
  return buildFetch<SuggestedFixActionResponse>(
    `/api/build/suggested-fix/${encodeURIComponent(fixId)}/accept`,
    {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    },
  )
}

// Sprint 046 Session D — reject endpoint now persists a session-scoped
// rejection-memory row. Callers must pass enough of the suggested-fix
// payload to derive the fix hash. The backend accepts either an explicit
// `intent` or the convenience `(target, category, subLabel)` trio.
//
// Sprint 047 Session C — the same POST now ALSO writes a durable
// RejectionMemory row keyed on (tenantId, target.artifact, fixHash).
// `target.artifact` is the canonical FixTarget artifact type string.
// `rationale` is an optional manager-provided reason surfaced back to
// the agent on future proposals within the 90d TTL.
export interface RejectSuggestedFixPayload {
  conversationId: string
  category?: string
  subLabel?: string
  target?: {
    artifact?:
      | 'system_prompt'
      | 'sop'
      | 'faq'
      | 'tool_definition'
      | 'property_override'
    artifactId?: string
    sectionId?: string
    slotKey?: string
  }
  rationale?: string
}

export async function apiRejectSuggestedFix(
  fixId: string,
  payload: RejectSuggestedFixPayload,
): Promise<SuggestedFixActionResponse> {
  return buildFetch<SuggestedFixActionResponse>(
    `/api/build/suggested-fix/${encodeURIComponent(fixId)}/reject`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

// ─── SSE part data shapes ──────────────────────────────────────────────────
// Mirrors the payload shapes emitted by the Gate 2/3 tools. Kept here (not
// imported from backend) so the frontend can stay typed without pulling in
// the Prisma / Claude-SDK transitive graph.

export interface BuildPlanItemTarget {
  artifactId?: string
  sectionId?: string
  slotKey?: string
  lineRange?: [number, number]
}

export interface BuildPlanItem {
  type: 'sop' | 'faq' | 'system_prompt' | 'tool_definition'
  name: string
  rationale: string
  // Sprint 046 Session B — optional plan-item enrichments.
  target?: BuildPlanItemTarget
  previewDiff?: { before: string; after: string }
}

export interface BuildPlanData {
  ok: boolean
  transactionId: string
  plannedAt: string
  approvalRequired: boolean
  uiHint: string
  items: BuildPlanItem[]
  rationale: string
}

export interface TestPipelineResultData {
  ok: boolean
  reply: string
  judgeScore: number
  judgeRationale: string
  judgeFailureCategory?: string | null
  judgePromptVersion: string
  judgeModel: string
  replyModel: string
  latencyMs: number
}
