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
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  getTenantStateSummary,
  type TenantStateSummary,
} from '../../services/tenant-state.service';
import { asCallToolResult, asError, type ToolContext } from './types';

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

export interface CurrentSystemPromptPayload {
  text: string;
  sections: SystemPromptSection[];
  version: number;
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

export type CurrentStatePayload =
  | { scope: 'summary'; summary: TenantStateSummary }
  | { scope: 'system_prompt'; systemPrompt: CurrentSystemPromptPayload }
  | { scope: 'sops'; sops: CurrentSopPayload[] }
  | { scope: 'faqs'; faqs: CurrentFaqPayload[] }
  | { scope: 'tools'; tools: CurrentToolPayload[] }
  | {
      scope: 'all';
      summary: TenantStateSummary;
      systemPrompt: CurrentSystemPromptPayload;
      sops: CurrentSopPayload[];
      faqs: CurrentFaqPayload[];
      tools: CurrentToolPayload[];
    };

const DESCRIPTION = `Return the actual text of the tenant's configured artifacts. Pick the narrowest scope that answers the question at hand — calling wider than you need burns context tokens the rest of the turn could use.
SCOPES:
  'summary' — counts + ids only (cheap). Called automatically on the first turn of every conversation; follow-up calls only when counts alone answer the question.
  'system_prompt' — full coordinator text + sections[]. Call before proposing any SYSTEM_PROMPT edit so the suggested-fix target can reference a real sectionId.
  'sops' — all SopDefinitions with variants + property overrides. Call before SOP_CONTENT / SOP_ROUTING edits.
  'faqs' — all FaqEntries (global + property-scoped). Call before FAQ edits or when evaluating coverage gaps.
  'tools' — all ToolDefinitions (system + custom). Call before TOOL_CONFIG edits.
  'all' — union of all non-summary scopes + summary. Use ONLY for full-audit prompts ("review my setup"); a single 'all' call replaces four scoped calls.
ONE scoped call per distinct need per turn. A second call with the same scope in the same turn is flagged by the output linter.`;

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
      systemPromptVersion: true,
    },
  });
  const text = cfg?.systemPromptCoordinator ?? '';
  return {
    text,
    sections: deriveSystemPromptSections(text),
    version: cfg?.systemPromptVersion ?? 0,
  };
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

export async function buildCurrentStatePayload(
  prisma: ToolContext['prisma'],
  tenantId: string,
  scope: CurrentStateScope
): Promise<CurrentStatePayload> {
  if (scope === 'summary') {
    const summary = await getTenantStateSummary(prisma, tenantId);
    return { scope, summary };
  }
  if (scope === 'system_prompt') {
    const systemPrompt = await fetchSystemPromptPayload(prisma, tenantId);
    return { scope, systemPrompt };
  }
  if (scope === 'sops') {
    const sops = await fetchSopsPayload(prisma, tenantId);
    return { scope, sops };
  }
  if (scope === 'faqs') {
    const faqs = await fetchFaqsPayload(prisma, tenantId);
    return { scope, faqs };
  }
  if (scope === 'tools') {
    const tools = await fetchToolsPayload(prisma, tenantId);
    return { scope, tools };
  }
  // scope === 'all' — strict superset of the other scopes.
  const [summary, systemPrompt, sops, faqs, tools] = await Promise.all([
    getTenantStateSummary(prisma, tenantId),
    fetchSystemPromptPayload(prisma, tenantId),
    fetchSopsPayload(prisma, tenantId),
    fetchFaqsPayload(prisma, tenantId),
    fetchToolsPayload(prisma, tenantId),
  ]);
  return { scope: 'all', summary, systemPrompt, sops, faqs, tools };
}

export function buildGetCurrentStateTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext
) {
  return tool(
    'get_current_state',
    DESCRIPTION,
    {
      scope: z.enum(['summary', 'system_prompt', 'sops', 'faqs', 'tools', 'all']),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.get_current_state', args);
      try {
        const payload = await buildCurrentStatePayload(c.prisma, c.tenantId, args.scope);
        span.end({ scope: args.scope });
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`get_current_state failed: ${err?.message ?? String(err)}`);
      }
    }
  );
}
