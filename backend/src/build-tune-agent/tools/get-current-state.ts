/**
 * get_current_state — Sprint 046 Session A.
 *
 * The single source-of-truth grounding tool. Returns the actual text of the
 * tenant's configured artifacts so the agent can ground its
 * recommendations in what exists TODAY instead of counts-only summaries.
 *
 * Scope union (see plan §5.1):
 *   - 'summary'       TenantStateSummary (counts + ids, cheap)
 *   - 'system_prompt' full coordinator text + sections array
 *   - 'sops'          all SopDefinitions with variants + property overrides
 *   - 'faqs'          all FaqEntries (global + property-scoped)
 *   - 'tools'         all ToolDefinitions (system + custom)
 *   - 'all'           every non-summary scope plus summary
 *
 * This tool is callable in BOTH BUILD and TUNE modes — the grounding
 * need is mode-agnostic.
 */
import {
  getTenantStateSummary,
  type TenantStateSummary,
} from '../../services/tenant-state.service';
import type { ToolContext } from './types';

export type CurrentStateScope =
  | 'summary'
  | 'system_prompt'
  | 'sops'
  | 'faqs'
  | 'tools'
  | 'all';

export interface SystemPromptSection {
  id: string;
  title: string;
  range: [number, number];
}

export interface CurrentSystemPromptVariant {
  text: string;
  sections: SystemPromptSection[];
}

export interface CurrentSystemPromptPayload {
  /**
   * Coordinator-variant text. Preserved as top-level `text` for backward
   * compatibility with existing consumers (frontend state-snapshot card,
   * forced-first-turn summary panel) that read `systemPrompt.text`.
   */
  text: string;
  /** Coordinator-variant section anchors — see `text` above. */
  sections: SystemPromptSection[];
  version: number;
  /**
   * Bugfix (2026-04-22): `write_system_prompt` takes `variant: 'coordinator'
   * | 'screening'`. Previously, `get_current_state(scope:'system_prompt')`
   * exposed ONLY the coordinator variant, so if the manager asked to
   * review/edit the screening prompt the agent saw `text: ''` and either
   * hallucinated changes or claimed "no prompt configured" — same class of
   * silent-data-drop bug as the `get_context.recentMessages` fix. Both
   * variants are now surfaced under `variants.*` and the agent can also
   * read either by name.
   */
  variants: {
    coordinator: CurrentSystemPromptVariant;
    screening: CurrentSystemPromptVariant;
  };
}

export interface CurrentSopPayload {
  id: string;
  category: string;
  toolDescription: string;
  enabled: boolean;
  variants: Array<{
    id: string;
    status: string;
    content: string;
    enabled: boolean;
  }>;
  propertyOverrides: Array<{
    id: string;
    propertyId: string;
    status: string;
    content: string;
    enabled: boolean;
  }>;
}

export interface CurrentFaqPayload {
  id: string;
  category: string;
  scope: string;
  propertyId: string | null;
  question: string;
  answer: string;
  status: string;
}

export interface CurrentToolPayload {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: string;
  agentScope: string;
  enabled: boolean;
  isCustom: boolean;
}

/**
 * Sprint 046 follow-up (2026-04-24) — truncation signal.
 *
 * Large tenants serialize `scope:'all'` into 30–100+ KB of JSON. The
 * Claude Agent SDK / MCP transport silently clips tool-result text at
 * ~16 KB, which means the agent was receiving a mid-object cutoff with
 * NO signal that anything was missing — leading to hallucinated
 * "I don't see any SOPs for X" responses when the SOPs were just clipped
 * off the end. This envelope gives the agent an explicit, structured
 * signal of what was clipped so it can re-query with a narrower scope.
 *
 * Behavior:
 *   - Byte size of raw payload measured before return.
 *   - If under `SOFT_CAP_BYTES`, `truncated` is null.
 *   - If over, longest string fields are iteratively clipped to a
 *     minimum floor (`FIELD_FLOOR_CHARS`) with a `[…clipped]` sentinel
 *     until the serialized payload fits the cap. Each clipped field is
 *     recorded in `truncated.clipped` with the path + original length
 *     so the agent can `get_sop`/`get_faq` that specific item for the
 *     full body if needed.
 */
