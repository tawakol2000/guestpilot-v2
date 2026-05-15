/**
 * Tool registry for the OpenAI Responses API path.
 *
 * The 18 Studio tools live in `backend/src/build-tune-agent/tools/` and are
 * registered with the Claude Agent SDK via a `tool(name, description, shape,
 * handler, options)` factory. The handlers themselves are provider-agnostic
 * — they close over a `ToolContext` and return `asCallToolResult(...)`
 * / `asError(...)` shapes.
 *
 * To avoid duplicating every tool file for OpenAI, we re-invoke each
 * `buildXxxTool(tool, getCtx)` with a spy factory that captures the
 * (name, description, zodShape, handler, options) tuple. We then convert
 * each captured tuple into an OpenAI function-tool descriptor and keep a
 * by-name handler map.
 *
 * The captured handler is invoked with the same `(args)` signature the SDK
 * uses; output is normalised to a string for the `function_call_output`
 * field of the Responses API.
 */
import { z } from 'zod/v4';
import { toJSONSchema } from 'zod/v4';

import type { ToolContext } from '../tools/types';
import { buildGetContextTool } from '../tools/get-context';
import { buildSearchCorrectionsTool } from '../tools/search-corrections';
import { buildGetCorrectionTool } from '../tools/get-correction';
import { buildGetEvidenceIndexTool } from '../tools/get-evidence-index';
import { buildGetEvidenceSectionTool } from '../tools/get-evidence-section';
import { buildSuggestionTool } from '../tools/suggestion';
import { buildMemoryTool } from '../tools/memory';
import { buildRollbackTool } from '../tools/version-history';
import { buildCreateFaqTool } from '../tools/create-faq';
import { buildCreateSopTool } from '../tools/create-sop';
import { buildCreateToolDefinitionTool } from '../tools/create-tool-definition';
import { buildWriteSystemPromptTool } from '../tools/write-system-prompt';
import { buildPlanBuildChangesTool } from '../tools/plan-build-changes';
import { buildTestPipelineTool } from '../tools/test-pipeline';
import { buildGetTenantIndexTool } from '../tools/get-tenant-index';
import { buildGetArtifactTool } from '../tools/get-artifact';
import { buildGetEditHistoryTool } from '../tools/get-edit-history';
import { buildGetCanonicalTemplateTool } from '../tools/get-canonical-template';
import { buildProposeTransitionTool } from '../tools/propose-transition';
import { TUNING_AGENT_TOOL_NAMES, TUNING_AGENT_SERVER_NAME } from '../tools/names';

