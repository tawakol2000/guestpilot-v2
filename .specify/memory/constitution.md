<!--
Sync Impact Report
===================
Version change: 1.0.0 → 1.1.1
Modified principles:
  - §II Multi-Tenant Isolation: added carve-out for global classifier training data
  - §VII Self-Improvement with Guardrails: added judgeMode toggle exception
Modified sections:
  - Security & Data Protection: JWT expiry updated from 90d to 30d
Templates requiring updates: None (changes are additive)
Follow-up TODOs: None
-->

# GuestPilot v2 Constitution

## Core Principles

### I. Graceful Degradation (NON-NEGOTIABLE)

The main guest messaging flow MUST never break. Every feature, service,
and integration MUST degrade gracefully when dependencies are unavailable.

- Optional dependencies (Redis, OpenAI, Cohere, Langfuse) MUST fall back
  silently — never crash, never block the pipeline.
- New features MUST NOT introduce hard dependencies on optional services.
- If an AI pipeline stage fails, the system MUST either skip that stage
  and continue or escalate to a human operator — never leave a guest
  message unanswered silently.
- The webhook handler (`POST /webhooks/hostaway/:tenantId`) MUST return
  200 immediately and process asynchronously. Webhook processing failures
  MUST NOT propagate to the caller.

**Rationale:** This is a production guest communication platform. A silent
failure means a real guest waiting for a reply that never comes. Uptime
of the core messaging loop is the single most important system property.

### II. Multi-Tenant Isolation (NON-NEGOTIABLE)

Every database query, API response, and background job MUST be scoped to
the authenticated tenant. Data leakage between tenants is a critical
security violation.

- Every Prisma model includes `tenantId`. All queries MUST filter by it,
  with one exception: classifier training examples are shared globally
  across tenants (hospitality language is universal). SOP content
  retrieved for each classification label remains per-tenant.
- JWT tokens carry `tenantId` and `plan` — the auth middleware injects
  these into every authenticated request.
- Background jobs (debounce poll, BullMQ workers) MUST resolve tenant
  context from the job payload, never from global state.
- SSE event streams MUST only broadcast to connections authenticated for
  the target tenant.
- Cascade deletes (`onDelete: Cascade`) on tenant relations MUST be
  preserved — deleting a tenant MUST remove all associated data.

**Rationale:** GuestPilot serves multiple independent apartment operators.
A tenant MUST never see another tenant's guests, messages, properties,
or AI configuration.

### III. Guest Safety & Access Control (NON-NEGOTIABLE)

The AI MUST protect guest and property security through strict
information gating based on reservation status.

- Access codes (door codes, WiFi passwords) MUST never be exposed to
  guests with INQUIRY reservation status.
- The AI MUST never authorize refunds, credits, or discounts.
- The AI MUST never guarantee specific service times.
- The AI MUST never discuss its own nature as AI, reference managers,
  or reveal internal processes to guests.
- Screening rules (Section 7 of SPEC.md) MUST be enforced exactly as
  specified — the AI has no discretion to override screening criteria.
- Documents MUST only be requested AFTER booking acceptance, never before.

**Rationale:** Incorrect information disclosure (e.g., door codes to
non-guests) is a physical security risk. Financial commitments by AI
create legal liability. Guests must interact with "Omar" as a
consistent human-like persona.

### IV. Structured AI Output

All AI responses MUST be valid JSON conforming to the defined output
schemas. No markdown, code blocks, HTML, or extra text outside the
JSON structure.

- Guest Coordinator output: `{"guest_message", "escalation", "resolveTaskId", "updateTaskId"}`
- Screening AI output: `{"guest message", "manager"}`
- Intent Extractor output: `{"topic", "status", "urgency", "sops"}`
- Judge output: `{"retrieval_correct", "correct_labels", "confidence", "reasoning"}`
- Response parsing MUST strip code fences before `JSON.parse` as a
  defensive measure, but prompts MUST instruct models to output raw JSON.

**Rationale:** The entire post-generation pipeline (escalation handling,
task creation, message delivery, judge evaluation) depends on reliably
parsing AI output. Malformed output breaks the pipeline for that guest.

### V. Escalate When In Doubt

The system MUST prefer over-escalation to under-escalation. Missing a
genuine issue (safety, complaint, urgent maintenance) is worse than
creating a false-positive task for a manager to dismiss.

- 25 escalation triggers across three urgency tiers (immediate, scheduled,
  info_request) MUST be respected as defined in SPEC.md Section 8.
- The escalation-enrichment service adds keyword-based signals that
  supplement AI judgment — these MUST NOT be removed or weakened without
  explicit review.
- Every escalation creates a Task record, broadcasts an SSE `new_task`
  event, and saves an AI_PRIVATE note for manager context.
- When the AI is uncertain about how to handle a request, it MUST escalate
  rather than guess.

**Rationale:** A missed safety escalation (fire, flood, locked-out guest)
has real-world consequences. A false escalation costs a manager 10 seconds
to dismiss. The cost asymmetry strongly favors over-escalation.

### VI. Observability by Default