export const SOFT_CAP_BYTES = 48_000;
export const FIELD_FLOOR_CHARS = 800;
const CLIP_SENTINEL = '\n…[clipped by get_current_state — call the scoped get_sop/get_faq/get_tool for full body]';

export interface TruncationSignal {
  /** Raw bytes of the payload as JSON.stringified before any clipping. */
  originalBytes: number;
  /** Raw bytes of the payload after clipping (≤ SOFT_CAP_BYTES). */
  keptBytes: number;
  /** Soft cap used for this response (48_000 by default). */
  softCapBytes: number;
  /**
   * Per-field clip log. Path format matches the payload JSON shape so
   * the agent can map a clipped entry back to an id/category and
   * re-fetch it.
   */
  clipped: Array<{ path: string; originalLen: number; keptLen: number }>;
  note: string;
}

export type CurrentStatePayload =
  | { scope: 'summary'; summary: TenantStateSummary; truncated?: TruncationSignal | null }
  | { scope: 'system_prompt'; systemPrompt: CurrentSystemPromptPayload; truncated?: TruncationSignal | null }
  | { scope: 'sops'; sops: CurrentSopPayload[]; truncated?: TruncationSignal | null }
  | { scope: 'faqs'; faqs: CurrentFaqPayload[]; truncated?: TruncationSignal | null }
  | { scope: 'tools'; tools: CurrentToolPayload[]; truncated?: TruncationSignal | null }
  | {
      scope: 'all';
      summary: TenantStateSummary;
      systemPrompt: CurrentSystemPromptPayload;
      sops: CurrentSopPayload[];
      faqs: CurrentFaqPayload[];
      tools: CurrentToolPayload[];
      truncated?: TruncationSignal | null;
    };

const DESCRIPTION = `Return the actual text of the tenant's configured artifacts. Pick the narrowest scope that answers the question at hand — calling wider than you need burns context tokens the rest of the turn could use.
SCOPES:
  'summary' — counts + ids only (cheap). Called automatically on the first turn of every conversation; follow-up calls only when counts alone answer the question.
  'system_prompt' — full text + sections[] for BOTH variants (coordinator AND screening) under the 'variants' field; top-level 'text'/'sections' are the coordinator for back-compat. Call before proposing any SYSTEM_PROMPT edit so the suggested-fix target can reference the correct variant and a real sectionId.
  'sops' — all SopDefinitions with variants + property overrides. Call before SOP_CONTENT / SOP_ROUTING edits.
  'faqs' — all FaqEntries (global + property-scoped). Call before FAQ edits or when evaluating coverage gaps.
  'tools' — all ToolDefinitions (system + custom). Call before TOOL_CONFIG edits.
  'all' — union of all non-summary scopes + summary. Use ONLY for full-audit prompts ("review my setup"); a single 'all' call replaces four scoped calls.
ONE scoped call per distinct need per turn. A second call with the same scope in the same turn is flagged by the output linter.
OPTIONAL 'query' FILTER: pass 'query: "<keyword>"' alongside any scope except 'summary'/'system_prompt' to narrow results to artifacts whose text (category, question/answer, variant content, name, displayName, description) contains the keyword (case-insensitive substring). Ideal for large tenants: 'get_current_state({ scope: "sops", query: "parking" })' returns only parking-related SOPs instead of the full fleet. With scope='all', the query filters sops/faqs/tools but leaves summary + systemPrompt untouched.
TRUNCATION: every response carries a 'truncated' field. When non-null, long bodies have been clipped to keep the result under ${SOFT_CAP_BYTES / 1000} KB; 'truncated.clipped[]' lists each clipped field's path + originalLen + keptLen so you can re-fetch that exact artifact with the scoped tool (get_sop / get_faq / get_tool) for the full body. Do NOT edit a clipped artifact without re-fetching it first.`;

/**
 * Derive section anchors from the system-prompt text. The canonical template
 * uses <section id="..."> XML tags; older tenants use Markdown ## / ###
 * headings. We scan for both. If neither form appears, emit a single
 * body section spanning the whole text.
 */
