import { Response } from 'express';
import crypto from 'crypto';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { getAiConfig, updateAiConfig } from '../services/ai-config.service';
import {
  SEED_COORDINATOR_PROMPT,
  SEED_SCREENING_PROMPT,
  createMessage,
  stripCodeFences,
  buildPropertyInfo,
  ToolHandler,
  getAiApiLog,
} from '../services/ai.service';
import type { ContentBlock } from '../services/ai.service';
import { getTenantAiConfig } from '../services/tenant-config.service';
import { searchAvailableProperties } from '../services/property-search.service';
import { checkExtendAvailability } from '../services/extend-stay.service';
import { getAvailableVariables } from '../services/template-variable.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Config cache for GET endpoint ──────────────────────────────────────────
// Pre-serialize and compute ETag once; invalidated on update.
let _cachedConfigJson: string | null = null;
let _cachedConfigEtag: string | null = null;

function getCachedConfigResponse(): { json: string; etag: string } {
  if (!_cachedConfigJson) {
    _cachedConfigJson = JSON.stringify(getAiConfig());
    _cachedConfigEtag = `"${crypto.createHash('md5').update(_cachedConfigJson).digest('hex')}"`;
  }
  return { json: _cachedConfigJson, etag: _cachedConfigEtag! };
}

function invalidateConfigCache(): void {
  _cachedConfigJson = null;
  _cachedConfigEtag = null;
}

