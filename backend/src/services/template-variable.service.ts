/**
 * Template Variable Service
 *
 * Registry of template variables + resolution engine.
 * Variables in system prompts are labels/references only — actual data
 * resolves as separate user message content blocks (preserves prompt caching).
 */

// ════════════════════════════════════════════════════════════════════════════
// §1  Variable Registry
// ════════════════════════════════════════════════════════════════════════════

export interface TemplateVariable {
  name: string;
  description: string;
  essential: boolean;       // auto-appended if missing from prompt
  agentScope: ('coordinator' | 'screening')[];
  propertyBound: boolean;   // supports per-listing customization
  emptyDefault: string | null; // null = omit block entirely when empty
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  {
    name: 'CONVERSATION_HISTORY',
    description: 'All prior guest/agent messages (last 20, formatted as Guest:/Omar: lines)',
    essential: true,
    agentScope: ['coordinator', 'screening'],
    propertyBound: false,
    emptyDefault: 'No previous messages.',
  },
  {
    name: 'RESERVATION_DETAILS',
    description: 'Guest name, booking status, check-in/out dates, guest count',
    essential: true,
    agentScope: ['coordinator', 'screening'],
    propertyBound: false,
    emptyDefault: 'No reservation data available.',
  },
  {
    name: 'PRE_COMPUTED_CONTEXT',
    description: 'Pre-computed temporal and calendar variables (business hours, days until check-in/out, back-to-back flags, screening state)',
    essential: true,
    agentScope: ['coordinator', 'screening'],
    propertyBound: false,
    emptyDefault: null,
  },
  {
    name: 'ACCESS_CONNECTIVITY',
    description: 'Door code, WiFi name and password (only for confirmed/checked-in guests)',
    essential: false,
    agentScope: ['coordinator', 'screening'],
    propertyBound: true,
    emptyDefault: null, // omit for INQUIRY guests (security)
  },
  {
    name: 'PROPERTY_DESCRIPTION',
    description: 'Property location, features, capacity, and nearby landmarks',
    essential: false,
    agentScope: ['coordinator', 'screening'],
    propertyBound: true,
    emptyDefault: null, // omit if no description
  },
  {
    name: 'AVAILABLE_AMENITIES',
    description: 'Amenities classified as "available" or "default" for this property',
    essential: false,
    agentScope: ['coordinator', 'screening'],
    propertyBound: true,
    emptyDefault: null, // omit block entirely
  },
  {
    name: 'ON_REQUEST_AMENITIES',
    description: 'Amenities classified as "on request" for this property',
    essential: false,
    agentScope: ['coordinator', 'screening'],
    propertyBound: true,
    emptyDefault: null, // omit block entirely
  },
  {
    name: 'OPEN_TASKS',
    description: 'Currently open escalation tasks for this conversation',
    essential: false,
    agentScope: ['coordinator', 'screening'],
    propertyBound: false,
    emptyDefault: 'No open tasks.',
  },
  {
    name: 'CURRENT_MESSAGES',
    description: 'The new guest message(s) requiring a response',
    essential: true,
    agentScope: ['coordinator', 'screening'],
    propertyBound: false,
    emptyDefault: null, // never empty — always has at least one message
  },
  {
    name: 'CURRENT_LOCAL_TIME',
    description: "Property's current local time (timezone-aware)",
    essential: false,
    agentScope: ['coordinator', 'screening'],
    propertyBound: false,
    emptyDefault: null, // never empty — always computed
  },
  {
    name: 'DOCUMENT_CHECKLIST',
    description: 'Pending passport/marriage certificate items',
    essential: false,
    agentScope: ['coordinator'],
    propertyBound: true,
    emptyDefault: null, // omit block entirely when no checklist
  },
];

const VARIABLE_NAMES = new Set(TEMPLATE_VARIABLES.map(v => v.name));
const ESSENTIAL_NAMES = new Set(TEMPLATE_VARIABLES.filter(v => v.essential).map(v => v.name));
const VARIABLE_PATTERN = /\{([A-Z_]+)\}/g;

