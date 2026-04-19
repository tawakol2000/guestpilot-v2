# Tuning-agent memory — key namespacing

The agent writes durable, tenant-scoped facts to the `AgentMemory` Prisma
table via the `memory` tool (sprint-04 replacement for the SDK's
`memory_20250818` primitive, which is not exposed in
`@anthropic-ai/claude-agent-sdk` v0.2.109).

Keys are free-form strings, but by convention we namespace them with a
`category/subject` shape so related memories cluster when we list by prefix:

| Prefix | Purpose |
|--------|---------|
| `preferences/` | Durable manager-stated rules (e.g. `preferences/tone`, `preferences/concise-sops`). Survives forever. Injected into the dynamic portion of the system prompt at session start. |
| `facts/` | Tenant-specific facts the agent has learned (e.g. `facts/luxury-properties`, `facts/arabic-guests-common`). Drives suggestion heuristics. |
| `decisions/` | One row per accepted decision (e.g. `decisions/2026-04-15-parking-override`). Used for oscillation checks and to surface "we decided X on Y" history. |
| `rejections/` | Explicit manager rejections the agent should NOT re-propose (e.g. `rejections/tone-changes-on-confirmed`). |

Operations (the `memory` tool exposes these four):

| Op | Args | Returns |
|----|------|---------|
| `view` | `{ key }` | `{ value: Json \| null, updatedAt }` |
| `create` | `{ key, value, source? }` | `{ ok: true }` (fails with `ALREADY_EXISTS` if key already present) |
| `update` | `{ key, value }` | `{ ok: true, updatedAt }` (upserts — create if missing) |
| `delete` | `{ key }` | `{ ok: true }` |

The agent should also call `list` (implemented internally; not exposed as a
separate op — the runtime pulls `preferences/*` at session start and injects
them into the prompt) rather than inventing new prefixes.

**Never** write guest-facing data here. This table is for agent working
memory only — the main AI does not read it.
