import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { authMiddleware } from '../middleware/auth';
import { getAiConfig } from '../services/ai-config.service';
import { getTenantAiConfig } from '../services/tenant-config.service';
import { retrieveRelevantKnowledge, getAndClearLastClassifierResult } from '../services/rag.service';
import { getSopContent } from '../services/classifier.service';
import { detectEscalationSignals } from '../services/escalation-enrichment.service';
import { extractIntent } from '../services/intent-extractor.service';
import { searchAvailableProperties } from '../services/property-search.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Retry helper (same as ai.service.ts) ────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err: any) {
      lastErr = err;
      if (err?.status === 529 || err?.status === 429 || err?.error?.type === 'overloaded_error') {
        const delay = Math.min(1000 * 2 ** i, 8000);
        console.warn(`[Sandbox] Retry ${i + 1}/${maxRetries} after ${delay}ms (${err?.status || 'overloaded'})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Code fence stripper (same as ai.service.ts) ─────────────────────────────
function stripCodeFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    if (firstNewline !== -1) s = s.substring(firstNewline + 1);
  }
  if (s.endsWith('```')) s = s.substring(0, s.lastIndexOf('```'));
  return s.trim();
}

// ─── Build property info block (same as ai.service.ts) ───────────────────────
function buildPropertyInfo(
  guestName: string, checkIn: string, checkOut: string, guestCount: number,
  listing: {
    name?: string; address?: string; doorSecurityCode?: string;
    wifiUsername?: string; wifiPassword?: string;
  },
  retrievedChunks: Array<{ content: string; category: string }>,
  reservationStatus: string,
): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ci = new Date(checkIn); ci.setHours(0, 0, 0, 0);
  const co = new Date(checkOut); co.setHours(0, 0, 0, 0);
  const bookingStatusDisplay = (() => {
    switch (reservationStatus) {
      case 'INQUIRY': return 'Inquiry (pre-booking)';
      case 'CONFIRMED':
        if (ci.getTime() === today.getTime()) return 'Confirmed (Checking in today)';
        if (ci > today) return 'Confirmed (Upcoming)';
        return 'Confirmed';
      case 'CHECKED_IN':
        if (co.getTime() === today.getTime()) return 'Checked In (Checking out today)';
        return 'Checked In';
      case 'CHECKED_OUT': return 'Checked Out';
      case 'CANCELLED': return 'Cancelled';
      default: return reservationStatus;
    }
  })();

  let info = `## PROPERTY DATA — AUTHORITATIVE SOURCE
CRITICAL INSTRUCTION: You MUST only answer questions using data explicitly listed in this section.
If a guest asks about something not listed here, respond with "Let me check on that for you" and set escalate to true.
NEVER use general hotel, apartment, or hospitality knowledge to fill information gaps. If it is not listed below, it does not exist.

### RESERVATION DETAILS
Guest Name: ${guestName}
Booking Status: ${bookingStatusDisplay}
Check-in: ${checkIn}
Check-out: ${checkOut}
Number of Guests: ${guestCount}
`;

  if (reservationStatus === 'CONFIRMED' || reservationStatus === 'CHECKED_IN') {
    info += '\n### ACCESS & CONNECTIVITY\n';
    if (listing.doorSecurityCode && listing.doorSecurityCode !== 'N/A') {
      info += `Door Code: ${listing.doorSecurityCode}\n`;
    }
    if (listing.wifiUsername && listing.wifiUsername !== 'N/A') {
      info += `WiFi Network Name: ${listing.wifiUsername}\n`;
    }
    if (listing.wifiPassword && listing.wifiPassword !== 'N/A') {
      info += `WiFi Password: ${listing.wifiPassword}\n`;
    }
  }

  if (retrievedChunks.length > 0) {
    info += '\n### RELEVANT PROCEDURES & KNOWLEDGE\n';
    info += "The following was retrieved based on the guest's current question:\n";
    for (const chunk of retrievedChunks) {
      info += `[${chunk.category}] ${chunk.content}\n`;
    }
  }

  return info;
}

// ─── Content block builder (same as ai.service.ts) ───────────────────────────
type ContentBlock = { type: 'text'; text: string };

function buildContentBlocks(
  template: string | undefined,
  vars: Record<string, string>,
): ContentBlock[] {
  if (!template) {
    return [
      { type: 'text', text: `### CONVERSATION HISTORY ###\n${vars.conversationHistory || ''}` },
      { type: 'text', text: `### PROPERTY & GUEST INFO ###\n\n${vars.propertyInfo || ''}` },
      { type: 'text', text: `### CURRENT GUEST MESSAGE(S) ###\n${vars.currentMessages || ''}\n\n### CURRENT LOCAL TIME###\n${vars.localTime || ''}` },
    ];
  }
  const sections = template.split(/(?=### )/).filter(s => s.trim());
  return sections.map(section => {
    let text = section;
    for (const [key, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return { type: 'text' as const, text };
  });
}

export function sandboxRouter(prisma: PrismaClient) {
  const router = Router();

  router.post('/chat', authMiddleware as any, async (req: any, res) => {
    const startMs = Date.now();
    try {
      const tenantId = req.tenantId as string;
      const {
        propertyId,
        reservationStatus,
        channel,
        guestName,
        checkIn,
        checkOut,
        guestCount,
        messages,
      } = req.body as {
        propertyId: string;
        reservationStatus: string;
        channel: string;
        guestName: string;
        checkIn: string;
        checkOut: string;
        guestCount: number;
        messages: Array<{ role: 'guest' | 'host'; content: string }>;
      };

      if (!propertyId || !messages || messages.length === 0) {
        res.status(400).json({ error: 'propertyId and messages are required' });
        return;
      }

      // ── Load property + tenant data ──────────────────────────────────────
      const [property, tenant, tenantConfig] = await Promise.all([
        prisma.property.findFirst({ where: { id: propertyId, tenantId } }),
        prisma.tenant.findUnique({ where: { id: tenantId } }),
        getTenantAiConfig(tenantId, prisma).catch(() => null),
      ]);

      if (!property) { res.status(404).json({ error: 'Property not found' }); return; }
      if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return; }

      const kb = property.customKnowledgeBase as Record<string, unknown>;
      const listing = {
        name: property.name,
        address: property.address || (kb?.address as string) || '',
        doorSecurityCode: (kb?.doorSecurityCode as string) || (kb?.door_security_code as string) || undefined,
        wifiUsername: (kb?.wifiUsername as string) || (kb?.wifi_username as string) || undefined,
        wifiPassword: (kb?.wifiPassword as string) || (kb?.wifi_password as string) || undefined,
      };

      const isInquiry = reservationStatus === 'INQUIRY';
      const aiCfg = getAiConfig();
      const agentName = isInquiry ? 'screeningAI' : 'guestCoordinator';
      const personaCfg = isInquiry ? aiCfg.screeningAI : aiCfg.guestCoordinator;

      // ── Build conversation history text ────────────────────────────────
      const historyText = messages
        .map(m => `${m.role === 'guest' ? 'Guest' : (tenantConfig?.agentName || 'Omar')}: ${m.content}`)
        .join('\n');

      // Current message = last guest message(s)
      const lastGuestMessages = [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'guest') lastGuestMessages.unshift(messages[i]);
        else break;
      }
      const currentMsgsText = lastGuestMessages.map(m => `Guest: ${m.content}`).join('\n');
      const ragQuery = lastGuestMessages.map(m => m.content).join(' ');

      if (!currentMsgsText.trim()) {
        res.status(400).json({ error: 'No guest messages to respond to' });
        return;
      }

      // ── RAG retrieval ──────────────────────────────────────────────────
      const propertyAmenities = kb?.amenities ? String(kb.amenities) : undefined;
      const recentForRag = messages.slice(-10).map(m => ({
        role: m.role === 'guest' ? 'guest' : 'host',
        content: m.content,
      }));

      const ragResult = tenantConfig?.ragEnabled !== false
        ? await retrieveRelevantKnowledge(
            tenantId, propertyId, ragQuery, prisma, 8,
            isInquiry ? 'screeningAI' : 'guestCoordinator',
            undefined, recentForRag, propertyAmenities
          ).catch(() => ({
            chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>,
            topSimilarity: 0,
            tier: 'tier2_needed' as const,
            confidenceTier: undefined as 'high' | 'medium' | 'low' | undefined,
            topCandidates: undefined as Array<{ label: string; confidence: number }> | undefined,
          }))
        : {
            chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>,
            topSimilarity: 0,
            tier: 'tier1' as const,
            confidenceTier: undefined as 'high' | 'medium' | 'low' | undefined,
            topCandidates: undefined as Array<{ label: string; confidence: number }> | undefined,
          };

      let retrievedChunks = ragResult.chunks;
      // Clear classifier state if any
      getAndClearLastClassifierResult();

      // ── Tier 2: Intent extraction for non-high confidence ─────────────
      let tier2Output: { topic: string; status: string; urgency: string; sops: string[] } | null = null;
      if (ragResult.confidenceTier !== 'high') {
        try {
          const tier2Result = await extractIntent(recentForRag, tenantId, 'sandbox');
          if (tier2Result) {
            tier2Output = { topic: tier2Result.topic, status: tier2Result.status, urgency: tier2Result.urgency, sops: tier2Result.sops };
            if (tier2Result.sops.length > 0) {
              const tier2Chunks = tier2Result.sops
                .map(label => {
                  const content = getSopContent(label, propertyAmenities);
                  return content ? { content, category: label, similarity: 1.0, sourceKey: label, propertyId: null as string | null } : null;
                })
                .filter((c): c is NonNullable<typeof c> => c !== null);
              if (tier2Chunks.length > 0) {
                retrievedChunks.push(...tier2Chunks);
              }
            }
          }
        } catch (err) {
          console.warn('[Sandbox] Tier 2 failed (non-fatal):', err);
        }
      }

      // Deduplicate chunks by category
      {
        const seen = new Set<string>();
        retrievedChunks = retrievedChunks.filter(c => {
          if (seen.has(c.category)) return false;
          seen.add(c.category);
          return true;
        });
      }

      // ── Escalation signals ─────────────────────────────────────────────
      const escalationSignals = detectEscalationSignals(ragQuery);

      // ── Build prompt ───────────────────────────────────────────────────
      let propertyInfo = buildPropertyInfo(
        guestName || 'Test Guest', checkIn, checkOut, guestCount || 2,
        listing, retrievedChunks, reservationStatus,
      );

      if (escalationSignals.length > 0) {
        propertyInfo += '\n### SYSTEM SIGNALS\n';
        propertyInfo += escalationSignals.map(s => s.signal).join('\n');
        propertyInfo += '\nNote: These signals were automatically detected from the guest message. Consider them when deciding whether to escalate.\n';
      }

      const localTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });

      // Approved knowledge base
      const approvedKnowledge = await prisma.knowledgeSuggestion.findMany({
        where: {
          tenantId,
          status: 'approved',
          OR: [{ propertyId }, { propertyId: null }],
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      });
      const knowledgeText = approvedKnowledge.length > 0
        ? approvedKnowledge.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n')
        : 'No additional Q&A available.';

      const effectiveModel = tenantConfig?.model || personaCfg.model;
      const effectiveTemperature = tenantConfig?.temperature ?? personaCfg.temperature;
      const effectiveMaxTokens = tenantConfig?.maxTokens || personaCfg.maxTokens;
      const effectiveAgentName = tenantConfig?.agentName || agentName;

      let effectiveSystemPrompt = personaCfg.systemPrompt;
      if (tenantConfig?.agentName && tenantConfig.agentName !== 'Omar') {
        effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName);
      }
      if (tenantConfig?.customInstructions) {
        effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\n${tenantConfig.customInstructions}`;
      }

      const templateVars = {
        conversationHistory: historyText,
        propertyInfo,
        currentMessages: currentMsgsText,
        localTime,
        openTasks: 'No open tasks.',
        knowledgeBase: knowledgeText,
      };

      const userContent = buildContentBlocks(personaCfg.contentBlockTemplate, templateVars);

      // ── Tool definitions (INQUIRY only — property search) ──────────────
      const toolsForCall: Anthropic.Tool[] | undefined = isInquiry ? [{
        name: 'search_available_properties',
        description: 'Search for alternative properties in the same city that match specific criteria and are available for the guest\'s dates.',
        input_schema: {
          type: 'object' as const,
          properties: {
            amenities: { type: 'array', items: { type: 'string' }, description: 'Amenities the guest is looking for' },
            min_capacity: { type: 'number', description: 'Minimum guest capacity' },
            reason: { type: 'string', description: 'Brief reason for the search' },
          },
          required: ['amenities', 'reason'],
        },
      }] : undefined;

      // ── Call Claude ────────────────────────────────────────────────────
      const createParams: any = {
        model: effectiveModel,
        max_tokens: effectiveMaxTokens,
        ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
        ...(personaCfg.topK !== undefined ? { top_k: personaCfg.topK } : {}),
        ...(personaCfg.topP !== undefined ? { top_p: personaCfg.topP } : {}),
        ...(personaCfg.stopSequences?.length ? { stop_sequences: personaCfg.stopSequences } : {}),
        ...(toolsForCall?.length ? { tools: toolsForCall, tool_choice: { type: 'auto' as const } } : {}),
        system: [{ type: 'text', text: effectiveSystemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userContent as Anthropic.ContentBlock[] }],
      };
      const createOpts: any = { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } };

      let response = await withRetry(() =>
        (anthropic.messages.create as any)(createParams, createOpts)
      ) as Anthropic.Message;

      // ── Tool use loop ──────────────────────────────────────────────────
      let toolUsed = false;
      let toolName: string | undefined;
      let toolInput: any;
      let toolResults: any;
      let toolDurationMs: number | undefined;

      if (response.stop_reason === 'tool_use' && isInquiry) {
        const toolUseBlock = response.content.find((b: any) => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
        if (toolUseBlock) {
          toolUsed = true;
          toolName = toolUseBlock.name;
          toolInput = toolUseBlock.input;
          const toolStartMs = Date.now();

          let toolResultContent: string;
          try {
            const typedInput = toolUseBlock.input as { amenities: string[]; min_capacity?: number; reason?: string };
            const currentAddress = listing.address || '';
            const cityParts = currentAddress.split(',').map(s => s.trim()).filter(Boolean);
            const currentCity = cityParts[cityParts.length - 1] || cityParts[0] || '';
            toolResultContent = await searchAvailableProperties(typedInput, {
              tenantId,
              currentPropertyId: propertyId,
              checkIn, checkOut,
              channel: channel || 'DIRECT',
              hostawayAccountId: tenant.hostawayAccountId,
              hostawayApiKey: tenant.hostawayApiKey,
              currentCity,
            });
          } catch (toolErr) {
            console.error('[Sandbox] Tool handler error:', toolErr);
            toolResultContent = JSON.stringify({ error: 'Tool execution failed', found: false, properties: [] });
          }
          toolDurationMs = Date.now() - toolStartMs;
          try { toolResults = JSON.parse(toolResultContent); } catch { toolResults = toolResultContent; }

          // Follow up with tool result
          const followUpParams: any = {
            ...createParams,
            messages: [
              { role: 'user', content: userContent as Anthropic.ContentBlock[] },
              { role: 'assistant', content: response.content },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResultContent }] },
            ],
          };
          response = await withRetry(() =>
            (anthropic.messages.create as any)(followUpParams, createOpts)
          ) as Anthropic.Message;
        }
      }

      // ── Extract response text ──────────────────────────────────────────
      const textBlock = response.content.find((b: any) => b.type === 'text');
      const rawResponseText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      const durationMs = Date.now() - startMs;

      // ── Parse JSON response ────────────────────────────────────────────
      let responseMessage = rawResponseText;
      let escalation: { title: string; note: string; urgency: string } | null = null;
      let manager: { needed: boolean; title: string; note: string } | null = null;

      try {
        const cleaned = stripCodeFences(rawResponseText);
        if (isInquiry) {
          const parsed = JSON.parse(cleaned) as { 'guest message': string; manager?: { needed: boolean; title: string; note: string } };
          responseMessage = parsed['guest message'] || rawResponseText;
          if (parsed.manager) manager = parsed.manager;
        } else {
          const parsed = JSON.parse(cleaned) as { guest_message: string; escalation: { title: string; note: string; urgency: string } | null };
          responseMessage = parsed.guest_message || rawResponseText;
          escalation = parsed.escalation || null;
        }
      } catch {
        // If JSON parse fails, use the raw text as the response
        console.warn('[Sandbox] JSON parse failed — using raw response text');
      }

      res.json({
        response: responseMessage,
        escalation,
        manager,
        toolUsed,
        toolName,
        toolInput,
        toolResults,
        toolDurationMs,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        durationMs,
        model: effectiveModel,
      });
    } catch (err: any) {
      console.error('[Sandbox] Chat error:', err);
      res.status(500).json({ error: err.message || 'Sandbox chat failed' });
    }
  });

  return router;
}
