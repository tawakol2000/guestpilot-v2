import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { authMiddleware } from '../middleware/auth';
import { getAiConfig } from '../services/ai-config.service';
import { getTenantAiConfig } from '../services/tenant-config.service';
import { retrieveRelevantKnowledge } from '../services/rag.service';
import { getSopContent, buildToolDefinition } from '../services/sop.service';
import { detectEscalationSignals } from '../services/escalation-enrichment.service';
import { searchAvailableProperties } from '../services/property-search.service';
import { checkExtendAvailability } from '../services/extend-stay.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Retry helper (same as ai.service.ts) ────────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err: any) {
      lastErr = err;
      if (err?.status === 429 || err?.error?.type === 'overloaded_error') {
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
          }))
        : {
            chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>,
            topSimilarity: 0,
          };

      const retrievedChunks = ragResult.chunks;

      // ── SOP Classification via Tool Use ─────────────────────────────
      // Single forced get_sop tool call — replaces the 3-tier pipeline.
      let sopClassification: { categories: string[]; confidence: string; reasoning: string; inputTokens: number; outputTokens: number; durationMs: number } = {
        categories: ['none'], confidence: 'low', reasoning: 'Classification not run', inputTokens: 0, outputTokens: 0, durationMs: 0,
      };
      try {
        const classificationUserText = `CONVERSATION:\n${recentForRag.map(m => `${m.role === 'guest' ? 'GUEST' : 'HOST'}: ${m.content}`).join('\n')}\n\nCLASSIFY THE LATEST GUEST MESSAGE.`;
        const sopToolDef = await buildToolDefinition(tenantId, prisma);
        const sopStart = Date.now();
        const sopResponse = await withRetry(() =>
          (openai.responses as any).create({
            model: 'gpt-5.4-mini-2026-03-17',
            max_output_tokens: 200,
            temperature: 0,
            instructions: personaCfg.systemPrompt,
            input: [{ role: 'user', content: classificationUserText }],
            tools: [sopToolDef],
            tool_choice: { type: 'function' as const, name: 'get_sop' },
            reasoning: { effort: 'none' },
            truncation: 'auto',
            store: true,
          })
        ) as any;
        const sopDurationMs = Date.now() - sopStart;
        const sopFnCall = sopResponse.output?.find((i: any) => i.type === 'function_call');
        if (sopFnCall) {
          const input = JSON.parse(sopFnCall.arguments) as { categories: string[]; confidence: string; reasoning: string };
          sopClassification = {
            categories: input.categories,
            confidence: input.confidence,
            reasoning: input.reasoning,
            inputTokens: sopResponse.usage?.input_tokens || 0,
            outputTokens: sopResponse.usage?.output_tokens || 0,
            durationMs: sopDurationMs,
          };
          console.log(`[Sandbox] SOP classification: [${input.categories.join(', ')}] confidence=${input.confidence} (${sopDurationMs}ms) — ${input.reasoning}`);
        } else {
          console.warn('[Sandbox] SOP classification returned no function_call — defaulting to none');
          sopClassification.durationMs = sopDurationMs;
          sopClassification.inputTokens = sopResponse.usage?.input_tokens || 0;
          sopClassification.outputTokens = sopResponse.usage?.output_tokens || 0;
        }
      } catch (err) {
        console.warn('[Sandbox] SOP classification failed (non-fatal):', err);
      }

      // Fetch SOP content for classified categories
      const sopCategories = sopClassification.categories.filter(c => c !== 'none' && c !== 'escalate');
      const sopTexts = await Promise.all(
        sopCategories.map(c => getSopContent(tenantId, c, reservationStatus || 'DEFAULT', propertyId, propertyAmenities, prisma))
      );
      const sopContent = sopTexts.filter(Boolean).join('\n\n---\n\n');

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

      // Migrate legacy model names to GPT-5.4 Mini
      const rawModel = tenantConfig?.model || personaCfg.model;
      const effectiveModel = rawModel?.startsWith('claude-') ? 'gpt-5.4-mini-2026-03-17' : rawModel;
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

      // Inject SOP content from tool classification into system prompt
      if (sopContent) {
        effectiveSystemPrompt += `\n\n## STANDARD OPERATING PROCEDURE\nFollow this procedure for the guest's current request:\n${sopContent}`;
      } else if (!sopClassification.categories.includes('none') && sopCategories.length > 0) {
        effectiveSystemPrompt += `\n\n## NOTE\nSOP temporarily unavailable. Respond helpfully based on your general knowledge and system instructions.`;
      }

      const templateVars = {
        conversationHistory: historyText,
        propertyInfo,
        currentMessages: currentMsgsText,
        localTime,
        openTasks: 'No open tasks.',
        knowledgeBase: knowledgeText,
      };

      // ── Tool definitions — identical to production (ai.service.ts) ──
      const toolsForCall: any[] = isInquiry ? [{
        type: 'function',
        name: 'search_available_properties',
        description: 'Search for alternative properties in the same city that match specific criteria and are available for the guest\'s dates. Use this when a guest asks about amenities or features this property doesn\'t have, wants to see other options, or expresses a preference for different property attributes (size, view, amenities). Do NOT use this when the guest is asking about amenities this property already has.',
        strict: true,
        parameters: {
          type: 'object' as const,
          properties: {
            amenities: { type: 'array', items: { type: 'string' }, description: 'Amenities or features the guest is looking for, e.g. [\'pool\', \'parking\', \'sea view\']. Use simple English terms.' },
            min_capacity: { type: ['number', 'null'], description: 'Minimum number of guests the property should accommodate. Only include if the guest mentioned needing more space or has a specific group size.' },
            reason: { type: 'string', description: 'Brief reason for the search, e.g. \'guest asked for pool\'. Used for logging.' },
          },
          required: ['amenities', 'reason', 'min_capacity'],
          additionalProperties: false,
        },
      }] : [{
        type: 'function',
        name: 'check_extend_availability',
        description: 'Check if the guest\'s current property is available for extended or modified dates, and calculate the price for additional nights. Use this when a guest asks to extend their stay, shorten their stay, change dates, or asks how much extra nights would cost. Do NOT use for unrelated questions.',
        strict: true,
        parameters: {
          type: 'object' as const,
          properties: {
            new_checkout: { type: 'string', description: 'The requested new checkout date in YYYY-MM-DD format.' },
            new_checkin: { type: ['string', 'null'], description: 'The requested new check-in date in YYYY-MM-DD format. Only needed if the guest wants to arrive earlier or later.' },
            reason: { type: 'string', description: 'Brief reason, e.g. \'guest wants 2 more nights\'. Used for logging.' },
          },
          required: ['new_checkout', 'reason', 'new_checkin'],
          additionalProperties: false,
        },
      }];

      // Look up hostawayListingId for extend-stay tool
      let hostawayListingId = '';
      if (!isInquiry) {
        try {
          const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { hostawayListingId: true } });
          hostawayListingId = prop?.hostawayListingId || '';
        } catch { /* fallback: empty */ }
      }

      // Build multi-turn inputTurns — identical to production
      const lastUserMessage = [
        `### PROPERTY & GUEST INFO ###\n\n${propertyInfo}`,
        `### OPEN TASKS ###\nNo open tasks.`,
        `### KNOWLEDGE BASE ###\n${knowledgeText}`,
        `### CURRENT GUEST MESSAGE(S) ###\n${currentMsgsText}`,
        `### CURRENT LOCAL TIME ###\n${localTime}`,
      ].join('\n\n');

      // Build history as proper {role, content} turns (matches production inputTurns)
      const inputTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const turn of messages) {
        inputTurns.push({
          role: turn.role === 'guest' ? 'user' : 'assistant',
          content: turn.content,
        });
      }
      // Exclude current window messages from history (they're in lastUserMessage)
      const currentContents = new Set(lastGuestMessages.map(m => m.content));
      const historyTurns = inputTurns.filter(t => !(t.role === 'user' && currentContents.has(t.content)));
      const finalInputTurns = [...historyTurns, { role: 'user' as const, content: lastUserMessage }];

      // Determine reasoning effort — match production logic
      const REASONING_CATEGORIES = new Set(['sop-booking-modification', 'sop-booking-cancellation', 'payment-issues', 'escalate']);
      const reasoningEffort = sopClassification.categories.some(c => REASONING_CATEGORIES.has(c)) ? 'low' as const : 'none' as const;

      // ── Call OpenAI — identical to production createMessage ──────────
      const createParams: any = {
        model: effectiveModel,
        max_output_tokens: effectiveMaxTokens,
        ...(reasoningEffort !== 'none' ? { reasoning: { effort: reasoningEffort } } : { reasoning: { effort: 'none' } }),
        ...(reasoningEffort === 'none' && effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
        ...(toolsForCall?.length ? { tools: toolsForCall, tool_choice: 'auto' } : {}),
        instructions: effectiveSystemPrompt,
        input: finalInputTurns,
        text: { verbosity: 'low' as const },
        truncation: 'auto',
        store: true,
        prompt_cache_key: `tenant-${tenantId}-sandbox-${isInquiry ? 'screening' : 'coordinator'}`,
        prompt_cache_retention: '24h',
      };

      let response = await withRetry(() =>
        (openai.responses as any).create(createParams)
      ) as any;

      // ── Tool use loop — identical to production ──────────────────────
      let toolUsed = false;
      let toolName: string | undefined;
      let toolInput: any;
      let toolResults: any;
      let toolDurationMs: number | undefined;

      const fnCall = response.output?.find((i: any) => i.type === 'function_call');
      if (fnCall) {
        toolUsed = true;
        toolName = fnCall.name;
        toolInput = JSON.parse(fnCall.arguments);
        const toolStartMs = Date.now();

        let toolResultContent: string;
        try {
          if (fnCall.name === 'search_available_properties') {
            const typedInput = toolInput as { amenities: string[]; min_capacity?: number; reason?: string };
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
          } else if (fnCall.name === 'check_extend_availability') {
            toolResultContent = await checkExtendAvailability(toolInput, {
              listingId: hostawayListingId,
              currentCheckIn: checkIn,
              currentCheckOut: checkOut,
              channel: channel || 'DIRECT',
              numberOfGuests: guestCount || 1,
              hostawayAccountId: tenant.hostawayAccountId,
              hostawayApiKey: tenant.hostawayApiKey,
            });
          } else {
            toolResultContent = JSON.stringify({ error: `Unknown tool: ${fnCall.name}` });
          }
        } catch (toolErr) {
          console.error('[Sandbox] Tool handler error:', toolErr);
          toolResultContent = JSON.stringify({ error: 'Tool execution failed', found: false, properties: [] });
        }
        toolDurationMs = Date.now() - toolStartMs;
        try { toolResults = JSON.parse(toolResultContent); } catch { toolResults = toolResultContent; }

        // Follow up with tool result + JSON reminder (matches production)
        const toolOutput = toolResultContent + '\n\nRespond with raw JSON only. No plain text. Start with { and end with }.';
        response = await withRetry(() =>
          (openai.responses as any).create({
            model: effectiveModel,
            instructions: effectiveSystemPrompt,
            input: [{ type: 'function_call_output', call_id: fnCall.call_id, output: toolOutput }],
            previous_response_id: response.id,
            max_output_tokens: effectiveMaxTokens,
            reasoning: { effort: reasoningEffort },
            text: { verbosity: 'low' as const },
            store: true,
          })
        ) as any;
      }

      // ── Extract response text ──────────────────────────────────────────
      const rawResponseText = response.output_text || '';
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
        ragContext: {
          chunks: retrievedChunks.map(c => ({ category: c.category, similarity: c.similarity, sourceKey: c.sourceKey })),
          sopToolUsed: true,
          sopCategories: sopClassification.categories,
          sopConfidence: sopClassification.confidence,
          sopReasoning: sopClassification.reasoning,
          sopClassificationTokens: { input: sopClassification.inputTokens, output: sopClassification.outputTokens },
          sopClassificationDurationMs: sopClassification.durationMs,
          escalationSignals: escalationSignals.map(s => s.signal),
        },
      });
    } catch (err: any) {
      console.error('[Sandbox] Chat error:', err);
      res.status(500).json({ error: err.message || 'Sandbox chat failed' });
    }
  });

  return router;
}
