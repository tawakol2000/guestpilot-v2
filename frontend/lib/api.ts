'use client'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'

// ─── Auth token helpers ────────────────────────────────────────────────────────
export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('gp_token')
}

export function setToken(token: string) {
  localStorage.setItem('gp_token', token)
}

export function clearToken() {
  localStorage.removeItem('gp_token')
  localStorage.removeItem('gp_tenant')
}

export function getTenantMeta(): { email: string; plan: string; tenantId: string; webhookUrl?: string } | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('gp_tenant')
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function setTenantMeta(meta: object) {
  localStorage.setItem('gp_tenant', JSON.stringify(meta))
}

export function isAuthenticated(): boolean {
  return !!getToken()
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })

  if (res.status === 401) {
    clearToken()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`)
  return data as T
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface AuthResponse {
  token: string
  tenantId: string
  email: string
  plan: string
  webhookUrl: string
  webhookSecret?: string
}

export async function apiLogin(email: string, password: string): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function apiSignup(
  email: string,
  password: string,
  hostawayApiKey: string,
  hostawayAccountId: string
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, hostawayApiKey, hostawayAccountId }),
  })
}

export async function apiChangePassword(newPassword: string): Promise<{ ok: boolean }> {
  return apiFetch('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  })
}

// ─── Conversations ─────────────────────────────────────────────────────────────
export interface ApiConversationSummary {
  id: string
  guestName: string
  propertyName: string
  channel: string
  aiEnabled: boolean
  aiMode: string
  unreadCount: number
  starred?: boolean
  status?: string
  lastMessage: string
  lastMessageRole: 'GUEST' | 'AI' | 'HOST' | null
  lastMessageAt: string
  reservationStatus: string
  checkIn: string
  checkOut: string
  hostawayConversationId: string
}

export interface ApiMessage {
  id: string
  role: 'GUEST' | 'AI' | 'HOST' | 'AI_PRIVATE' | 'MANAGER_PRIVATE'
  content: string
  channel: string
  sentAt: string
  imageUrls?: string[]
  aiMeta?: { sopCategories?: string[]; toolName?: string }
}

export interface ApiConversationDetail {
  id: string
  status: string
  channel: string
  lastMessageAt: string
  hostawayConversationId: string
  guest: {
    id: string
    name: string
    email: string
    phone: string
    nationality: string
  }
  property: {
    id: string
    name: string
    address: string
    customKnowledgeBase: Record<string, unknown>
  }
  reservation: {
    id: string
    checkIn: string
    checkOut: string
    guestCount: number
    channel: string
    status: string
    aiEnabled: boolean
    aiMode: string
  }
  messages: ApiMessage[]
  documentChecklist?: {
    passportsNeeded: number
    passportsReceived: number
    marriageCertNeeded: boolean
    marriageCertReceived: boolean
  } | null
}

export async function apiUpdateConversationChecklist(conversationId: string, data: { passportsReceived?: number; marriageCertReceived?: boolean }): Promise<{ checklist: ApiConversationDetail['documentChecklist'] }> {
  return apiFetch(`/api/conversations/${conversationId}/checklist`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function apiGetConversationSuggestion(conversationId: string): Promise<{ suggestion: string | null }> {
  return apiFetch<{ suggestion: string | null }>(`/api/conversations/${conversationId}/suggestion`)
}

export async function apiGetConversations(): Promise<ApiConversationSummary[]> {
  return apiFetch<ApiConversationSummary[]>('/api/conversations')
}

export async function apiGetConversation(id: string): Promise<ApiConversationDetail> {
  return apiFetch<ApiConversationDetail>(`/api/conversations/${id}`)
}

export async function apiToggleAI(id: string, aiEnabled: boolean): Promise<{ aiEnabled: boolean }> {
  return apiFetch<{ aiEnabled: boolean }>(`/api/conversations/${id}/ai-toggle`, {
    method: 'PATCH',
    body: JSON.stringify({ aiEnabled }),
  })
}

export async function apiToggleAIAll(aiEnabled: boolean): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/conversations/ai-toggle-all', {
    method: 'PATCH',
    body: JSON.stringify({ aiEnabled }),
  })
}

export async function apiToggleAIProperty(propertyId: string, aiMode: 'autopilot' | 'copilot' | 'off'): Promise<{ ok: boolean; updated: number }> {
  return apiFetch<{ ok: boolean; updated: number }>('/api/conversations/ai-toggle-property', {
    method: 'PATCH',
    body: JSON.stringify({ propertyId, aiMode }),
  })
}

export interface PropertyAiStatus {
  id: string
  name: string
  address: string
  aiMode: 'autopilot' | 'copilot' | 'off'
  conversationCount: number
  aiEnabledCount: number
}

export async function apiGetPropertiesAiStatus(): Promise<PropertyAiStatus[]> {
  return apiFetch<PropertyAiStatus[]>('/api/properties/ai-status')
}

export async function apiSendMessage(
  conversationId: string,
  content: string,
  channel?: string
): Promise<ApiMessage> {
  return apiFetch<ApiMessage>(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, channel }),
  })
}

export async function apiSendNote(
  conversationId: string,
  content: string
): Promise<ApiMessage> {
  return apiFetch<ApiMessage>(`/api/conversations/${conversationId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export async function apiToggleStar(conversationId: string, starred: boolean): Promise<{ starred: boolean }> {
  return apiFetch<{ starred: boolean }>(`/api/conversations/${conversationId}/star`, {
    method: 'PATCH',
    body: JSON.stringify({ starred }),
  })
}

export async function apiResolveConversation(conversationId: string, status: 'OPEN' | 'RESOLVED'): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`/api/conversations/${conversationId}/resolve`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

// ─── Properties ────────────────────────────────────────────────────────────────
export interface ApiProperty {
  id: string
  hostawayListingId: string
  name: string
  address: string
  listingDescription: string
  customKnowledgeBase: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export async function apiGetProperties(): Promise<ApiProperty[]> {
  return apiFetch<ApiProperty[]>('/api/properties')
}

export async function apiUpdateKnowledgeBase(
  id: string,
  customKnowledgeBase: Record<string, unknown>
): Promise<{ id: string; customKnowledgeBase: Record<string, unknown> }> {
  return apiFetch(`/api/properties/${id}/knowledge-base`, {
    method: 'PUT',
    body: JSON.stringify({ customKnowledgeBase }),
  })
}

export async function apiSummarizeDescription(id: string): Promise<{ summary: string }> {
  return apiFetch<{ summary: string }>(`/api/properties/${id}/summarize`, { method: 'POST' })
}

export async function apiSummarizeAll(): Promise<{ count: number }> {
  return apiFetch<{ count: number }>('/api/properties/summarize-all', { method: 'POST' })
}

export interface VariablePreview {
  variables: {
    PROPERTY_GUEST_INFO: string
    AVAILABLE_AMENITIES: string
    ON_REQUEST_AMENITIES: string
    DOCUMENT_CHECKLIST: string
  }
}

export async function apiGetVariablePreview(propertyId: string): Promise<VariablePreview> {
  return apiFetch<VariablePreview>(`/api/properties/${propertyId}/variable-preview`)
}

// ─── Import ────────────────────────────────────────────────────────────────────
export interface ImportProgress {
  phase: 'idle' | 'deleting' | 'listings' | 'reservations' | 'messages' | 'done' | 'error'
  total: number
  completed: number
  message: string
  error?: string
  lastSyncedAt: string | null
}

export async function apiRunImport(opts: { listingsOnly?: boolean; conversationsOnly?: boolean; preserveLearnedAnswers?: boolean; preservePropertyChunks?: boolean } | boolean = false): Promise<{ started: boolean }> {
  const o = typeof opts === 'boolean' ? { listingsOnly: opts } : opts
  const qs = new URLSearchParams()
  if (o.listingsOnly) qs.set('listingsOnly', 'true')
  if (o.conversationsOnly) qs.set('conversationsOnly', 'true')
  if (o.preserveLearnedAnswers) qs.set('preserveLearnedAnswers', 'true')
  if (o.preservePropertyChunks) qs.set('preservePropertyChunks', 'true')
  const qsStr = qs.toString()
  return apiFetch<{ started: boolean }>(`/api/import${qsStr ? '?' + qsStr : ''}`, { method: 'POST' })
}

export async function apiGetImportProgress(): Promise<ImportProgress> {
  return apiFetch<ImportProgress>('/api/import/progress')
}

export async function apiDeleteAllData(): Promise<void> {
  await apiFetch<{ deleted: boolean }>('/api/import', { method: 'DELETE' })
}

export interface AiPersonaConfig {
  model: string
  temperature: number
  maxTokens: number
  topK?: number
  topP?: number
  stopSequences?: string[]
  systemPrompt: string
  responseSchema?: string
  contentBlockTemplate?: string
}

export interface AiConfig {
  debounceDelayMs?: number
  messageHistoryCount?: number
  guestCoordinator: AiPersonaConfig
  screeningAI: AiPersonaConfig
  managerTranslator: AiPersonaConfig
  guardrails?: string[]
  escalation?: {
    confidenceThreshold: number
    triggerKeywords: string[]
    maxConsecutiveAiReplies: number
  }
}

export interface AiConfigVersion {
  id: string
  version: number
  config: AiConfig
  note?: string
  createdAt: string
}

export async function apiGetAIConfig(): Promise<AiConfig> {
  return apiFetch<AiConfig>('/api/ai-config')
}

export async function apiUpdateAIConfig(updates: Partial<AiConfig>): Promise<AiConfig> {
  return apiFetch<AiConfig>('/api/ai-config', {
    method: 'PUT',
    body: JSON.stringify(updates),
  })
}

export async function apiGetAiConfigVersions(): Promise<AiConfigVersion[]> {
  return apiFetch<AiConfigVersion[]>('/api/ai-config/versions')
}

export async function apiRevertAiConfigVersion(id: string): Promise<AiConfig> {
  return apiFetch<AiConfig>(`/api/ai-config/versions/${id}/revert`, {
    method: 'POST',
  })
}

export interface TemplateVariableInfo {
  name: string
  description: string
  essential: boolean
  propertyBound: boolean
}

export async function apiGetTemplateVariables(agentType: 'coordinator' | 'screening'): Promise<TemplateVariableInfo[]> {
  return apiFetch<TemplateVariableInfo[]>(`/api/ai-config/template-variables?agent=${agentType}`)
}

export interface PromptHistoryEntry {
  version: number
  timestamp: string
  coordinator?: string
  screening?: string
}

export async function apiGetPromptHistory(): Promise<{ currentVersion: number; history: PromptHistoryEntry[] }> {
  return apiFetch(`/api/ai-config/prompt-history`)
}

export interface TenantAiConfig {
  id: string
  tenantId: string
  agentName: string
  model: string
  temperature: number
  maxTokens: number
  debounceDelayMs: number
  adaptiveDebounce: boolean
  customInstructions: string
  ragEnabled: boolean
  memorySummaryEnabled: boolean
  workingHoursEnabled: boolean
  workingHoursStart: string
  workingHoursEnd: string
  workingHoursTimezone: string
  reasoningCoordinator: string
  reasoningScreening: string
  systemPromptCoordinator: string | null
  systemPromptScreening: string | null
  systemPromptVersion: number
}

export async function apiGetTenantAiConfig(): Promise<TenantAiConfig> {
  return apiFetch<TenantAiConfig>('/api/tenant-config')
}

export async function apiUpdateTenantAiConfig(updates: Partial<Omit<TenantAiConfig, 'id' | 'tenantId'>>): Promise<TenantAiConfig> {
  return apiFetch<TenantAiConfig>('/api/tenant-config', {
    method: 'PUT',
    body: JSON.stringify(updates),
  })
}

export async function apiResetSystemPrompts(): Promise<TenantAiConfig> {
  return apiFetch<TenantAiConfig>('/api/tenant-config/reset-prompts', { method: 'POST' })
}

export async function apiResyncProperty(propertyId: string): Promise<{ ok: boolean; chunks: number; property: ApiProperty }> {
  return apiFetch<{ ok: boolean; chunks: number; property: ApiProperty }>(`/api/properties/${propertyId}/resync`, {
    method: 'POST',
  })
}

export async function apiSendThroughAI(
  conversationId: string,
  content: string,
  channel?: string
): Promise<ApiMessage> {
  return apiFetch<ApiMessage>(`/api/conversations/${conversationId}/messages/translate`, {
    method: 'POST',
    body: JSON.stringify({ content, channel }),
  })
}

// ─── AI Logs ─────────────────────────────────────────────────────────────────
export interface AiApiLogEntry {
  id: string
  timestamp: string
  agentName?: string
  model: string
  temperature?: number
  maxTokens: number
  topK?: number
  topP?: number
  systemPromptPreview: string
  systemPromptFull?: string
  systemPromptLength: number
  contentBlocks: { type: string; textPreview?: string; textLength?: number }[]
  responseText: string
  responseLength: number
  inputTokens: number
  outputTokens: number
  costUsd?: number
  durationMs: number
  conversationId?: string
  error?: string
  ragContext?: {
    query: string
    chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; isGlobal: boolean }>
    totalRetrieved: number
    durationMs: number
    sopToolUsed?: boolean
    sopCategories?: string[]
    sopConfidence?: string
    sopReasoning?: string
    toolUsed?: boolean
    toolName?: string
    toolInput?: any
    toolResults?: any
    toolDurationMs?: number
    cachedInputTokens?: number
    totalInputTokens?: number
    reasoningTokens?: number
    reasoningEffort?: string
    escalationSignals?: string[]
  } | null
}

export interface KnowledgeChunk {
  id: string
  propertyId: string | null
  content: string
  category: string
  sourceKey: string
  createdAt: string
}

export interface AiLogsResponse {
  logs: AiApiLogEntry[]
  total: number
  limit: number
  offset: number
}

export async function apiGetAiLogs(params?: { agent?: string; model?: string; search?: string; limit?: number; offset?: number }): Promise<AiLogsResponse> {
  const qs = new URLSearchParams()
  if (params?.agent) qs.set('agent', params.agent)
  if (params?.model) qs.set('model', params.model)
  if (params?.search) qs.set('search', params.search)
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.offset) qs.set('offset', String(params.offset))
  const qsStr = qs.toString()
  return apiFetch<AiLogsResponse>(`/api/ai-logs${qsStr ? '?' + qsStr : ''}`)
}

export async function apiGetAiLogDetail(id: string): Promise<AiApiLogEntry> {
  return apiFetch<AiApiLogEntry>(`/api/ai-logs/${id}`)
}

export async function apiGetKnowledgeChunks(propertyId?: string): Promise<KnowledgeChunk[]> {
  const qs = propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : ''
  return apiFetch<KnowledgeChunk[]>(`/api/knowledge/chunks${qs}`)
}

export interface ChunkStat {
  sourceKey: string
  hitCount: number
  avgSimilarity: number
  lastSeenAt: string
}

export async function apiGetChunkStats(): Promise<{ stats: ChunkStat[]; logsAnalyzed: number }> {
  return apiFetch('/api/knowledge/chunk-stats')
}

export async function apiTestAiConfig(data: { systemPrompt: string; userMessage: string; model?: string; temperature?: number; maxTokens?: number }): Promise<{ response: string; inputTokens: number; outputTokens: number; durationMs: number; model: string }> {
  return apiFetch('/api/ai-config/test', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// ─── Tasks ───────────────────────────────────────────────────────────────────
export interface ApiTask {
  id: string
  title: string
  note?: string
  urgency: string
  type: string
  status: string
  source: string
  dueDate?: string
  assignee?: string
  createdAt: string
  completedAt?: string
  conversationId?: string
  propertyId?: string
  guestName?: string
  propertyName?: string
}

export async function apiGetConversationTasks(convId: string): Promise<ApiTask[]> {
  return apiFetch<ApiTask[]>(`/api/conversations/${convId}/tasks`)
}

export async function apiUpdateTask(id: string, data: { status: string }): Promise<ApiTask> {
  return apiFetch<ApiTask>(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function apiDeleteTask(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' })
}

// ─── Data transformers ─────────────────────────────────────────────────────────
// Map backend enums → frontend display types

export function mapChannel(ch: string): string {
  if (ch === 'AIRBNB') return 'Airbnb'
  if (ch === 'BOOKING') return 'Booking.com'
  if (ch === 'DIRECT') return 'Direct'
  if (ch === 'WHATSAPP') return 'WhatsApp'
  return ''
}

export function mapMessageSender(role: string): 'guest' | 'autopilot' | 'host' | 'private' {
  if (role === 'GUEST') return 'guest'
  if (role === 'AI') return 'autopilot'
  if (role === 'AI_PRIVATE' || role === 'MANAGER_PRIVATE') return 'private'
  return 'host'
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffDays === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Analytics ────────────────────────────────────────────────────────────────
export interface ApiAnalytics {
  period: { from: string; to: string }
  totals: {
    messagesReceived: number
    messagesSent: number
    aiMessagesSent: number
    aiResolutionRate: number
    avgResponseTimeMs: number
    tasksCreated: number
    tasksCompleted: number
  }
  byDay: Array<{ date: string; messagesReceived: number; messagesSent: number; aiMessagesSent: number }>
  byProperty: Array<{ propertyId: string; propertyName: string; conversations: number; aiMessages: number; hostMessages: number }>
  topUrgencies: Array<{ urgency: string; count: number }>
  responseTimeDistribution?: { under5m: number; under15m: number; under1h: number; under4h: number; over4h: number }
  byChannel?: Array<{ channel: string; received: number; sent: number; ai: number; avgResponseTimeMs: number }>
  peakHoursHeatmap?: number[][]
}

export async function apiGetAnalytics(range: '7d' | '30d' | '90d' = '30d'): Promise<ApiAnalytics> {
  return apiFetch<ApiAnalytics>(`/api/analytics?range=${range}`)
}

// ─── Global Tasks ──────────────────────────────────────────────────────────────
export async function apiCreateGlobalTask(data: { title: string; note?: string; urgency?: string; propertyId?: string; dueDate?: string; assignee?: string }): Promise<ApiTask> {
  return apiFetch<ApiTask>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function apiGetAllTasks(filters?: { status?: string; urgency?: string; propertyId?: string }): Promise<ApiTask[]> {
  const params = new URLSearchParams()
  if (filters?.status) params.set('status', filters.status)
  if (filters?.urgency) params.set('urgency', filters.urgency)
  if (filters?.propertyId) params.set('propertyId', filters.propertyId)
  const qs = params.toString()
  return apiFetch<ApiTask[]>(`/api/tasks${qs ? '?' + qs : ''}`)
}

// ─── Templates ─────────────────────────────────────────────────────────────────
export interface ApiMessageTemplate {
  id: string
  hostawayId?: string
  name: string
  body: string
  enhancedBody?: string
  triggerType?: string
  triggerOffset?: number
  isEnabled: boolean
  updatedAt: string
}

export async function apiGetTemplates(): Promise<ApiMessageTemplate[]> {
  return apiFetch<ApiMessageTemplate[]>('/api/templates')
}

export async function apiUpdateTemplate(id: string, data: { body?: string; enhancedBody?: string }): Promise<ApiMessageTemplate> {
  return apiFetch<ApiMessageTemplate>(`/api/templates/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function apiEnhanceTemplate(id: string): Promise<ApiMessageTemplate> {
  return apiFetch<ApiMessageTemplate>(`/api/templates/${id}/enhance`, { method: 'POST' })
}

// ─── Knowledge Base ─────────────────────────────────────────────────────────────
export interface ApiKnowledgeSuggestion {
  id: string
  question: string
  answer: string
  status: string
  source: string
  propertyId?: string
  conversationId?: string
  category?: string
  createdAt: string
  updatedAt: string
}

export async function apiGetKnowledgeSuggestions(
  status?: string,
  opts?: { category?: string; search?: string }
): Promise<ApiKnowledgeSuggestion[]> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (opts?.category) params.set('category', opts.category)
  if (opts?.search) params.set('search', opts.search)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return apiFetch<ApiKnowledgeSuggestion[]>(`/api/knowledge${qs}`)
}

export async function apiUpdateKnowledgeSuggestion(
  id: string,
  data: { answer?: string; status?: string; propertyId?: string | null }
): Promise<ApiKnowledgeSuggestion> {
  return apiFetch<ApiKnowledgeSuggestion>(`/api/knowledge/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function apiCreateKnowledgeSuggestion(
  data: { question: string; answer: string; propertyId?: string; category?: string }
): Promise<ApiKnowledgeSuggestion> {
  return apiFetch<ApiKnowledgeSuggestion>('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function apiDeleteKnowledgeSuggestion(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' })
}

export async function apiBulkImportKnowledge(text: string): Promise<ApiKnowledgeSuggestion[]> {
  return apiFetch<ApiKnowledgeSuggestion[]>('/api/knowledge/bulk-import', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export async function apiDetectKnowledgeGaps(): Promise<Array<{ question: string; suggestedAnswer: string }>> {
  return apiFetch<Array<{ question: string; suggestedAnswer: string }>>('/api/knowledge/detect-gaps', {
    method: 'POST',
  })
}

export async function apiRateMessage(
  messageId: string,
  rating: 'positive' | 'negative',
  correction?: string[]
): Promise<{ ok: boolean; exampleCreated?: boolean }> {
  return apiFetch<{ ok: boolean; exampleCreated?: boolean }>(`/api/messages/${messageId}/rate`, {
    method: 'POST',
    body: JSON.stringify({ rating, ...(correction ? { correction } : {}) }),
  })
}

// ─── Copilot ─────────────────────────────────────────────────────────────────
export async function apiSetAiMode(id: string, aiMode: 'autopilot' | 'copilot' | 'off'): Promise<{ aiMode: string }> {
  return apiFetch<{ aiMode: string }>(`/api/conversations/${id}/ai-mode`, {
    method: 'PATCH',
    body: JSON.stringify({ aiMode }),
  })
}

export async function apiApproveSuggestion(id: string, editedText?: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/conversations/${id}/approve-suggestion`, {
    method: 'POST',
    body: JSON.stringify({ editedText }),
  })
}

export async function apiUpdateKnowledgeChunk(
  id: string,
  data: { content?: string; category?: string }
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/knowledge/chunks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function apiDeleteKnowledgeChunk(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/knowledge/chunks/${id}`, { method: 'DELETE' })
}

export async function apiSeedSops(): Promise<{ ok: boolean; inserted: number }> {
  return apiFetch<{ ok: boolean; inserted: number }>('/api/knowledge/seed-sops', { method: 'POST' })
}

// ─── Tool Invocations ────────────────────────────────────────────────────────

export interface ToolInvocation {
  id: string
  createdAt: string
  conversationId: string | null
  agentName: string | null
  toolName: string | null
  toolInput: Record<string, unknown> | null
  toolResults: unknown | null
  toolDurationMs: number | null
}

export async function apiGetToolInvocations(): Promise<ToolInvocation[]> {
  return apiFetch<ToolInvocation[]>('/api/knowledge/tool-invocations')
}

// ─── Sandbox Chat ─────────────────────────────────────────────────────────────

export interface SandboxChatRequest {
  propertyId: string
  reservationStatus: string
  channel: string
  guestName: string
  checkIn: string
  checkOut: string
  guestCount: number
  reasoningEffort?: string
  messages: Array<{ role: 'guest' | 'host'; content: string }>
}

export interface SandboxChatResponse {
  response: string
  escalation?: { title: string; note: string; urgency: string } | null
  manager?: { needed: boolean; title: string; note: string } | null
  toolUsed?: boolean
  toolName?: string
  toolInput?: any
  toolResults?: any
  toolDurationMs?: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  model: string
}

export async function apiSandboxChat(req: SandboxChatRequest): Promise<SandboxChatResponse> {
  return apiFetch<SandboxChatResponse>('/api/sandbox/chat', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

/**
 * Streaming variant of sandbox chat.
 * Calls POST /api/sandbox/chat?stream=1 and reads the response as SSE lines.
 * Each line is `data: {"delta":"..."}` or `data: {"done":true, ...fullResponse}`.
 * Falls back to non-streaming apiSandboxChat if the response is not streamed.
 */
export async function apiSandboxChatStream(
  req: SandboxChatRequest,
  onDelta: (text: string) => void,
): Promise<SandboxChatResponse> {
  const token = getToken()
  const res = await fetch(`${BASE_URL}/api/sandbox/chat?stream=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(body || `API error ${res.status}`)
  }

  const contentType = res.headers.get('content-type') || ''

  // If backend doesn't support streaming yet, it returns normal JSON
  if (contentType.includes('application/json')) {
    const json = await res.json() as SandboxChatResponse
    onDelta(json.response)
    return json
  }

  // Read SSE / ndjson stream
  const reader = res.body?.getReader()
  if (!reader) {
    const json = await res.json() as SandboxChatResponse
    onDelta(json.response)
    return json
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let finalResponse: SandboxChatResponse | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Process complete lines
    const lines = buffer.split('\n')
    buffer = lines.pop() || '' // keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue // skip empty lines and SSE comments
      const dataStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed
      if (!dataStr) continue
      try {
        const parsed = JSON.parse(dataStr)
        if (parsed.done && parsed.response !== undefined) {
          // Final payload with full response metadata
          finalResponse = parsed as SandboxChatResponse
        } else if (parsed.delta !== undefined) {
          onDelta(parsed.delta)
        }
      } catch {
        // Ignore unparseable lines
      }
    }
  }

  // If we got a final response from the stream, return it
  if (finalResponse) return finalResponse

  // Fallback: if stream ended without a final payload, throw
  throw new Error('Stream ended without final response')
}

// ── SOP Definition Management (015-sop-variants) ──

export interface SopVariantData {
  id: string
  status: string // 'DEFAULT' | 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN'
  content: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface SopDefinitionData {
  id: string
  tenantId: string
  category: string
  toolDescription: string
  enabled: boolean
  variants: SopVariantData[]
  createdAt: string
  updatedAt: string
}

export interface SopPropertyOverrideData {
  id: string
  sopDefinitionId: string
  propertyId: string
  status: string
  content: string
  enabled: boolean
}

export interface SopDefinitionsResponse {
  definitions: SopDefinitionData[]
  properties: Array<{ id: string; name: string; address: string }>
}

export async function apiGetSopDefinitions(): Promise<SopDefinitionsResponse> {
  return apiFetch<SopDefinitionsResponse>('/api/knowledge/sop-definitions')
}

export async function apiUpdateSopDefinition(id: string, data: { toolDescription?: string; enabled?: boolean }): Promise<SopDefinitionData> {
  return apiFetch<SopDefinitionData>(`/api/knowledge/sop-definitions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function apiUpdateSopVariant(id: string, data: { content?: string; enabled?: boolean }): Promise<SopVariantData> {
  return apiFetch<SopVariantData>(`/api/knowledge/sop-variants/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function apiCreateSopVariant(data: { sopDefinitionId: string; status: string; content: string }): Promise<SopVariantData> {
  return apiFetch<SopVariantData>('/api/knowledge/sop-variants', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function apiDeleteSopVariant(id: string): Promise<void> {
  await apiFetch(`/api/knowledge/sop-variants/${id}`, { method: 'DELETE' })
}

export async function apiGetSopPropertyOverrides(propertyId: string): Promise<SopPropertyOverrideData[]> {
  return apiFetch<SopPropertyOverrideData[]>(`/api/knowledge/sop-property-overrides?propertyId=${propertyId}`)
}

export async function apiCreateSopPropertyOverride(data: { sopDefinitionId: string; propertyId: string; status: string; content: string }): Promise<SopPropertyOverrideData> {
  return apiFetch<SopPropertyOverrideData>('/api/knowledge/sop-property-overrides', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function apiUpdateSopPropertyOverride(id: string, data: { content?: string; enabled?: boolean }): Promise<SopPropertyOverrideData> {
  return apiFetch<SopPropertyOverrideData>(`/api/knowledge/sop-property-overrides/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function apiDeleteSopPropertyOverride(id: string): Promise<void> {
  await apiFetch(`/api/knowledge/sop-property-overrides/${id}`, { method: 'DELETE' })
}

// ── Tool Definitions (018-tools-management) ──

export interface ApiToolDefinition {
  id: string
  tenantId: string
  name: string
  displayName: string
  description: string
  defaultDescription: string
  parameters: Record<string, unknown>
  agentScope: string
  type: string
  enabled: boolean
  webhookUrl: string | null
  webhookTimeout: number
}

export async function apiGetTools(): Promise<ApiToolDefinition[]> {
  return apiFetch<ApiToolDefinition[]>('/api/tools')
}

export async function apiUpdateTool(id: string, data: Partial<Pick<ApiToolDefinition, 'description' | 'enabled' | 'webhookUrl' | 'displayName' | 'agentScope'>>): Promise<ApiToolDefinition> {
  return apiFetch<ApiToolDefinition>(`/api/tools/${id}`, { method: 'PUT', body: JSON.stringify(data) })
}

export async function apiCreateTool(data: { name: string; displayName: string; description: string; parameters: Record<string, unknown>; agentScope: string; webhookUrl: string }): Promise<ApiToolDefinition> {
  return apiFetch<ApiToolDefinition>('/api/tools', { method: 'POST', body: JSON.stringify(data) })
}

export async function apiDeleteTool(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/tools/${id}`, { method: 'DELETE' })
}

export async function apiResetToolDescription(id: string): Promise<ApiToolDefinition> {
  return apiFetch<ApiToolDefinition>(`/api/tools/${id}/reset`, { method: 'POST' })
}

// ── Conversation Sync ────────────────────────────────────────────────────────

export async function apiSyncConversation(conversationId: string, force = false): Promise<{
  ok: boolean;
  newMessages?: number;
  backfilled?: number;
  syncedAt?: string;
  skipped?: boolean;
  reason?: string;
  lastSyncedAt?: string;
}> {
  return apiFetch(`/api/conversations/${conversationId}/sync${force ? '?force=true' : ''}`, {
    method: 'POST',
  })
}