export function deriveSystemPromptSections(text: string): SystemPromptSection[] {
  if (!text) return [];
  const sections: SystemPromptSection[] = [];

  const xmlRe = /<section\s+id="([^"]+)"(?:\s+title="([^"]+)")?\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = xmlRe.exec(text)) !== null) {
    const id = m[1];
    const title = m[2] ?? id.replace(/[-_]/g, ' ');
    const start = m.index;
    const closeRe = /<\/section>/g;
    closeRe.lastIndex = xmlRe.lastIndex;
    const close = closeRe.exec(text);
    const end = close ? close.index + close[0].length : text.length;
    sections.push({ id, title, range: [start, end] });
  }

  if (sections.length === 0) {
    const mdRe = /^(##{1,2})\s+(.+)$/gm;
    let prevIndex = -1;
    let prevTitle = '';
    let md: RegExpExecArray | null;
    while ((md = mdRe.exec(text)) !== null) {
      if (prevIndex >= 0) {
        sections.push({
          id: slugify(prevTitle),
          title: prevTitle,
          range: [prevIndex, md.index],
        });
      }
      prevIndex = md.index;
      prevTitle = md[2].trim();
    }
    if (prevIndex >= 0) {
      sections.push({
        id: slugify(prevTitle),
        title: prevTitle,
        range: [prevIndex, text.length],
      });
    }
  }

  if (sections.length === 0) {
    return [{ id: 'body', title: 'Body', range: [0, text.length] }];
  }
  return sections;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'section'
  );
}

export async function fetchSystemPromptPayload(
  prisma: ToolContext['prisma'],
  tenantId: string
): Promise<CurrentSystemPromptPayload> {
  const cfg = await prisma.tenantAiConfig.findUnique({
    where: { tenantId },
    select: {
      systemPromptCoordinator: true,
      systemPromptScreening: true,
      systemPromptVersion: true,
    },
  });
  const coordinatorText = cfg?.systemPromptCoordinator ?? '';
  const screeningText = cfg?.systemPromptScreening ?? '';
  const coordinator: CurrentSystemPromptVariant = {
    text: coordinatorText,
    sections: deriveSystemPromptSections(coordinatorText),
  };
  const screening: CurrentSystemPromptVariant = {
    text: screeningText,
    sections: deriveSystemPromptSections(screeningText),
  };
  return {
    // Top-level fields preserved for back-compat with existing consumers.
    text: coordinator.text,
    sections: coordinator.sections,
    version: cfg?.systemPromptVersion ?? 0,
    // New: both variants addressable by name so the agent can reason about
    // whichever one the manager is asking to edit (`write_system_prompt`
    // takes the same variant enum).
    variants: { coordinator, screening },
  };
}

/**
 * Case-insensitive substring match across all long-text fields of an
 * artifact. Each scope has its own relevant set of fields to search —
 * e.g. FAQ entries match on question + answer + category; tools match
 * on name + displayName + description.
 */
function caseInsensitiveIncludes(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function filterSopsByQuery(
  sops: CurrentSopPayload[],
  query: string | null | undefined
): CurrentSopPayload[] {
  if (!query) return sops;
  const q = query.trim();
  if (!q) return sops;
  return sops.filter((s) => {
    if (caseInsensitiveIncludes(s.category, q)) return true;
    if (caseInsensitiveIncludes(s.toolDescription, q)) return true;
    for (const v of s.variants) if (caseInsensitiveIncludes(v.content, q)) return true;
    for (const o of s.propertyOverrides) if (caseInsensitiveIncludes(o.content, q)) return true;
    return false;
  });
}

export function filterFaqsByQuery(
  faqs: CurrentFaqPayload[],
  query: string | null | undefined
): CurrentFaqPayload[] {
  if (!query) return faqs;
  const q = query.trim();
  if (!q) return faqs;
  return faqs.filter((f) =>
    caseInsensitiveIncludes(f.category, q) ||
    caseInsensitiveIncludes(f.question, q) ||
    caseInsensitiveIncludes(f.answer, q)
  );
}

export function filterToolsByQuery(
  tools: CurrentToolPayload[],
  query: string | null | undefined
): CurrentToolPayload[] {
  if (!query) return tools;
  const q = query.trim();
  if (!q) return tools;
  return tools.filter((t) =>
    caseInsensitiveIncludes(t.name, q) ||
    caseInsensitiveIncludes(t.displayName, q) ||
    caseInsensitiveIncludes(t.description, q)
  );
}

export async function fetchSopsPayload(
  prisma: ToolContext['prisma'],
  tenantId: string
): Promise<CurrentSopPayload[]> {
  const defs = await prisma.sopDefinition.findMany({
    where: { tenantId },
    include: {
      variants: {
        select: {
          id: true,
          status: true,
          content: true,
          enabled: true,
        },
      },
      propertyOverrides: {
        select: {
          id: true,
          propertyId: true,
          status: true,
          content: true,
          enabled: true,
        },
      },
    },
    orderBy: { category: 'asc' },
  });
  return defs.map((d) => ({
    id: d.id,
    category: d.category,
    toolDescription: d.toolDescription,
    enabled: d.enabled,
    variants: d.variants,
    propertyOverrides: d.propertyOverrides,
  }));
}

export async function fetchFaqsPayload(
  prisma: ToolContext['prisma'],
  tenantId: string
): Promise<CurrentFaqPayload[]> {
  const rows = await prisma.faqEntry.findMany({
    where: { tenantId },
    select: {
      id: true,
      category: true,
      scope: true,
      propertyId: true,
      question: true,
      answer: true,
      status: true,
    },
    orderBy: [{ scope: 'asc' }, { category: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    scope: String(r.scope),
    propertyId: r.propertyId ?? null,
    question: r.question,
    answer: r.answer,
    status: String(r.status),
  }));
}

export async function fetchToolsPayload(
  prisma: ToolContext['prisma'],
  tenantId: string
): Promise<CurrentToolPayload[]> {
  const rows = await prisma.toolDefinition.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      displayName: true,
      description: true,
      type: true,
      agentScope: true,
      enabled: true,
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    description: r.description,
    type: r.type,
    agentScope: r.agentScope,
    enabled: r.enabled,
    isCustom: r.type === 'custom',
  }));
}

