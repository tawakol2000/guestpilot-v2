# Feature Specification: Tools Management Page Redesign

**Feature Branch**: `018-tools-management`
**Created**: 2026-03-23
**Status**: Draft
**Input**: User description: "Rebuild the tools page — configure tool descriptions, see what each tool does, and be able to add custom tools."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View All Tools with Full Details (Priority: P1)

The operator opens the Tools page and sees every tool the AI agents have access to — not a hardcoded list, but the live, real tools from the system. For each tool, the page shows: the tool name, which agent(s) can use it (screening, coordinator, or both), a description of what it does, when it fires, and its parameter schema (what inputs it expects). The operator can expand any tool to see its full definition.

Currently the tools page shows only 1 hardcoded tool. The system actually has 6: `get_sop`, `search_available_properties`, `create_document_checklist`, `check_extend_availability`, `mark_document_received`, plus any custom tools. The page must reflect reality.

**Why this priority**: Operators need visibility into what the AI can do. Without this, they can't understand or trust the AI's behavior.

**Independent Test**: Open the Tools page. Verify all 6 system tools appear with accurate descriptions, agent scope, and parameter details.

**Acceptance Scenarios**:

1. **Given** the system has 6 tools configured, **When** the operator opens the Tools page, **Then** all 6 tools are listed with their names, descriptions, agent scope, and enabled status.
2. **Given** any tool in the list, **When** the operator expands it, **Then** they see the full parameter schema (field names, types, descriptions) and when the tool is triggered.
3. **Given** a tool that is conditionally available (e.g., `mark_document_received` only when checklist pending), **When** viewing it, **Then** the condition is clearly displayed.

---

### User Story 2 - Edit Tool Descriptions (Priority: P2)

The operator can edit the description of any tool directly from the Tools page. The description is what the AI reads to decide when to call the tool — so changing it changes AI behavior. Edits are saved to the database and take effect on the next AI call (no deploy needed).

**Why this priority**: Tool descriptions are the primary way to tune when and how the AI uses tools. Operators need to adjust them based on real-world observations without code changes.

**Independent Test**: Edit the description of `search_available_properties`. Send a message in the sandbox. Verify the AI's behavior reflects the updated description.

**Acceptance Scenarios**:

1. **Given** a tool with description "Search for alternative properties...", **When** the operator edits the description to add "Only search when the guest explicitly asks for alternatives", **Then** the description is saved and the AI uses the new text.
2. **Given** a tool description edit, **When** the operator saves, **Then** the change takes effect without a deploy and the previous description is not lost (version history or undo available).
3. **Given** an edited description, **When** the operator wants to revert, **Then** they can reset to the default description.

---

### User Story 3 - Enable/Disable Tools (Priority: P3)

The operator can toggle any tool on or off. A disabled tool is not included in the AI's available tools — the AI cannot call it. This allows operators to temporarily disable a tool that's misbehaving without removing it.

**Why this priority**: Quick control over AI capabilities without code changes. If a tool causes issues, disable it instantly.

**Independent Test**: Disable `check_extend_availability`. Send a message about extending stay. Verify the AI does NOT call the tool and instead escalates.

**Acceptance Scenarios**:

1. **Given** a tool is enabled, **When** the operator disables it, **Then** the AI no longer has access to that tool on subsequent calls.
2. **Given** a tool is disabled, **When** the operator re-enables it, **Then** the AI can use it again.
3. **Given** the `get_sop` tool (core classification), **When** the operator tries to disable it, **Then** the system warns that this is a core tool and disabling it will break classification.

---

### User Story 4 - Add Custom Tools (Priority: P4)

The operator can create a new custom tool by defining: name, description, parameter schema (via a JSON editor with validation — not a visual form builder), and which agent(s) can use it. Custom tools call an external webhook URL when invoked — the operator provides the URL and the system forwards the tool input as JSON.

This allows operators to connect the AI to external systems (property management actions, maintenance dispatch, inventory checks) without code changes.

**Why this priority**: Extensibility. The current tools are hardcoded. Custom tools let operators expand AI capabilities for their specific operations.

**Independent Test**: Create a custom tool "check_inventory" with a webhook URL. In the sandbox, trigger it. Verify the AI calls the tool and the webhook receives the request.

**Acceptance Scenarios**:

