/**
 * Tuning-agent in-process MCP server. Registers the ~8 consolidated tools per
 * sprint-04 brief §2.
 *
 * The SDK is ESM-only and our backend compiles to CJS, so we can't do a
 * top-level value import of `createSdkMcpServer` / `tool`. We pull them at
 * runtime via the CJS-safe `loadAgentSdk()` shim. See `../sdk-loader.cjs`.
 */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext } from './types';
import { buildGetContextTool } from './get-context';
import { buildSearchCorrectionsTool } from './search-corrections';
import { buildFetchEvidenceBundleTool } from './fetch-evidence-bundle';
import { buildProposeSuggestionTool } from './propose-suggestion';
import { buildSuggestionActionTool } from './suggestion-action';
import { buildMemoryTool } from './memory';
import { buildGetVersionHistoryTool, buildRollbackTool } from './version-history';
import { buildCreateFaqTool } from './create-faq';
import { buildCreateSopTool } from './create-sop';
import { buildCreateToolDefinitionTool } from './create-tool-definition';
import { buildWriteSystemPromptTool } from './write-system-prompt';
import { TUNING_AGENT_SERVER_NAME, TUNING_AGENT_TOOL_NAMES } from './names';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadAgentSdk } = require('../sdk-loader.cjs') as typeof import('../sdk-loader');

export { TUNING_AGENT_SERVER_NAME, TUNING_AGENT_TOOL_NAMES };

export async function buildTuningAgentMcpServer(
  getCtx: () => ToolContext
): Promise<McpSdkServerConfigWithInstance> {
  const sdk = await loadAgentSdk();
  const { createSdkMcpServer, tool } = sdk;
  return createSdkMcpServer({
    name: TUNING_AGENT_SERVER_NAME,
    version: '1.0.0',
    tools: [
      buildGetContextTool(tool, getCtx),
      buildSearchCorrectionsTool(tool, getCtx),
      buildFetchEvidenceBundleTool(tool, getCtx),
      buildProposeSuggestionTool(tool, getCtx),
      buildSuggestionActionTool(tool, getCtx),
      buildMemoryTool(tool, getCtx),
      buildGetVersionHistoryTool(tool, getCtx),
      buildRollbackTool(tool, getCtx),
      buildCreateFaqTool(tool, getCtx),
      buildCreateSopTool(tool, getCtx),
      buildCreateToolDefinitionTool(tool, getCtx),
      buildWriteSystemPromptTool(tool, getCtx),
    ],
  });
}

export type { ToolContext } from './types';
