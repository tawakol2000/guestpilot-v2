/**
 * Public API of the tuning-agent module.
 *
 * Importers outside this directory should use only the entry points re-
 * exported here. That way the module can be lifted wholesale into Anthropic
 * Managed Agents or a split backend later (deferred.md D16).
 */

export { runTuningAgentTurn } from './runtime';
export type { RunTurnInput, RunTurnResult } from './runtime';

export { assembleSystemPrompt } from './system-prompt';
export type { SystemPromptContext } from './system-prompt';

export {
  viewMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  listMemoryByPrefix,
} from './memory/service';

export {
  isTuningAgentEnabled,
  tuningAgentDisabledReason,
  resolveTuningAgentModel,
  DYNAMIC_BOUNDARY_MARKER,
} from './config';
