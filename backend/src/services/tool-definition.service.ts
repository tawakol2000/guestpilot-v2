/**
 * Tool Definition Service
 *
 * CRUD + caching + lazy seeding for ToolDefinition model.
 * System tools are seeded on first access per tenant (same pattern as tenant-config.service.ts).
 * Custom tools support webhook forwarding.
 */
import { Prisma, PrismaClient, ToolDefinition } from '@prisma/client';

// ════════════════════════════════════════════════════════════════════════════
// Cache
// ════════════════════════════════════════════════════════════════════════════

interface CacheEntry {
  tools: ToolDefinition[];
  cachedAt: number;
}

const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateToolCache(tenantId: string): void {
  _cache.delete(tenantId);
}

// ════════════════════════════════════════════════════════════════════════════
// §1  getToolDefinitions()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns ALL tool definitions (enabled AND disabled) for the tenant.
 * Lazy-seeds system tools on first access.
 * Cached for 5 minutes.
 */
export async function getToolDefinitions(
  tenantId: string,
  prisma: PrismaClient,
): Promise<ToolDefinition[]> {
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.tools;
  }

  // Lazy seed: if no tools exist for this tenant, seed system tools
  const count = await prisma.toolDefinition.count({ where: { tenantId } });
  if (count === 0) {
    await seedToolDefinitions(tenantId, prisma);
  }

  const tools = await prisma.toolDefinition.findMany({
    where: { tenantId },
    orderBy: { name: 'asc' },
  });

  _cache.set(tenantId, { tools, cachedAt: Date.now() });
  return tools;
}

// ════════════════════════════════════════════════════════════════════════════
// §2  seedToolDefinitions()
// ════════════════════════════════════════════════════════════════════════════

/** System tool seed definitions. */
const SYSTEM_TOOLS: Array<{
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  agentScope: string;
}> = [
  {
    name: 'get_sop',
    displayName: 'SOP Classification',
    description:
      'Classifies a guest message to determine which Standard Operating Procedure should guide the response. ' +
      'Call this for EVERY guest message. Returns the SOP category that best matches the guest\'s primary intent. ' +
      'For simple greetings, acknowledgments, or messages that don\'t require procedure-based responses, use "none". ' +
      'For messages requiring human intervention, use "escalate".',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Brief reasoning for classification (1 sentence)',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
          },
          minItems: 1,
          maxItems: 3,
          description: 'SOP categories matching the guest\'s intent(s), ordered by priority. Most messages have exactly one intent.',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Classification confidence. Use \'low\' when ambiguous between multiple SOPs or unclear intent.',
        },
      },
      required: ['reasoning', 'categories', 'confidence'],
      additionalProperties: false,
    },
    agentScope: 'INQUIRY,PENDING,CONFIRMED,CHECKED_IN',
  },
  {
    name: 'search_available_properties',
    displayName: 'Property Search',
    description:
      'Score this property and alternatives against the guest\'s requirements. Returns match scores, met/unmet breakdown, and notes. ' +
      'CALL for: guest lists multiple requirements, asks what\'s available, wants to compare options, asks about amenities. ' +
      'DO NOT call for: single factual property questions (use get_sop or get_faq), extend/shorten stay (use check_extend_availability).',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Why calling search and what requirements to match against.',
        },
        amenities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Amenities or features the guest is looking for, e.g. [\'pool\', \'parking\', \'sea view\']. Use simple English terms.',
        },
        min_capacity: {
          type: ['number', 'null'],
          description: 'Minimum number of guests the property should accommodate. Only include if the guest mentioned needing more space or has a specific group size.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for the search, verbatim or near-verbatim from guest.',
        },
      },
      required: ['reasoning', 'amenities', 'reason', 'min_capacity'],
      additionalProperties: false,
    },
    agentScope: 'INQUIRY,PENDING',
  },
  {
    name: 'create_document_checklist',
    displayName: 'Document Checklist',
    description:
      'Create a document checklist for this booking. Call this when you have determined the guest is eligible and are about ' +
      'to escalate to the manager with an acceptance recommendation. Records what documents the guest will need to submit after ' +
      'booking acceptance. Do NOT call this when recommending rejection.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Why creating this checklist — screening outcome and party details. E.g. "Eligible Arab married couple, 2 guests, needs passports + marriage cert."',
        },
        passports_needed: {
          type: 'number',
          description: 'Number of passport/ID documents needed (one per guest in the party)',
        },
        marriage_certificate_needed: {
          type: 'boolean',
          description: 'Whether a marriage certificate is required (true for Arab married couples)',
        },
        reason: {
          type: 'string',
          description: 'Brief note, e.g. \'Egyptian married couple, 2 guests\'',
        },
      },
      required: ['reasoning', 'passports_needed', 'marriage_certificate_needed', 'reason'],
      additionalProperties: false,
    },
    agentScope: 'INQUIRY,PENDING',
  },
  {
    name: 'check_extend_availability',
    displayName: 'Extend Stay',
    description:
      'Check if the guest\'s current property is available for extended or modified dates, and calculate pricing. ' +
      'CALL for: extending stay, adding nights, leaving early, shortening stay, changing dates, cost of more nights. ' +
      'DO NOT call for: late checkout under 2 hours beyond standard (use get_sop with sop-late-checkout), unrelated questions.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Why this change and these dates. E.g. "Guest says flight changed to Sunday, needs 2 extra nights."',
        },
        new_checkout: {
          type: 'string',
          description: 'The requested new checkout date in YYYY-MM-DD format.',
        },
        new_checkin: {
          type: ['string', 'null'],
          description: 'The requested new check-in date in YYYY-MM-DD format. Only needed if the guest wants to arrive earlier or later.',
        },
        reason: {
          type: 'string',
          description: 'Specific reason from guest. Not generic "wants to extend".',
        },
      },
      required: ['reasoning', 'new_checkout', 'reason', 'new_checkin'],
      additionalProperties: false,
    },
    agentScope: 'CONFIRMED,CHECKED_IN',
  },
  {
    name: 'mark_document_received',
    displayName: 'Mark Document Received',
    description:
      'Mark a document as received after the guest sends it via chat. ' +
      'CALL for: clear passport, national ID, driver\'s license, or marriage certificate images when documents are pending. ' +
      'DO NOT call for: unclear/blurry images (escalate for manager review), images that aren\'t documents, or when no documents are pending.',
    parameters: {
      type: 'object',
      properties: {
        reasoning: {
          type: 'string',
          description: 'Why you believe this image is this document type. E.g. "Image shows passport photo page for Mohamed with visible MRZ code."',
        },
        document_type: {
          type: 'string',
          enum: ['passport', 'marriage_certificate'],
          description: 'Type of document received',
        },
        notes: {
          type: 'string',
          description: 'Brief description, e.g. \'passport for Mohamed\' or \'marriage certificate for Ahmed and Sara\'',
        },
      },
      required: ['reasoning', 'document_type', 'notes'],
      additionalProperties: false,
    },
    agentScope: 'CONFIRMED,CHECKED_IN',
  },
];

