# Contract: `studio_get_artifact`

**Tool name:** `studio_get_artifact` (existing, extended)
**Owner:** [`backend/src/build-tune-agent/tools/get-artifact.ts`](../../../backend/src/build-tune-agent/tools/get-artifact.ts)
**Version:** v2 (this feature) — additive parameter extensions on the v1 schema

## Input schema

```ts
{
  // Existing — unchanged
  pointer: z.string().min(8).max(2048),

  // Existing in schema, behavior changed in this feature:
  // - Default was de-facto 'detailed' (handler ignored param)
  // - Default is now 'concise' (handler honors param)
  verbosity: z.enum(['concise', 'detailed']).optional(),

  // NEW in this feature
  mode: z.enum(['full', 'index']).optional(),       // default 'full'
  section: z.string().min(1).max(120).optional()
}
```

## Description (operator-readable, written into tool description)

> Resolve a body_pointer returned by `studio_get_tenant_index`. Returns one artifact (system-prompt variant, SOP, FAQ, or custom tool). Pointers are HMAC-signed and rejected on tamper.
>
> **Drill-down pattern:**
>
> 1. Call `studio_get_tenant_index` to see all artifacts (catalog).
> 2. Use `mode:'index'` to see one artifact's section structure (system_prompt or SOP only — FAQ/tool are atomic).
> 3. Use `section:'<name>'` to fetch one section's body.
> 4. Use `verbosity:'detailed'` (no `mode`/`section`) only when modifying — returns the full body (10-30K tokens for system prompts).
>
> Default `verbosity` is `'concise'`: returns a head excerpt (~1500 tokens) plus structural metadata. Most triage decisions don't need the full body — use concise for triage and section drill-down for editing.

## Output schemas (per kind × mode × verbosity × section)

### `system_prompt × full × detailed` (existing shape, preserved)

```json
{
  "kind": "system_prompt",
  "variant": "coordinator" | "screening",
  "version": "<int>",
  "text": "<full body, often 10-30K tokens>",
  "sections": [{ "name": "...", "lineRange": [start, end] }]
}
```

### `system_prompt × full × concise` (new default)

```json
{
  "kind": "system_prompt",
  "variant": "coordinator" | "screening",
  "version": "<int>",
  "text": "<head excerpt, ~1200 chars + truncation marker>",
  "sections": [{ "name": "...", "lineRange": [start, end] }],
  "fullCharLength": "<int>",
  "verbosity": "concise"
}
```

### `system_prompt × index × *` (verbosity ignored when mode is index)

```json
{
  "kind": "system_prompt",
  "variant": "coordinator" | "screening",
  "version": "<int>",
  "sectionList": [
    {
      "name": "voice",
      "summary": "Tone and politeness rules…",
      "tokens": 340,
      "hashId": "<16-hex HMAC>"
    },
    { "name": "screening_rejection", "summary": "...", "tokens": 180, "hashId": "..." }
  ],
  "fullCharLength": "<int>",
  "mode": "index"
}
```

### `system_prompt × * × section:'<name>'` (verbosity and mode both ignored when section is set)

```json
{
  "kind": "system_prompt",
  "variant": "coordinator" | "screening",
  "version": "<int>",
  "sectionName": "screening_rejection",
  "text": "<just that section's body>",
  "neighborSections": ["<prev_name>", "<next_name>"],
  "tokens": 180
}
```

### `sop × full × detailed` (existing shape, preserved)

```json
{
  "kind": "sop",
  "sop": {
    "id": "<cuid>",
    "category": "...",
    "toolDescription": "...",
    "enabled": true,
    "variants": [{ "status": "DEFAULT", "content": "<full body>", "enabled": true }]
  }
}
```

### `sop × full × concise` (new default)

```json
{
  "kind": "sop",
  "sop": {
    "id": "<cuid>",
    "category": "...",
    "toolDescription": "...",
    "enabled": true,
    "variants": [
      {
        "status": "DEFAULT",
        "content": "<head excerpt + truncation marker>",
        "enabled": true,
        "fullCharLength": "<int>"
      }
    ]
  },
  "verbosity": "concise"
}
```

### `sop × index × *`

```json
{
  "kind": "sop",
  "sopId": "<cuid>",
  "sectionList": [
    { "name": "Cleaning escalation", "summary": "...", "tokens": 250, "hashId": "..." }
  ],
  "fullCharLength": "<int>",
  "mode": "index"
}
```