interface StringLocator {
  /** Mutation callback that replaces the string in-place in the payload. */
  set: (val: string) => void;
  get: () => string;
  path: string;
}

/**
 * Walk the payload and enumerate every string field at paths that are
 * safe to clip. We deliberately DO NOT clip small metadata (ids,
 * categories, statuses, version numbers, scope, question headers); we
 * only target the known "long body" fields: system-prompt bodies, SOP
 * variant content, SOP property-override content, SOP toolDescription,
 * FAQ answers, tool descriptions.
 */
function collectClippableStrings(payload: CurrentStatePayload): StringLocator[] {
  const out: StringLocator[] = [];
  if (payload.scope === 'all' || payload.scope === 'system_prompt') {
    const sp = (payload as any).systemPrompt as CurrentSystemPromptPayload | undefined;
    if (sp) {
      out.push({
        path: 'systemPrompt.text',
        get: () => sp.text,
        set: (v) => { sp.text = v; },
      });
      out.push({
        path: 'systemPrompt.variants.coordinator.text',
        get: () => sp.variants.coordinator.text,
        set: (v) => { sp.variants.coordinator.text = v; },
      });
      out.push({
        path: 'systemPrompt.variants.screening.text',
        get: () => sp.variants.screening.text,
        set: (v) => { sp.variants.screening.text = v; },
      });
    }
  }
  if (payload.scope === 'all' || payload.scope === 'sops') {
    const sops = (payload as any).sops as CurrentSopPayload[] | undefined;
    if (sops) {
      for (const s of sops) {
        out.push({
          path: `sops[id=${s.id}].toolDescription`,
          get: () => s.toolDescription,
          set: (v) => { s.toolDescription = v; },
        });
        for (const v of s.variants) {
          out.push({
            path: `sops[id=${s.id}].variants[id=${v.id}].content`,
            get: () => v.content,
            set: (val) => { v.content = val; },
          });
        }
        for (const o of s.propertyOverrides) {
          out.push({
            path: `sops[id=${s.id}].propertyOverrides[id=${o.id}].content`,
            get: () => o.content,
            set: (val) => { o.content = val; },
          });
        }
      }
    }
  }
  if (payload.scope === 'all' || payload.scope === 'faqs') {
    const faqs = (payload as any).faqs as CurrentFaqPayload[] | undefined;
    if (faqs) {
      for (const f of faqs) {
        out.push({
          path: `faqs[id=${f.id}].answer`,
          get: () => f.answer,
          set: (v) => { f.answer = v; },
        });
      }
    }
  }
  if (payload.scope === 'all' || payload.scope === 'tools') {
    const tools = (payload as any).tools as CurrentToolPayload[] | undefined;
    if (tools) {
      for (const t of tools) {
        out.push({
          path: `tools[id=${t.id}].description`,
          get: () => t.description,
          set: (v) => { t.description = v; },
        });
      }
    }
  }
  return out;
}