/** Captured tool descriptor — the result of one `tool(...)` factory call. */
interface CapturedTool {
  /** Raw name passed to `tool()` (e.g. `studio_get_artifact`). */
  name: string;
  /** MCP-prefixed name used by the state machine (e.g. `mcp__tuning-agent__studio_get_artifact`). */
  prefixedName: string;
  description: string;
  zodShape: Record<string, z.ZodType<unknown>>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** OpenAI Responses API function-tool descriptor. */
export interface OpenAiFunctionTool {
  type: 'function';
  name: string;
  description: string;
  strict: false;
  parameters: Record<string, unknown>;
}

export interface OpenAiToolRegistry {
  /** Tools sent in the Responses API `tools` array. */
  tools: OpenAiFunctionTool[];
  /** Lookup: raw tool name → handler. */
  handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** Lookup: raw name → MCP-prefixed name (for state-machine gating). */
  prefixedNames: Map<string, string>;
}

/**
 * Spy factory matching the Claude Agent SDK's `tool()` signature. We discard
 * the SDK-flavoured return shape (the OpenAI path never reaches the MCP
 * server registration) and just capture the descriptor.
 */
function makeSpy(captured: CapturedTool[]) {
  return function spy(
    name: string,
    description: string,
    zodShape: Record<string, z.ZodType<unknown>>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
    _options?: unknown,
  ): unknown {
    captured.push({
      name,
      prefixedName: `mcp__${TUNING_AGENT_SERVER_NAME}__${name}`,
      description,
      zodShape,
      handler,
    });
    return {
      name,
      description,
      inputSchema: zodShape,
      handler,
    };
  };
}

/**
 * Convert the captured Zod shape into a JSON Schema parameters object for
 * the OpenAI Responses API.
 *
 * We deliberately keep `strict: false` — several Studio tools use
 * `z.union`, `z.discriminatedUnion`, or optional fields that don't compose
 * cleanly with OpenAI's strict-mode requirements (no optional keys,
 * additionalProperties:false everywhere). Loose mode keeps the model's
 * surface area faithful to the SDK path; the model still emits valid JSON
 * because the schema is provided as a hint.
 */
function zodShapeToJsonSchema(shape: Record<string, z.ZodType<unknown>>): Record<string, unknown> {
  // Wrap loose shape in a Zod object so we get a proper JSON Schema object
  // with `properties` + `required`.
  const obj = z.object(shape);
  try {
    const schema = toJSONSchema(obj as unknown as z.ZodType<unknown>, {
      target: 'draft-2020-12',
      io: 'input',
    });
    // toJSONSchema emits `$schema` and `additionalProperties: false`. Drop
    // `$schema` (OpenAI rejects it) and keep the rest.
    const out = { ...(schema as Record<string, unknown>) };
    delete out.$schema;
    if (!out.type) out.type = 'object';
    if (!out.properties) out.properties = {};
    // 2026-05-15: normalise tuple schemas. Zod's `z.tuple([...])` emits
    // `{ type: 'array', prefixItems: [...] }` per JSON Schema 2020-12,
    // but OpenAI Responses API rejects arrays whose `items` field is
    // missing ("In context=...lineRange, array schema missing items").
    // Walk the tree and convert each `array` node with `prefixItems`
    // into the legacy `items` form so both providers accept it.
    normaliseSchemaInPlace(out);
    return out;
  } catch (err) {
    console.warn(`[openai-tool-adapter] failed to convert schema, falling back to empty:`, err);
    return {
      type: 'object',
      properties: {},
    };
  }
}

/**
 * Walk a JSON Schema and rewrite tuple-style arrays
 * (`prefixItems: [s1, s2, …]`) into the legacy item-list form
 * (`items: oneOf-of-prefix-items, minItems, maxItems`) that the OpenAI
 * Responses API accepts. Also fills in `items: {}` on any array node that
 * somehow has neither `items` nor `prefixItems`, so we never ship an
 * `array` without an items definition.
 */
function normaliseSchemaInPlace(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const el of node) normaliseSchemaInPlace(el);
    return;
  }
  const obj = node as Record<string, unknown>;

  if (obj.type === 'array') {
    const prefix = obj.prefixItems;
    if (Array.isArray(prefix) && prefix.length > 0) {
      // Collapse the tuple into a single items schema. If every prefix
      // entry is structurally identical we can emit it directly;
      // otherwise wrap in anyOf so the model can still pick any of the
      // valid shapes per position.
      const first = prefix[0];
      const allSame = prefix.every((p) => JSON.stringify(p) === JSON.stringify(first));
      obj.items = allSame ? first : { anyOf: prefix };
      if (obj.minItems === undefined) obj.minItems = prefix.length;
      if (obj.maxItems === undefined) obj.maxItems = prefix.length;
      delete obj.prefixItems;
    } else if (obj.items === undefined) {
      // array with neither items nor prefixItems — emit a permissive
      // empty schema so OpenAI's validator stops rejecting the tool.
      obj.items = {};
    }
  }

  // Recurse into common composite keywords. `properties` /
  // `patternProperties` are dicts of {name: schema}, so recurse into
  // each value. `items` may be a single schema or (legacy) an array of
  // schemas. `additionalProperties` may be a schema or a boolean.
  for (const k of ['properties', 'patternProperties']) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const inner of Object.values(v as Record<string, unknown>)) {
        normaliseSchemaInPlace(inner);
      }
    }
  }
  if (Array.isArray(obj.items)) {
    for (const el of obj.items as unknown[]) normaliseSchemaInPlace(el);
  } else if (obj.items && typeof obj.items === 'object') {
    normaliseSchemaInPlace(obj.items);
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    normaliseSchemaInPlace(obj.additionalProperties);
  }
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(obj[k])) {
      for (const el of obj[k] as unknown[]) normaliseSchemaInPlace(el);
    }
  }
}

/**
 * Build the OpenAI tool registry. The same `getCtx` closure used by the
 * Anthropic MCP server is passed to each `buildXxxTool` factory so handler
 * scope is identical between providers.
 */