When the SOP has no markdown headings, `sectionList` is a single-section fallback:

```json
{
  "kind": "sop",
  "sopId": "<cuid>",
  "sectionList": [
    {
      "name": "<SOP title from toolDescription>",
      "summary": "<first 80 chars of body>",
      "tokens": "<int>",
      "hashId": "..."
    }
  ],
  "fullCharLength": "<int>",
  "mode": "index",
  "fallback": "single-section (no markdown headings detected)"
}
```

### `sop × * × section:'<name>'`

```json
{
  "kind": "sop",
  "sopId": "<cuid>",
  "sectionName": "<name>",
  "text": "<just that section>",
  "neighborSections": ["<prev>", "<next>"],
  "tokens": "<int>"
}
```

### `faq × full × detailed` (existing shape, preserved)

```json
{
  "kind": "faq",
  "faq": {
    "id": "<cuid>",
    "question": "...",
    "answer": "<full>",
    "category": "...",
    "scope": "GLOBAL" | "PROPERTY",
    "status": "ACTIVE" | "SUGGESTED" | "STALE"
  }
}
```

### `faq × full × concise` (new default)

```json
{
  "kind": "faq",
  "faq": {
    "id": "<cuid>",
    "question": "...",
    "answer": "<head excerpt + truncation marker if > 1200 chars; else full>",
    "category": "...",
    "scope": "GLOBAL" | "PROPERTY",
    "status": "ACTIVE" | "SUGGESTED" | "STALE",
    "fullCharLength": "<int, present only when truncated>"
  },
  "verbosity": "concise"
}
```

### `faq × index × *`

```json
{
  "error": "kind 'faq' does not support index mode; use mode:'full' with verbosity:'concise'"
}
```

(returned as `asError` content)

### `tool × full × detailed` (existing shape, preserved)

```json
{
  "kind": "tool",
  "tool": {
    "id": "<cuid>",
    "name": "...",
    "description": "...",
    "parameters": {},
    "webhookUrl": "...",
    "enabled": true
  }
}
```

### `tool × full × concise` (new default)

```json
{
  "kind": "tool",
  "tool": {
    "id": "<cuid>",
    "name": "...",
    "description": "<head excerpt if > 1200 chars; else full>",
    "parameters": {},
    "webhookUrl": "...",
    "enabled": true,
    "fullCharLength": "<int, present only when truncated>"
  },
  "verbosity": "concise"
}
```

### `tool × index × *` / `tool × * × section:'<name>'`

```json
{ "error": "kind 'tool' does not support index mode or section drill-down" }
```

## Validation & error cases

| Case | Response |
|---|---|
| `pointer` HMAC fails | `asError("studio_get_artifact: invalid pointer (<reason>)")` |
| Unknown `kind` decoded from pointer | `asError("studio_get_artifact: unknown artifact kind '<kind>'")` |
| Artifact id not found | `asError("studio_get_artifact: <kind> <id> not found")` |
| `mode:'index'` on FAQ or tool kind | `asError("kind '<kind>' does not support index mode; use mode:'full' with verbosity:'concise'")` |
| `section:'<unknown>'` | `asError("studio_get_artifact: section '<name>' not found. Valid sections: [<comma-joined names>]")` |
| `section:'<name>'` on FAQ or tool kind | `asError("kind '<kind>' does not support section drill-down")` |
| `section` and `mode:'index'` both set | `mode:'index'` is ignored; section drill-down takes precedence |
| `verbosity` and `section` both set | `section` takes precedence (returns just that section regardless of verbosity) |

## Span observability

`build-tune-agent.studio_get_artifact` span ends with metadata:

```ts
{
  kind: 'system_prompt' | 'sop' | 'faq' | 'tool',
  detailed: boolean,           // verbosity === 'detailed'
  mode: 'full' | 'index',
  section: string | null,
  fullCharLength: number,      // size of underlying body
  returnCharLength: number     // size of what we actually returned
}
```

When the operator inspects the trace, `returnCharLength / fullCharLength` indicates compression ratio.

## Constitution compliance

- **II. Multi-Tenant Isolation**: section `hashId` HMAC includes `tenantId` in the signed payload (reuses existing pointer scheme).
- **VI. Observability**: span metadata captures the new fields; Langfuse trace shows compression ratio.
- **VII. Tool-Based Architecture**: tool count unchanged at 19; this is a parameter extension on an existing tool.
