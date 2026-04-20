# Deferred: System Prompt Rework — Tool Definition Adjustments

**Created**: 2026-04-05
**Context**: Evaluating new system prompt recommendations from AI chatbot expert. These items need implementation work beyond the prompt swap.

## Deferred Items

### 1. `check_extend_availability` — Add `change_type` enum parameter

**Current**: Takes `new_checkout`, `new_checkin`, `reason`. The AI figures out the intent from the dates.

**Recommended**: Add `change_type` enum (`extend_checkout`, `shorten_checkout`, `change_checkin`, `change_both`) so the AI explicitly declares intent.

**Why defer**: The service (`extend-stay.service.ts`) already infers the change type from comparing dates (line 99: `if newCheckout <= currentCheckOut && newCheckin >= currentCheckIn → shortening`). Adding `change_type` to the tool schema is easy, but we'd need to decide whether the service uses it as a hint or ignores it. Low priority — the current inference works fine.

**Action when ready**: Add `change_type` to tool schema in `tool-definition.service.ts`, pass through to service, optionally log it for debugging but keep date-based inference as the source of truth.

### 2. `get_faq` — Don't hardcode category enum

**Current**: Our FAQ categories are DB-backed, tenant-configurable, loaded dynamically via `tool-definition.service.ts`.

**Recommended prompt has**: 15 hardcoded categories in an enum (`check-in-access`, `wifi-technology`, etc.).

**Decision**: Keep our dynamic loading. Hardcoding categories in the tool schema means adding a new FAQ category requires a code deploy instead of a DB edit. Our current approach is better for multi-tenant flexibility.

**Action**: When we adopt the new tool definitions, use our existing dynamic category loading. The `get_faq` parameter should describe what categories look like but not hardcode them. The recommended `reasoning` and `query_terms` fields ARE good additions — adopt those.

### 3. `get_faq` — Add `query_terms` parameter

**Current**: Our `get_faq` tool takes `category` only.

**Recommended**: Add `query_terms` (array of keywords from guest's question) for logging and future embedding fallback.

**Why defer**: Useful for observability and future semantic search, but our FAQ retrieval currently works on category matching only. Adding `query_terms` to the schema is trivial, but actually using them requires changes to `faq.service.ts`. Low priority but good to have.

**Action when ready**: Add `query_terms` to the tool schema, pass through and log in `ragContext.tools`, but don't change retrieval logic yet.

### 4. `get_sop` / `get_faq` — Add `reasoning` parameter to all tools

**Current**: `get_sop` already has `reasoning`. `get_faq`, `check_extend_availability`, and `mark_document_received` don't.

**Recommended**: Every tool gets a `reasoning` field for debugging.

**Decision**: Do this now — it's just schema additions. The reasoning gets logged in `ragContext.tools` automatically. High value for debugging with zero backend service changes needed.

**Status**: IMPLEMENT NOW (see below)