export function buildOpenAiToolRegistry(getCtx: () => ToolContext): OpenAiToolRegistry {
  const captured: CapturedTool[] = [];
  const spy = makeSpy(captured) as unknown as Parameters<typeof buildGetArtifactTool>[0];

  // Invoke each tool factory with the spy. Order matches tools/index.ts.
  buildGetContextTool(spy, getCtx);
  buildSearchCorrectionsTool(spy, getCtx);
  buildGetCorrectionTool(spy, getCtx);
  buildGetEvidenceIndexTool(spy, getCtx);
  buildGetEvidenceSectionTool(spy, getCtx);
  buildSuggestionTool(spy, getCtx);
  buildMemoryTool(spy, getCtx);
  buildRollbackTool(spy, getCtx);
  buildCreateFaqTool(spy, getCtx);
  buildCreateSopTool(spy, getCtx);
  buildCreateToolDefinitionTool(spy, getCtx);
  buildWriteSystemPromptTool(spy, getCtx);
  buildPlanBuildChangesTool(spy, getCtx);
  buildTestPipelineTool(spy, getCtx);
  buildGetTenantIndexTool(spy, getCtx);
  buildGetArtifactTool(spy, getCtx);
  buildGetEditHistoryTool(spy, getCtx);
  buildGetCanonicalTemplateTool(spy, getCtx);
  buildProposeTransitionTool(spy, getCtx);

  // 2026-05-15 (review pass D7): `buildSuggestionTool` internally invokes
  // `buildProposeSuggestionTool` and `buildSuggestionActionTool` (legacy
  // tool names retained for back-compat with old chained sessions) before
  // registering `studio_suggestion`. The spy captures all three. We
  // already filter at the per-state allow-list, but having legacy entries
  // in the handlers/prefixedNames maps invites accidental dispatch if a
  // stale `previous_response_id` chain ever surfaces those names. Filter
  // here so the registry only ever knows about the canonical Studio tool
  // names declared in TUNING_AGENT_TOOL_NAMES.
  const canonicalRawNames = new Set(
    Object.values(TUNING_AGENT_TOOL_NAMES).map((prefixed) => {
      const m = prefixed.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
      return m ? m[1] : prefixed;
    }),
  );
  const filteredCaptured = captured.filter((c) => canonicalRawNames.has(c.name));

  const tools: OpenAiFunctionTool[] = filteredCaptured.map((c) => ({
    type: 'function',
    name: c.name,
    description: c.description,
    strict: false,
    parameters: zodShapeToJsonSchema(c.zodShape),
  }));

  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const prefixedNames = new Map<string, string>();
  for (const c of filteredCaptured) {
    handlers.set(c.name, c.handler);
    prefixedNames.set(c.name, c.prefixedName);
  }

  return { tools, handlers, prefixedNames };
}

/**
 * Filter the registry by an allow-list of raw names. The same allow-list
 * resolver used by the SDK path drives this filter so per-state /
 * per-mode tool gating is identical on both providers.
 *
 * The input allow-list uses MCP-prefixed names (the form
 * `ALLOWED_TOOLS_BY_STATE` carries). Convert to raw names for filtering.
 */
export function filterRegistryByAllowedTools(
  registry: OpenAiToolRegistry,
  allowedPrefixedNames: readonly string[],
): OpenAiToolRegistry {
  const rawAllowed = new Set<string>();
  for (const prefixed of allowedPrefixedNames) {
    const m = prefixed.match(/^mcp__[^_]+(?:_[^_]+)*__(.+)$/);
    if (m) rawAllowed.add(m[1]);
    else rawAllowed.add(prefixed);
  }
  const filteredTools = registry.tools.filter((t) => rawAllowed.has(t.name));
  return {
    tools: filteredTools,
    handlers: registry.handlers,
    prefixedNames: registry.prefixedNames,
  };
}

/**
 * Normalise a handler return value into the string form Responses API expects
 * as `function_call_output.output`.
 */
export function serialiseToolOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  // SDK handlers return `{ content: [{type:'text', text}], structuredContent?, isError? }`.
  // We surface the `text` payload directly when present so the model sees
  // the same JSON string it would have seen via MCP.
  const o = output as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  if (Array.isArray(o.content)) {
    const text = o.content.find((c) => c?.type === 'text')?.text;
    if (typeof text === 'string') return text;
  }
  try {
    return JSON.stringify(output);
  } catch {
    // 2026-05-15 (L4): JSON.stringify throws on circular refs and on
    // BigInt. The previous `String(output)` fallback turned every such
    // object into "[object Object]" — the model then had no way to
    // parse it. Retry with a circular-safe stringifier that replaces
    // cycles with the marker [Circular]; if that still fails, return a
    // useful description rather than the useless toString form.
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(output, (_k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v && typeof v === 'object') {
          if (seen.has(v as object)) return '[Circular]';
          seen.add(v as object);
        }
        return v;
      });
    } catch (err) {
      const ctor = (output as { constructor?: { name?: string } })?.constructor?.name ?? 'object';
      return `[unserialisable ${ctor}: ${(err as Error).message}]`;
    }
  }
}

/**
 * Convenience: produce the OpenAI registry for a given mode + state by
 * applying the same allow-list resolution used in sdk-runner.ts.
 *
 * The allowed names are passed in (computed by the caller using
 * `resolveAllowedTools` from sdk-runner) so this module stays decoupled
 * from the SDK file.
 */
export const __exportedToolNamesForTest = TUNING_AGENT_TOOL_NAMES;