/**
 * Upsert all system tools for a tenant.
 * Uses `update: {}` so existing (potentially edited) records are never overwritten.
 */
export async function seedToolDefinitions(
  tenantId: string,
  prisma: PrismaClient,
): Promise<void> {
  for (const tool of SYSTEM_TOOLS) {
    await prisma.toolDefinition.upsert({
      where: { tenantId_name: { tenantId, name: tool.name } },
      update: {
        // Update defaultDescription to latest seed value (preserves operator's custom description if different)
        defaultDescription: tool.description,
      },
      create: {
        tenantId,
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        defaultDescription: tool.description,
        parameters: tool.parameters as unknown as Prisma.InputJsonValue,
        agentScope: tool.agentScope,
        type: 'system',
        enabled: true,
      },
    });
  }
  // Migrate legacy agentScope values (screening/coordinator/both → booking statuses)
  const SCOPE_MIGRATION: Record<string, string> = {
    'both': 'INQUIRY,PENDING,CONFIRMED,CHECKED_IN',
    'screening': 'INQUIRY,PENDING',
    'coordinator': 'CONFIRMED,CHECKED_IN',
  };
  for (const [oldScope, newScope] of Object.entries(SCOPE_MIGRATION)) {
    await prisma.toolDefinition.updateMany({
      where: { tenantId, agentScope: oldScope },
      data: { agentScope: newScope },
    });
  }

  // Migrate get_sop description to latest version
  const latestGetSopDesc = SYSTEM_TOOLS.find(t => t.name === 'get_sop')!.description;
  await prisma.toolDefinition.updateMany({
    where: { tenantId, name: 'get_sop', description: { not: latestGetSopDesc } },
    data: {
      description: latestGetSopDesc,
      defaultDescription: latestGetSopDesc,
    },
  });

  console.log(`[ToolDefinition] Seeded ${SYSTEM_TOOLS.length} system tools for tenant ${tenantId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// §3  updateToolDefinition()
// ════════════════════════════════════════════════════════════════════════════

interface ToolUpdateData {
  description?: string;
  displayName?: string;
  enabled?: boolean;
  webhookUrl?: string | null;
  webhookTimeout?: number;
  agentScope?: string;
}

/**
 * Update a tool definition. Validates description min 10 chars.
 * Invalidates cache on success.
 */
export async function updateToolDefinition(
  id: string,
  updates: ToolUpdateData,
  prisma: PrismaClient,
): Promise<ToolDefinition> {
  // Validate agentScope
  if (updates.agentScope !== undefined) {
    const VALID_STATUSES = ['INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN'];
    const scopeStatuses = updates.agentScope.split(',').map(s => s.trim());
    if (scopeStatuses.length === 0 || !scopeStatuses.every(s => VALID_STATUSES.includes(s))) {
      const err = new Error('agentScope must be comma-separated booking statuses: INQUIRY,PENDING,CONFIRMED,CHECKED_IN') as any;
      err.field = 'agentScope';
      throw err;
    }
  }
  // Validate description length
  if (updates.description !== undefined && updates.description.length < 10) {
    const err = new Error('Description must be at least 10 characters') as any;
    err.field = 'description';
    throw err;
  }

  const tool = await prisma.toolDefinition.findUnique({ where: { id } });
  if (!tool) {
    throw new Error('Tool definition not found');
  }

  const updated = await prisma.toolDefinition.update({
    where: { id },
    data: updates,
  });

  invalidateToolCache(tool.tenantId);
  return updated;
}

// ════════════════════════════════════════════════════════════════════════════
// §4  createCustomTool()
// ════════════════════════════════════════════════════════════════════════════

interface CreateCustomToolData {
  name: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
  agentScope: string;
  webhookUrl?: string;
  webhookTimeout?: number;
}

/**
 * Create a custom (webhook-backed) tool for a tenant.
 * Validates unique name and description length.
 */
export async function createCustomTool(
  tenantId: string,
  data: CreateCustomToolData,
  prisma: PrismaClient,
): Promise<ToolDefinition> {
  // Validate name format (slug-like)
  if (!data.name || !/^[a-z][a-z0-9_]*$/.test(data.name)) {
    const err = new Error('Name must start with a lowercase letter and contain only lowercase letters, numbers, and underscores') as any;
    err.field = 'name';
    throw err;
  }

  // Validate description
  if (!data.description || data.description.length < 10) {
    const err = new Error('Description must be at least 10 characters') as any;
    err.field = 'description';
    throw err;
  }

  // Validate agentScope
  const VALID_STATUSES = ['INQUIRY', 'PENDING', 'CONFIRMED', 'CHECKED_IN'];
  const scopeStatuses = data.agentScope.split(',').map(s => s.trim());
  if (scopeStatuses.length === 0 || !scopeStatuses.every(s => VALID_STATUSES.includes(s))) {
    const err = new Error('agentScope must be comma-separated booking statuses: INQUIRY,PENDING,CONFIRMED,CHECKED_IN') as any;
    err.field = 'agentScope';
    throw err;
  }

  // Check unique name
  const existing = await prisma.toolDefinition.findUnique({
    where: { tenantId_name: { tenantId, name: data.name } },
  });
  if (existing) {
    const err = new Error(`A tool with name "${data.name}" already exists`) as any;
    err.field = 'name';
    throw err;
  }

  const tool = await prisma.toolDefinition.create({
    data: {
      tenantId,
      name: data.name,
      displayName: data.displayName,
      description: data.description,
      defaultDescription: data.description,
      parameters: data.parameters as unknown as Prisma.InputJsonValue,
      agentScope: data.agentScope,
      type: 'custom',
      enabled: true,
      webhookUrl: data.webhookUrl || null,
      webhookTimeout: data.webhookTimeout ?? 10000,
    },
  });

  invalidateToolCache(tenantId);
  return tool;
}

// ════════════════════════════════════════════════════════════════════════════
// §5  deleteCustomTool()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Delete a custom tool. Rejects deletion of system tools.
 */
export async function deleteCustomTool(
  id: string,
  prisma: PrismaClient,
): Promise<void> {
  const tool = await prisma.toolDefinition.findUnique({ where: { id } });
  if (!tool) {
    throw new Error('Tool definition not found');
  }
  if (tool.type === 'system') {
    const err = new Error('Cannot delete system tools') as any;
    err.status = 403;
    throw err;
  }

  await prisma.toolDefinition.delete({ where: { id } });
  invalidateToolCache(tool.tenantId);
}

// ════════════════════════════════════════════════════════════════════════════
// §6  resetDescription()
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reset a tool's description to its defaultDescription.
 */
export async function resetDescription(
  id: string,
  prisma: PrismaClient,
): Promise<ToolDefinition> {
  const tool = await prisma.toolDefinition.findUnique({ where: { id } });
  if (!tool) {
    throw new Error('Tool definition not found');
  }

  const updated = await prisma.toolDefinition.update({
    where: { id },
    data: { description: tool.defaultDescription },
  });

  invalidateToolCache(tool.tenantId);
  return updated;
}
