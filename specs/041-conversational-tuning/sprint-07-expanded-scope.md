# Sprint 07 — Expanded scope: make /tuning a full agent workbench

> Written mid-sprint when the user pushed beyond "visual overhaul" into "make this actually feel like Claude Managed Agents." Rules out a plain CSS pass. Inventory of what the backend already exposes that the frontend isn't surfacing + the concrete new pages this sprint should add.

## The gap (forensic)

Backend endpoints with existing frontend `api*` wrappers that **/tuning does not consume today**:

| Capability | Backend route | Frontend wrapper | Used by /tuning? |
|---|---|---|---|
| Read/write the tenant system prompt | `/ai-config` GET/PUT | `apiGetAIConfig`, `apiUpdateAIConfig` | no |
| Read prompt history + revert | `/ai-config/versions`, `/ai-config/prompt-history` | `apiGetAiConfigVersions`, `apiRevertAiConfigVersion`, `apiGetPromptHistory` | no |
| Read/write tenant-level AI config (dual system prompts, per-agent) | `/tenant-config` GET/PUT | `apiGetTenantAiConfig`, `apiUpdateTenantAiConfig`, `apiResetSystemPrompts` | no |
| List template variables (content blocks) | `/ai-config/template-variables` | `apiGetTemplateVariables` | no |
| SOP CRUD (definitions + variants + property overrides) | `/knowledge/sop-*` | 10 `apiSop*` wrappers | no |
| FAQ CRUD | `/faq/*` | 5 `apiFaq*` wrappers | no |
| Tool CRUD (system + custom) | `/tool-definitions`, `/knowledge/tools*` | `apiListToolDefinitions`, `apiGetTools`, `apiUpdateTool`, `apiCreateTool`, `apiDeleteTool` | partially (list only, for accept-controls) |
| Tool invocation history (actual calls the main AI made) | `/knowledge/tool-invocations` | `apiGetToolInvocations` | no |
| Sandbox test chat (playground against current config) | `/sandbox/chat` (streaming) | `apiSandboxChat`, `apiSandboxChatStream` | no |
| AI call logs (every prompt-completion pair) | `/ai-logs`, `/ai-logs/:id` | `apiGetAiLogs`, `apiGetAiLogDetail` | no |
| Guest conversation list + detail | `/conversations`, `/conversations/:id` | `apiGetConversations`, `apiGetConversation` | detail only |

**Conclusion:** the entire "agent configuration" story, the "playground / test" story, and the "session inspection / debug" story are hosted by the main v5 inbox app (at `/`) and completely absent from `/tuning`. Managers have to leave the tuning surface to do the actual work that tuning is supposed to be about.

## What this means for the UX

Claude Managed Agents + OpenAI Platform both converge on the same three-pane model:

1. **Configure the agent** — system prompt, tools, knowledge, variables.
2. **Test the agent** — playground with live chat against the current config.
3. **Inspect past runs** — sessions / logs / tool invocations.

GuestPilot `/tuning` today only has the *meta* surface (queue + chat + dashboards). The agent's *own config* and *own runs* live elsewhere. The user should never have to bounce between surfaces to (a) read a suggestion, (b) open the system prompt to see what the AI was told, (c) test a fix, (d) confirm the fix worked on a new guest conversation.

## What to ship in this expanded sprint

Four new surfaces, all leveraging existing API wrappers — **zero backend work**, zero new npm deps:

### 1. `/tuning/agent` — The flagship "Agent" page
Layout inspired by OpenAI Platform's prompt editor:
- Header: agent-scope selector (`Coordinator` / `Screening`), "Test it →" link that pushes to `/tuning/playground?scope=…`, a "View history →" link that pushes to `/tuning/history`.
- **System prompt card** (top, dominant): editable textarea prefilled from `apiGetTenantAiConfig`. Shows current version. Save → `apiUpdateTenantAiConfig`. Reset → `apiResetSystemPrompts`.
- **Template variables strip**: small chips listing the `{VARIABLES}` the prompt can use (pulled from `apiGetTemplateVariables`). Click a chip to insert the token at the cursor.
- **Knowledge summary** (middle): three horizontal cards — SOPs (count + "edit →" deep-link to `/configure-ai`), FAQs (count + "edit →"), Tools (count + "edit →"). Each card shows the current top 3 entries as read-only previews so managers can scan without clicking through.
- **Advanced** (collapsible at the bottom): model, temperature, additional settings from `apiGetAIConfig`.

Rationale: the single most common manager question is "what is my AI currently told to do?" — today you answer it by navigating to /configure-ai, which visually breaks the tuning flow. Surfacing it in /tuning with deep-links to the full editors gives 80% of the value without building CRUD from scratch.

### 2. `/tuning/playground` — Test chat
Mirror of OpenAI's right-panel chat:
- Top bar: agent-scope selector (`Coordinator` / `Screening`), reservation-status selector (`INQUIRY` / `CONFIRMED` / etc.), property selector.
- Chat area: send a guest-style message, see the main AI's reply streamed via `apiSandboxChatStream`. Each reply shows the tools invoked + SOPs fired inline as chips, like the real chat panel.
- Bottom: "send as guest" input with send button, clear-chat action, "save as test case" button (staged for a later sprint — just a UI affordance for now).

Rationale: property managers today ship prompt changes and then wait for a real guest to trigger the flow to see if it worked. Playground lets them test in seconds. Backend already supports it via `/sandbox/chat`.

### 3. `/tuning/sessions` — Session inspector
Claude Console's debug view, applied to real guest conversations:
- Left: list of recent guest conversations (`apiGetConversations`) with filters (thumbs-down only, AI-replied only, per property, per status).
- Main: transcript + event timeline. Each AI reply expands into events: SOP classifier fired, tools called, tokens used, reasoning excerpt, downstream task. Data from `apiGetConversation` + `apiGetAiLogs` (log id cross-referenced by conversation).
- Right: JSON pane on click (lucide-icon pill → JSON tree like evidence-pane).

Rationale: when a manager asks "why did the AI say that?", the answer is in ai-logs + tool-invocations. Today they have to manually hunt via `/ai-logs`. Aligning this with tuning (conversation → tuning chat about this conversation) closes the loop.

### 4. Top-nav restructure
Expanded nav (all links existed OR are new in this sprint):

```
← Inbox  |  Suggestions  |  Agent  |  Playground  |  Sessions  |  History  |  Capability requests
```

`Suggestions` = old `/tuning` (the queue). Keep the URL, rename the label so the new surfaces don't feel like subordinates.

## What NOT to ship this sprint

- Full SOP CRUD inside /tuning. SOPs already have a dedicated editor at `/configure-ai/sop-editor-v5`; cross-link to it from the agent page rather than rebuild.
- Full FAQ CRUD. Same deal — cross-link to `faq-v5`.
- Full tool CRUD. Same — cross-link to `tools-v5`.
- Command palette (Cmd-K). Worth it; defer to a separate sprint so we can design it across the whole app rather than /tuning-only.
- Multi-agent / shared workspace features. Out of scope.

## Execution order

1. Top-nav expansion (one-liner).
2. `/tuning/agent` page (biggest impact, moderate effort — it's mostly GET + textarea + save).
3. `/tuning/playground` page (medium effort — streaming chat wrapper around existing sandbox API).
4. `/tuning/sessions` page (largest effort — list + detail + event timeline. May ship scaffolded with a "coming soon" panel for the JSON-tree + tool-invocation-timeline if time runs short).
5. Per-page commits, a final polish commit, a follow-up report.