/**
 * Attach a `truncated` envelope. Never mutates the caller's input
 * unless clipping is necessary; when clipping IS necessary, the
 * payload's string fields are modified in-place and the envelope
 * records every field that was touched so the agent can re-fetch
 * exactly that artifact with a narrower scope.
 *
 * Exported for unit tests — the runtime path goes through
 * `buildCurrentStatePayload`.
 */
export function applyTruncationSignal<T extends CurrentStatePayload>(
  payload: T,
  softCapBytes: number = SOFT_CAP_BYTES,
  fieldFloorChars: number = FIELD_FLOOR_CHARS
): T {
  const measure = () => JSON.stringify(payload).length;
  const originalBytes = measure();
  if (originalBytes <= softCapBytes) {
    payload.truncated = null;
    return payload;
  }
  const locators = collectClippableStrings(payload);
  // Clip longest-first so we shrink the budget fastest.
  locators.sort((a, b) => b.get().length - a.get().length);

  const clipped: TruncationSignal['clipped'] = [];
  for (const loc of locators) {
    const current = loc.get();
    if (current.length <= fieldFloorChars + CLIP_SENTINEL.length) continue;
    const keptBody = current.slice(0, fieldFloorChars);
    loc.set(keptBody + CLIP_SENTINEL);
    clipped.push({
      path: loc.path,
      originalLen: current.length,
      keptLen: keptBody.length,
    });
    if (measure() <= softCapBytes) break;
  }
  const keptBytes = measure();
  payload.truncated = {
    originalBytes,
    keptBytes,
    softCapBytes,
    clipped,
    note: clipped.length
      ? `Payload exceeded soft cap; ${clipped.length} field(s) clipped. Re-query with the scoped get_sop/get_faq/get_tool for full body of any clipped artifact.`
      : `Payload exceeded soft cap but no individual field was large enough to clip (floor=${fieldFloorChars} chars). Transport may still truncate; prefer a narrower scope.`,
  };
  return payload;
}

export async function buildCurrentStatePayload(
  prisma: ToolContext['prisma'],
  tenantId: string,
  scope: CurrentStateScope,
  query?: string | null
): Promise<CurrentStatePayload> {
  let payload: CurrentStatePayload;
  if (scope === 'summary') {
    const summary = await getTenantStateSummary(prisma, tenantId);
    payload = { scope, summary };
  } else if (scope === 'system_prompt') {
    const systemPrompt = await fetchSystemPromptPayload(prisma, tenantId);
    payload = { scope, systemPrompt };
  } else if (scope === 'sops') {
    const sops = filterSopsByQuery(await fetchSopsPayload(prisma, tenantId), query);
    payload = { scope, sops };
  } else if (scope === 'faqs') {
    const faqs = filterFaqsByQuery(await fetchFaqsPayload(prisma, tenantId), query);
    payload = { scope, faqs };
  } else if (scope === 'tools') {
    const tools = filterToolsByQuery(await fetchToolsPayload(prisma, tenantId), query);
    payload = { scope, tools };
  } else {
    // scope === 'all' — strict superset of the other scopes.
    const [summary, systemPrompt, sops, faqs, tools] = await Promise.all([
      getTenantStateSummary(prisma, tenantId),
      fetchSystemPromptPayload(prisma, tenantId),
      fetchSopsPayload(prisma, tenantId),
      fetchFaqsPayload(prisma, tenantId),
      fetchToolsPayload(prisma, tenantId),
    ]);
    payload = {
      scope: 'all',
      summary,
      systemPrompt,
      sops: filterSopsByQuery(sops, query),
      faqs: filterFaqsByQuery(faqs, query),
      tools: filterToolsByQuery(tools, query),
    };
  }
  return applyTruncationSignal(payload);
}

// Sprint 060-D Phase 7 — `get_current_state` tool removed; the helpers
// above are reused by `studio_get_tenant_index` (metadata-only index)
// and `studio_get_artifact` (single-artifact body via opaque pointer).
// `buildCurrentStatePayload` is still exported for the forced-first-turn
// state-snapshot card — the only caller that needs the legacy payload
// shape because the frontend snapshot panel reads it.