export function makeAiConfigController(prisma: PrismaClient) {
  return {
    async get(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { json, etag } = getCachedConfigResponse();

        // ETag-based 304 Not Modified
        if (req.headers['if-none-match'] === etag) {
          res.status(304).end();
          return;
        }

        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
        res.setHeader('Content-Type', 'application/json');
        res.send(json);
      } catch (err) {
        console.error('[AiConfig] get error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async update(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        invalidateConfigCache();
        const updated = updateAiConfig(req.body);

        // Save a version snapshot
        try {
          const tenantId = req.tenantId;
          const lastVersion = await prisma.aiConfigVersion.findFirst({
            where: { tenantId },
            orderBy: { version: 'desc' },
          });
          const nextVersion = (lastVersion?.version ?? 0) + 1;
          await prisma.aiConfigVersion.create({
            data: {
              tenantId,
              version: nextVersion,
              config: updated as any,
              note: req.body._versionNote || null,
            },
          });
        } catch (vErr) {
          console.error('[AiConfig] version save error (non-fatal):', vErr);
        }

        res.json(updated);
      } catch (err) {
        console.error('[AiConfig] update error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async test(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const { systemPrompt, userMessage, model, temperature, maxTokens } = req.body;
        if (!systemPrompt || !userMessage) {
          res.status(400).json({ error: 'systemPrompt and userMessage are required' });
          return;
        }
        const startMs = Date.now();
        const response = await (openai.responses as any).create({
          model: model || 'gpt-5.4-mini-2026-03-17',
          max_output_tokens: maxTokens || 2048,
          ...(temperature !== undefined ? { temperature } : {}),
          instructions: systemPrompt,
          input: userMessage,
          reasoning: { effort: 'none' },
          store: true,
        });
        const responseText = response.output_text || '';
        res.json({
          response: responseText,
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          durationMs: Date.now() - startMs,
          model: model || 'gpt-5.4-mini-2026-03-17',
        });
      } catch (err) {
        console.error('[AiConfig] test error:', err);
        res.status(500).json({ error: err instanceof Error ? err.message : 'Test failed' });
      }
    },

    async listVersions(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const versions = await prisma.aiConfigVersion.findMany({
          where: { tenantId },
          orderBy: { version: 'desc' },
          take: 20,
        });
        res.json(versions.map(v => ({
          id: v.id,
          version: v.version,
          config: v.config,
          note: v.note,
          createdAt: v.createdAt.toISOString(),
        })));
      } catch (err) {
        console.error('[AiConfig] listVersions error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    async revertVersion(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const tenantId = req.tenantId;
        const versionId = req.params.id;
        const version = await prisma.aiConfigVersion.findFirst({
          where: { id: versionId, tenantId },
        });
        if (!version) {
          res.status(404).json({ error: 'Version not found' });
          return;
        }
        invalidateConfigCache();
        const updated = updateAiConfig(version.config as any);

        // Save a new version noting the revert
        try {
          const lastVersion = await prisma.aiConfigVersion.findFirst({
            where: { tenantId },
            orderBy: { version: 'desc' },
          });
          const nextVersion = (lastVersion?.version ?? 0) + 1;
          await prisma.aiConfigVersion.create({
            data: {
              tenantId,
              version: nextVersion,
              config: updated as any,
              note: `Reverted to version ${version.version}`,
            },
          });
        } catch (vErr) {
          console.error('[AiConfig] revert version save error (non-fatal):', vErr);
        }

        res.json(updated);
      } catch (err) {
        console.error('[AiConfig] revertVersion error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // ─── Template Variables — list available prompt variables for the editor ─────
    async getTemplateVariables(req: AuthenticatedRequest, res: Response): Promise<void> {
      try {
        const agent = (req.query.agent as string) || 'coordinator';
        if (agent !== 'coordinator' && agent !== 'screening') {
          res.status(400).json({ error: 'agent must be "coordinator" or "screening"' });
          return;
        }
        const variables = getAvailableVariables(agent).map(v => ({
          name: v.name,
          description: v.description,
          essential: v.essential,
          propertyBound: v.propertyBound,
        }));
        res.json(variables);
      } catch (err) {
        console.error('[AiConfig] getTemplateVariables error:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    },

    // ─── Sandbox Chat — test AI responses without creating real bookings ────────
    async sandboxChat(req: AuthenticatedRequest, res: Response): Promise<void> {
      const startMs = Date.now();
      try {
        const tenantId = req.tenantId;
        const {
          propertyId,
          reservationStatus,
          channel,
          guestName,
          checkIn,
          checkOut,
          guestCount,
          messages,
        } = req.body;

        // ── Validate required fields ──────────────────────────────────────────
        if (!propertyId || !reservationStatus || !guestName || !checkIn || !checkOut || !messages?.length) {
          res.status(400).json({
            error: 'Required fields: propertyId, reservationStatus, guestName, checkIn, checkOut, messages (non-empty)',
          });
          return;
        }

        // ── Load property (tenant-scoped) ─────────────────────────────────────
        const property = await prisma.property.findFirst({
          where: { id: propertyId, tenantId },
        });
        if (!property) {
          res.status(404).json({ error: 'Property not found' });
          return;
        }

        // ── Load tenant (for Hostaway creds — needed by property search tool) ─
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
          res.status(404).json({ error: 'Tenant not found' });
          return;
        }

        // ── Load per-tenant AI config ─────────────────────────────────────────
        const tenantConfig = await getTenantAiConfig(tenantId, prisma).catch(() => null);
        const aiCfg = getAiConfig();

        const isInquiry = reservationStatus === 'INQUIRY';
        const agentName = isInquiry ? 'screeningAI' : 'guestCoordinator';
        const personaCfg = isInquiry ? aiCfg.screeningAI : aiCfg.guestCoordinator;

        // ── Build effective model settings ────────────────────────────────────
        // Migrate legacy model names to GPT-5.4 Mini
        const rawModel = tenantConfig?.model || personaCfg.model;
        const effectiveModel = rawModel?.startsWith('claude-') ? 'gpt-5.4-mini-2026-03-17' : rawModel;
        const effectiveTemperature = tenantConfig?.temperature ?? personaCfg.temperature;
        const effectiveMaxTokens = tenantConfig?.maxTokens || personaCfg.maxTokens;
        const effectiveAgentName = tenantConfig?.agentName || agentName;

        // ── Build system prompt ───────────────────────────────────────────────
        let effectiveSystemPrompt = isInquiry
          ? (tenantConfig?.systemPromptScreening || SEED_SCREENING_PROMPT)
          : (tenantConfig?.systemPromptCoordinator || SEED_COORDINATOR_PROMPT);
        if (tenantConfig?.agentName && tenantConfig.agentName !== 'Omar') {
          effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName);
        }
        if (tenantConfig?.customInstructions) {
          effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\nThe following instructions are specific to this property and override general guidelines where they conflict:\n${tenantConfig.customInstructions}`;
        }

        // ── Build listing object from property's customKnowledgeBase ──────────
        const customKb = (property.customKnowledgeBase as Record<string, unknown> | null) ?? {};
        const listing = {
          name: property.name,
          internalListingName: property.name,
          address: property.address || (customKb.address as string) || '',
          doorSecurityCode: (customKb.doorCode as string) || undefined,
          wifiUsername: (customKb.wifiName as string) || undefined,
          wifiPassword: (customKb.wifiPassword as string) || undefined,
        };

        // ── Build property info (same as real pipeline) ───────────────────────
        const propertyInfo = buildPropertyInfo(
          guestName,
          checkIn,
          checkOut,
          guestCount || 1,
          listing,
          undefined, // no RAG chunks in sandbox (keeps it simple + fast)
          reservationStatus,
        );

        // ── Build conversation history text ───────────────────────────────────
        // Replicate the format from generateAndSendAiReply: "Guest: ..." / "Omar: ..."
        const allMessages = messages as Array<{ role: 'guest' | 'host'; content: string }>;
        const historyMsgs = allMessages.slice(0, -1); // all but the last message = history
        const currentMsgs = allMessages.slice(-1);     // last message = current

        const historyText = historyMsgs.length > 0
          ? historyMsgs.map((m: { role: string; content: string }) =>
              `${m.role === 'guest' ? 'Guest' : effectiveAgentName}: ${m.content}`
            ).join('\n')
          : 'No previous messages.';

        const currentMsgsText = currentMsgs
          .filter((m: { role: string }) => m.role === 'guest')
          .map((m: { content: string }) => `Guest: ${m.content}`)
          .join('\n');

        // If the last message is from the host, treat it as just history context
        // and there's no current guest message to respond to
        if (!currentMsgsText.trim()) {
          res.status(400).json({ error: 'Last message must be from a guest (role: "guest")' });
          return;
        }

        const localTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });

        // ── Build content blocks (same format as real pipeline) ───────────────
        const templateVars: Record<string, string> = {
          conversationHistory: historyText,
          propertyInfo,
          currentMessages: currentMsgsText,
          localTime,
          openTasks: 'No open tasks.',
          knowledgeBase: 'No additional Q&A available.',
        };

        let userContent: ContentBlock[];
        if (personaCfg.contentBlockTemplate) {
          // Split template on ### headers and interpolate {{variables}}
          const sections = personaCfg.contentBlockTemplate.split(/(?=### )/).filter((s: string) => s.trim());
          userContent = sections.map((section: string) => {
            let text = section;
            for (const [key, value] of Object.entries(templateVars)) {
              text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
            }
            return { type: 'text' as const, text };
          });
        } else {
          // Fallback: hardcoded default content blocks
          userContent = [
            { type: 'text' as const, text: `### CONVERSATION HISTORY ###\n${historyText}` },
            { type: 'text' as const, text: `### PROPERTY & GUEST INFO ###\n\n${propertyInfo}` },
            { type: 'text' as const, text: `### CURRENT GUEST MESSAGE(S) ###\n${currentMsgsText}\n\n### CURRENT LOCAL TIME###\n${localTime}` },
          ];
        }

        // ── Set up tools — per-agent tools ──────────────────────────────────
        // Screening agent (INQUIRY): property search tool
        // Guest coordinator (CONFIRMED/CHECKED_IN): extend-stay tool

        // Look up hostawayListingId for extend-stay tool
        let hostawayListingId = '';
        if (!isInquiry) {
          try {
            const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { hostawayListingId: true } });
            hostawayListingId = prop?.hostawayListingId || '';
          } catch { /* fallback: empty */ }
        }

        const toolsForCall: any[] = isInquiry ? [{
          name: 'search_available_properties',
          description: 'Search for alternative properties in the same city that match specific criteria and are available for the guest\'s dates. Use this when a guest asks about amenities or features this property doesn\'t have, wants to see other options, or expresses a preference for different property attributes (size, view, amenities). Do NOT use this when the guest is asking about amenities this property already has.',
          input_schema: {
            type: 'object' as const,
            properties: {
              amenities: { type: 'array', items: { type: 'string' }, description: 'Amenities or features the guest is looking for, e.g. [\'pool\', \'parking\', \'sea view\']. Use simple English terms.' },
              min_capacity: { type: 'number', description: 'Minimum number of guests the property should accommodate. Only include if the guest mentioned needing more space or has a specific group size.' },
              reason: { type: 'string', description: 'Brief reason for the search, e.g. \'guest asked for pool\'. Used for logging.' },
            },
            required: ['amenities', 'reason'],
          },
        }] : [{
          name: 'check_extend_availability',
          description: 'Check if the guest\'s current property is available for extended or modified dates, and calculate the price for additional nights. Use this when a guest asks to extend their stay, shorten their stay, change dates, or asks how much extra nights would cost. Do NOT use for unrelated questions.',
          input_schema: {
            type: 'object' as const,
            properties: {
              new_checkout: { type: 'string', description: 'The requested new checkout date in YYYY-MM-DD format.' },
              new_checkin: { type: 'string', description: 'The requested new check-in date in YYYY-MM-DD format. Only needed if the guest wants to arrive earlier or later.' },
              reason: { type: 'string', description: 'Brief reason, e.g. \'guest wants 2 more nights\'. Used for logging.' },
            },
            required: ['new_checkout', 'reason'],
          },
        }];

        const ragContext: any = {
          query: currentMsgsText,
          chunks: [],
          totalRetrieved: 0,
          durationMs: 0,
        };

        const toolHandlersForCall: Map<string, ToolHandler> = isInquiry ? new Map([
          ['search_available_properties', async (input: unknown) => {
            const typedInput = input as { amenities: string[]; min_capacity?: number; reason?: string };
            const currentAddress = listing.address || (customKb.address as string) || '';
            const cityParts = currentAddress.split(',').map((s: string) => s.trim()).filter(Boolean);
            const currentCity = cityParts[cityParts.length - 1] || cityParts[0] || '';
            return searchAvailableProperties(typedInput, {
              tenantId,
              currentPropertyId: propertyId,
              checkIn,
              checkOut,
              channel: channel || 'DIRECT',
              hostawayAccountId: tenant.hostawayAccountId,
              hostawayApiKey: tenant.hostawayApiKey,
              currentCity,
            });
          }],
        ]) : new Map([
          ['check_extend_availability', async (input: unknown) => {
            return checkExtendAvailability(input, {
              listingId: hostawayListingId,
              currentCheckIn: checkIn,
              currentCheckOut: checkOut,
              channel: channel || 'DIRECT',
              numberOfGuests: guestCount || 1,
              hostawayAccountId: tenant.hostawayAccountId,
              hostawayApiKey: tenant.hostawayApiKey,
            });
          }],
        ]);

        // ── Call AI ───────────────────────────────────────────────────────────
        const rawResponse = await createMessage(effectiveSystemPrompt, userContent, {
          model: effectiveModel,
          temperature: effectiveTemperature,
          maxTokens: effectiveMaxTokens,
          ...(personaCfg.topK !== undefined ? { topK: personaCfg.topK } : {}),
          ...(personaCfg.topP !== undefined ? { topP: personaCfg.topP } : {}),
          ...(personaCfg.stopSequences?.length ? { stopSequences: personaCfg.stopSequences } : {}),
          agentName: effectiveAgentName,
          tenantId,
          ragContext,
          tools: toolsForCall,
          toolHandlers: toolHandlersForCall,
        });

        const durationMs = Date.now() - startMs;

        // Grab token counts from the most recent log entry (createMessage pushes to ring buffer)
        const latestLog = getAiApiLog()[0];
        const inputTokens = latestLog?.inputTokens ?? 0;
        const outputTokens = latestLog?.outputTokens ?? 0;

        // ── Parse the JSON response ───────────────────────────────────────────
        try {
          const cleaned = stripCodeFences(rawResponse);
          if (isInquiry) {
            const parsed = JSON.parse(cleaned) as {
              'guest message': string;
              manager?: { needed: boolean; title: string; note: string };
            };
            res.json({
              response: parsed['guest message'] || '',
              manager: parsed.manager || null,
              escalation: null,
              toolUsed: ragContext.toolUsed || false,
              toolName: ragContext.toolName || undefined,
              toolInput: ragContext.toolInput || undefined,
              toolResults: ragContext.toolResults || undefined,
              toolDurationMs: ragContext.toolDurationMs || undefined,
              inputTokens,
              outputTokens,
              durationMs,
              model: effectiveModel,
            });
          } else {
            const parsed = JSON.parse(cleaned) as {
              guest_message: string;
              escalation: { title: string; note: string; urgency: string } | null;
            };
            res.json({
              response: parsed.guest_message || '',
              escalation: parsed.escalation || null,
              manager: null,
              toolUsed: ragContext.toolUsed || false,
              toolName: ragContext.toolName || undefined,
              toolInput: ragContext.toolInput || undefined,
              toolResults: ragContext.toolResults || undefined,
              toolDurationMs: ragContext.toolDurationMs || undefined,
              inputTokens,
              outputTokens,
              durationMs,
              model: effectiveModel,
            });
          }
        } catch (parseErr) {
          // Return raw response if JSON parsing fails — useful for debugging
          res.json({
            response: rawResponse,
            parseError: true,
            escalation: null,
            manager: null,
            toolUsed: ragContext.toolUsed || false,
            toolName: ragContext.toolName || undefined,
            toolInput: ragContext.toolInput || undefined,
            toolResults: ragContext.toolResults || undefined,
            toolDurationMs: ragContext.toolDurationMs || undefined,
            inputTokens,
            outputTokens,
            durationMs: Date.now() - startMs,
            model: effectiveModel,
          });
        }
      } catch (err) {
        console.error('[AiConfig] sandboxChat error:', err);
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Sandbox chat failed',
          durationMs: Date.now() - startMs,
        });
      }
    },
  };
}
