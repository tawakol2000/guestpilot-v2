/**
 * Tuning-agent in-process MCP server. Registers the ~8 consolidated tools per
 * sprint-04 brief §2.
 *
 * The agent gets a ToolContext via closure — tools read the current tenantId,
 * conversationId, and emitDataPart handler at call time. Keeping this as a
 * closure lets one Node process serve many sessions without collision: each
 * `buildTuningAgentMcpServer(ctxFn)` call is scoped to a single runtime
 * invocation.
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext } from './types';
import { buildGetContextTool } from './get-context';
import { buildSearchCorrectionsTool } from './search-corrections';
import { buildFetchEvidenceBundleTool } from './fetch-evidence-bundle';
import { buildProposeSuggestionTool } from './propose-suggestion';
import { buildSuggestionActionTool } from './suggestion-action';
import { buildMemoryTool } from './memory';
import { buildGetVersionHistoryTool, buildRollbackTool } from './version-history';
import { TUNING_AGENT_SERVER_NAME, TUNING_AGENT_TOOL_NAMES } from './names';

export { TUNING_AGENT_SERVER_NAME, TUNING_AGENT_TOOL_NAMES };

export function buildTuningAgentMcpServer(getCtx: () => ToolContext) {
  return createSdkMcpServer({
    name: TUNING_AGENT_SERVER_NAME,
    version: '1.0.0',
    tools: [
      buildGetContextTool(getCtx),
      buildSearchCorrectionsTool(getCtx),
      buildFetchEvidenceBundleTool(getCtx),
      buildProposeSuggestionTool(getCtx),
      buildSuggestionActionTool(getCtx),
      buildMemoryTool(getCtx),
      buildGetVersionHistoryTool(getCtx),
      buildRollbackTool(getCtx),
    ],
  });
}

export type { ToolContext } from './types';