Every AI call, classification decision, and self-improvement action MUST
be logged with sufficient detail for post-hoc debugging and audit.

- `AiApiLog` MUST record: model, tokens, cost, duration, full prompt,
  response, and RAG context snapshot for every AI call.
- `ClassifierEvaluation` MUST record: classifier labels, method,
  similarity score, judge labels, correctness, and auto-fix status.
- Langfuse tracing (when configured) MUST fire-and-forget — observability
  failures MUST NOT block the pipeline (see Principle I).
- The OPUS daily audit report aggregates 24h of pipeline data for
  human review of system health, classification accuracy, and cost.
- SSE events MUST provide real-time visibility into AI activity
  (`ai_typing`, `ai_typing_clear`, `ai_suggestion`).

**Rationale:** An AI system that handles guest communication autonomously
MUST be auditable. When the AI makes a mistake, operators need full
context to understand why and to improve the system.

### VII. Self-Improvement with Guardrails

The classifier self-improvement loop (judge → auto-fix → retrain) MUST
operate within strict safety bounds to prevent training data corruption.

- Auto-fix is rate-limited to 10 examples per hour.
- Tier 2 feedback labels MUST pass a 0.35 cosine similarity validation
  against existing training examples before being accepted.
- Judge evaluation MUST be fire-and-forget — failures MUST NOT affect
  the already-sent guest response.
- The judge MUST skip evaluation when the classifier is already confident
  (topSimilarity >= judgeThreshold, majority neighbor agreement) —
  unless `judgeMode` is set to `evaluate_all`, in which case the judge
  evaluates every non-contextual AI response. The operator manually
  switches to `sampling` mode when the training set is mature.
- Low-similarity reinforcement (topSim < 0.40, judge says correct) adds
  examples to boost Tier 1 without changing classification behavior.

**Rationale:** Unconstrained self-improvement creates feedback loops that
can degrade classification quality. Rate limits, similarity validation,
and skip conditions prevent the system from poisoning its own training data.

## Security & Data Protection

- **Secrets MUST never be committed** to version control — `.env` files,
  API keys, credentials, and webhook secrets are excluded via `.gitignore`.
- **JWT tokens** expire after 30 days. The `JWT_SECRET` environment variable
  is required and MUST be explicitly set — no fallback value.
- **Webhook endpoints** (`/webhooks/hostaway/:tenantId`) are public-facing.
  Hostaway webhook secrets MUST be validated when configured. The tenantId
  in the URL path MUST match the authenticated tenant context.
- **Hostaway API keys** are stored per-tenant in the database. They MUST
  be treated as secrets — never logged, never included in API responses
  to the frontend, never exposed in error messages.
- **Image handling**: Guest images are downloaded from Hostaway, converted
  to base64, and passed to Claude as multimodal content blocks. Images
  MUST NOT be stored permanently beyond the AI call.
- **CORS** is restricted to explicitly configured origins (`CORS_ORIGINS`
  env var). The default (`http://localhost:3000`) MUST only apply in
  development.

## Development Workflow

- **Branch strategy**: `main` is production (Railway + Vercel). Feature
  development happens on `advanced-ai-v7` or feature branches. Direct
  pushes to `main` require explicit justification.
- **Database changes**: Schema modifications via `prisma/schema.prisma`
  MUST be applied with `npx prisma db push`. Destructive migrations
  (dropping columns, removing models) require data migration planning.
- **Environment variable discipline**: New optional dependencies MUST
  follow the pattern of checking for the env var at startup and disabling
  the feature silently if missing. Required variables (`DATABASE_URL`,
  `JWT_SECRET`, `ANTHROPIC_API_KEY`) MUST cause a clear startup error
  if absent.
- **AI prompt changes**: Modifications to system prompts, SOP content,
  or classifier training data MUST be tested against representative
  message samples before deployment. The `/api/ai-config/test` endpoint
  exists for this purpose.
- **Cost awareness**: AI model selection and pipeline stages have direct
  cost implications ($0.002–0.007 per message). Changes that increase
  per-message cost (e.g., upgrading from Haiku to Sonnet as default)
  MUST be flagged and justified.

## Governance

This constitution defines the non-negotiable principles and constraints
for the GuestPilot v2 platform. It supersedes ad-hoc decisions and MUST
be consulted when architectural trade-offs arise.

- **Amendment process**: Changes to this constitution MUST be documented
  with a version bump, rationale, and sync impact report. Principles
  marked NON-NEGOTIABLE require stronger justification for modification.
- **Versioning**: Follows semantic versioning — MAJOR for principle
  removals or redefinitions, MINOR for new principles or material
  expansions, PATCH for clarifications and wording fixes.
- **Compliance review**: New features and architectural changes MUST be
  checked against these principles before implementation. The plan
  template's "Constitution Check" section serves as the formal gate.
- **Authoritative references**: `SPEC.md` is the system specification.
  `AI_SYSTEM_FLOW-v7.md` is the pipeline reference. `CLAUDE.md` is the
  development guide. This constitution governs the principles that those
  documents implement.

**Version**: 1.1.1 | **Ratified**: 2026-03-19 | **Last Amended**: 2026-03-19