1. **Given** the operator creates a new tool with name, description, parameters, and webhook URL, **When** they save, **Then** the tool appears in the AI's available tools and can be invoked.
2. **Given** a custom tool with a webhook URL, **When** the AI calls it, **Then** the system sends the tool input as JSON to the webhook and returns the webhook response to the AI.
3. **Given** a custom tool's webhook is unreachable, **When** the AI calls it, **Then** the system returns a graceful error message to the AI (not a crash) and the AI responds accordingly.
4. **Given** a custom tool, **When** the operator deletes it, **Then** it is removed from the AI's available tools.

---

### User Story 5 - Tool Invocation Logs (Priority: P5)

The operator can see recent tool invocations — which tools were called, when, with what input, what they returned, and how long they took. This is the monitoring/audit view that already partially exists but needs to show all tools (not just property search).

**Why this priority**: Observability. Operators need to verify tools are working correctly and debug issues.

**Independent Test**: After several AI interactions that use tools, open the Tools page. Verify the invocation log shows all tool calls with accurate data.

**Acceptance Scenarios**:

1. **Given** recent AI calls that used tools, **When** the operator views the invocation log, **Then** they see tool name, timestamp, input parameters, results, and duration for each call.
2. **Given** a tool call that failed, **When** viewing the log, **Then** the error is clearly shown.

---

## Clarifications

### Session 2026-03-23

- Q: How do operators define custom tool parameter schemas? → A: JSON editor (monospace textarea with validation), not a visual form builder.

### Edge Cases

- What happens when a custom tool's webhook returns invalid JSON? The system treats it as a string response and passes it to the AI.
- What happens when a custom tool has the same name as a system tool? The system rejects the creation — tool names must be unique.
- What happens when the operator edits a tool description to be empty? The system requires a minimum length (10 characters).
- What happens when multiple operators edit the same tool simultaneously? Last write wins (same pattern as other config).
- What happens when a custom tool's webhook takes too long? 10-second timeout, then return error to the AI.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Tools page MUST display all active tools from the system — both system tools and custom tools — not a hardcoded list.
- **FR-002**: Each tool MUST show: name, description, agent scope (screening/coordinator/both), enabled status, and parameter schema.
- **FR-003**: Tool descriptions MUST be editable inline and saved to the database without requiring a deploy.
- **FR-004**: Tools MUST be individually toggleable (enable/disable) with immediate effect on AI behavior.
- **FR-005**: Operators MUST be able to create custom tools with: name, description, parameter schema, agent scope, and webhook URL.
- **FR-006**: Custom tools MUST forward the AI's tool input as JSON to the configured webhook URL and return the response to the AI.
- **FR-007**: Custom tool webhook calls MUST have a 10-second timeout with graceful error handling.
- **FR-008**: Tool names MUST be unique across system and custom tools.
- **FR-009**: The page MUST show recent tool invocations with input, output, duration, and any errors.
- **FR-010**: System tools (get_sop, search_available_properties, etc.) MUST NOT be deletable — only their descriptions and enabled state can be modified.
- **FR-011**: Custom tools MUST be deletable by the operator.
- **FR-012**: The `get_sop` tool MUST show a warning when the operator attempts to disable it.

### Key Entities

- **ToolDefinition**: A tool available to the AI. Has: name, description, parameter schema (JSON), agent scope, enabled flag, webhook URL (null for system tools), type (system vs custom), tenant ownership.

### Assumptions

- System tools have hardcoded handler logic in the backend — custom tools use webhook forwarding.
- Tool parameter schemas follow the same JSON Schema format used by the AI provider.
- Only one tenant exists currently, but tool definitions are tenant-scoped for future multi-tenancy.
- The existing tool invocation log endpoint is reused and extended, not rebuilt.
- Custom tool webhook authentication is out of scope for now — webhooks are called without auth headers. Operators are responsible for securing their endpoints.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The Tools page accurately reflects 100% of active tools in the system within 5 seconds of loading.
- **SC-002**: Operators can edit a tool description and see the change take effect in the AI's behavior within 60 seconds (cache refresh).
- **SC-003**: Custom tools can be created and invoked end-to-end (create → AI calls → webhook receives → response returned) in under 5 minutes.
- **SC-004**: Tool enable/disable takes effect on the next AI call (no deploy, no server restart).
- **SC-005**: Zero downtime or errors caused by tool configuration changes — the AI gracefully handles missing or disabled tools.