// ════════════════════════════════════════════════════════════════════════════
// §2  getAvailableVariables()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns variables applicable to the given agent type.
 * Used by the frontend editor to show available variables.
 */
export function getAvailableVariables(
  agentType: 'coordinator' | 'screening',
): TemplateVariable[] {
  return TEMPLATE_VARIABLES.filter(v => v.agentScope.includes(agentType));
}

// ════════════════════════════════════════════════════════════════════════════
// §3  resolveVariables()
// ════════════════════════════════════════════════════════════════════════════

export interface ContentBlock {
  type: 'text';
  text: string;
}

const CONTENT_BLOCKS_DELIMITER = '<!-- CONTENT_BLOCKS -->';
const BLOCK_DELIMITER = '<!-- BLOCK -->';

/**
 * Resolve template variables from a system prompt into ordered content blocks.
 *
 * Two modes:
 * 1. **Explicit blocks** — if the prompt contains `<!-- CONTENT_BLOCKS -->`,
 *    everything after that delimiter is split on `<!-- BLOCK -->` into separate
 *    content blocks. Each block's {VARIABLE} references are replaced with data.
 *    The prompt text BEFORE the delimiter is the static system prompt.
 *
 * 2. **Auto-derive** (legacy) — if no delimiter exists, scan the prompt for
 *    {VARIABLE_NAME} patterns and build one content block per variable found,
 *    in order of appearance. Auto-append essential variables if missing.
 *
 * Returns:
 *   cleanedPrompt — system prompt text (before delimiter, or full text in legacy mode)
 *   contentBlocks — ordered user message content blocks with actual data
 */
export function resolveVariables(
  promptText: string,
  dataMap: Record<string, string>,
  agentType: 'coordinator' | 'screening',
): { cleanedPrompt: string; contentBlocks: ContentBlock[] } {
  const scopedVars = new Set(
    TEMPLATE_VARIABLES
      .filter(v => v.agentScope.includes(agentType))
      .map(v => v.name),
  );

  // ─── Mode 1: Explicit content blocks ───
  if (promptText.includes(CONTENT_BLOCKS_DELIMITER)) {
    const [systemPart, blocksPart] = promptText.split(CONTENT_BLOCKS_DELIMITER, 2);
    const blockTemplates = blocksPart
      .split(BLOCK_DELIMITER)
      .map(b => b.trim())
      .filter(Boolean);

    const contentBlocks: ContentBlock[] = [];
    const usedVars = new Set<string>();

    for (const template of blockTemplates) {
      // Replace all {VARIABLE} references in this block with actual data
      let blockText = template;
      const blockRegex = new RegExp(VARIABLE_PATTERN.source, 'g');
      let blockMatch: RegExpExecArray | null;
      let hasContent = false;

      while ((blockMatch = blockRegex.exec(template)) !== null) {
        const varName = blockMatch[1];
        if (VARIABLE_NAMES.has(varName) && scopedVars.has(varName)) {
          const value = dataMap[varName] || '';
          const varDef = TEMPLATE_VARIABLES.find(v => v.name === varName);
          usedVars.add(varName);

          if (value.trim()) {
            blockText = blockText.replace(`{${varName}}`, value);
            hasContent = true;
          } else if (varDef?.emptyDefault !== null) {
            blockText = blockText.replace(`{${varName}}`, varDef?.emptyDefault || '');
            hasContent = true;
          } else {
            // emptyDefault is null — omit this variable's value
            blockText = blockText.replace(`{${varName}}`, '');
          }
        }
      }

      // Only add block if it has meaningful content after variable replacement
      const cleaned = blockText.trim();
      if (cleaned && hasContent) {
        contentBlocks.push({ type: 'text', text: cleaned });
      }
    }

    // Auto-append essential variables not referenced in any block
    for (const essential of ESSENTIAL_NAMES) {
      if (!usedVars.has(essential) && scopedVars.has(essential)) {
        const value = dataMap[essential] || '';
        if (value.trim()) {
          contentBlocks.push({
            type: 'text',
            text: `### ${essential.replace(/_/g, ' ')} ###\n${value}`,
          });
        }
      }
    }

    return { cleanedPrompt: systemPart.trim(), contentBlocks };
  }

  // ─── Mode 2: Auto-derive from variable positions (legacy) ───
  const referencedVars: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  const regex = new RegExp(VARIABLE_PATTERN.source, 'g');
  while ((match = regex.exec(promptText)) !== null) {
    const varName = match[1];
    if (VARIABLE_NAMES.has(varName) && scopedVars.has(varName) && !seen.has(varName)) {
      referencedVars.push(varName);
      seen.add(varName);
    }
  }

  // Auto-append essential variables that are missing
  for (const essential of ESSENTIAL_NAMES) {
    if (!seen.has(essential) && scopedVars.has(essential)) {
      referencedVars.push(essential);
    }
  }

  // Build content blocks in order
  const contentBlocks: ContentBlock[] = [];
  for (const varName of referencedVars) {
    const value = dataMap[varName] || '';
    const varDef = TEMPLATE_VARIABLES.find(v => v.name === varName);

    if (!value.trim()) {
      if (varDef?.emptyDefault === null) continue;
      contentBlocks.push({
        type: 'text',
        text: `### ${varName.replace(/_/g, ' ')} ###\n${varDef?.emptyDefault || ''}`,
      });
    } else {
      contentBlocks.push({
        type: 'text',
        text: `### ${varName.replace(/_/g, ' ')} ###\n${value}`,
      });
    }
  }

  return { cleanedPrompt: promptText, contentBlocks };
}

/** Exported delimiters for frontend block parsing */
export { CONTENT_BLOCKS_DELIMITER, BLOCK_DELIMITER };

// ════════════════════════════════════════════════════════════════════════════
// §4  applyPropertyOverrides()
// ════════════════════════════════════════════════════════════════════════════

interface VariableOverride {
  customTitle?: string;
  notes?: string;
}

/**
 * Apply per-listing overrides to a variable's resolved content.
 * customTitle — prepended as a header line before auto-generated content.
 * notes — appended after auto-generated content.
 */
export function applyPropertyOverrides(
  content: string,
  overrides?: VariableOverride,
): string {
  if (!overrides) return content;
  let result = content;
  if (overrides.customTitle) {
    result = `${overrides.customTitle}\n${result}`;
  }
  if (overrides.notes) {
    result = `${result}\n${overrides.notes}`;
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// §5  hasMinimumVariables() — migration detection
// ════════════════════════════════════════════════════════════════════════════

const MIGRATION_SENTINEL = '<!-- VARIABLES -->';

/**
 * Check if a prompt has been migrated to use template variables.
 * Returns true if >=3 distinct recognized variable names are found.
 */
export function hasMinimumVariables(promptText: string): boolean {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(VARIABLE_PATTERN.source, 'g');
  while ((match = regex.exec(promptText)) !== null) {
    if (VARIABLE_NAMES.has(match[1])) {
      found.add(match[1]);
    }
  }
  return found.size >= 3;
}

/**
 * Check if the migration sentinel is present (idempotency guard).
 */
export function hasMigrationSentinel(promptText: string): boolean {
  return promptText.includes(MIGRATION_SENTINEL);
}

/**
 * Build the default variable reference block for migration.
 */
export function buildMigrationBlock(agentType: 'coordinator' | 'screening'): string {
  const vars = getAvailableVariables(agentType);
  const varList = vars.map(v => `{${v.name}}`).join(', ');
  return `\n\n${MIGRATION_SENTINEL}\n## DATA SECTIONS\n\nYou will receive the following data as separate content blocks: ${varList}.\nRefer to each section by its name when responding to the guest.`;
}
