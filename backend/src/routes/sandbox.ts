import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { authMiddleware } from '../middleware/auth';
import { getAiConfig } from '../services/ai-config.service';
import { getTenantAiConfig } from '../services/tenant-config.service';
import { retrieveRelevantKnowledge } from '../services/rag.service';
import { getSopContent, buildToolDefinition } from '../services/sop.service';
import { detectEscalationSignals } from '../services/escalation-enrichment.service';
import { resolveVariables, applyPropertyOverrides } from '../services/template-variable.service';
import { searchAvailableProperties } from '../services/property-search.service';
import { checkExtendAvailability } from '../services/extend-stay.service';
import { createChecklist, updateChecklist, getChecklist, hasPendingItems, type DocumentChecklist } from '../services/document-checklist.service';
import { COORDINATOR_SCHEMA, SCREENING_SCHEMA, buildPropertyInfo, classifyAmenities } from '../services/ai.service';
import { getToolDefinitions } from '../services/tool-definition.service';
import { callWebhook } from '../services/webhook-tool.service';

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
        reasoningEffort: requestedReasoning,
      } = req.body as {
        propertyId: string;
        reservationStatus: string;
        channel: string;
        guestName: string;
        checkIn: string;
        checkOut: string;
        guestCount: number;
        messages: Array<{ role: 'guest' | 'host'; content: string }>;
        reasoningEffort?: string;
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
        doorSecurityCode: (kb?.doorCode as string) || (kb?.doorSecurityCode as string) || (kb?.door_security_code as string) || undefined,
        wifiUsername: (kb?.wifiName as string) || (kb?.wifiUsername as string) || (kb?.wifi_username as string) || undefined,
        wifiPassword: (kb?.wifiPassword as string) || (kb?.wifi_password as string) || undefined,
      };

      const isInquiry = reservationStatus === 'INQUIRY';
      const aiCfg = getAiConfig();
      const agentName = isInquiry ? 'screeningAI' : 'guestCoordinator';
      const personaCfg = isInquiry ? aiCfg.screeningAI : aiCfg.guestCoordinator;

      // ── Current message = last guest message(s) ─────────────────────────
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

      // ── Build conversation history text ─────────────────────────────────
      // Exclude current window messages from history (they go into CURRENT_MESSAGES block)
      const currentContents = new Set(lastGuestMessages.map(m => m.content));
      const historyMsgs = messages.filter(m => !(m.role === 'guest' && currentContents.has(m.content)));
      const historyText = historyMsgs.length > 0
        ? historyMsgs.map(m => `${m.role === 'guest' ? 'Guest' : (tenantConfig?.agentName || 'Omar')}: ${m.content}`).join('\n')
        : '';

      // ── RAG retrieval ──────────────────────────────────────────────────
      const rawAmenitiesStr = kb?.amenities ? String(kb.amenities) : undefined;
      const amenityClasses = kb?.amenityClassifications as Record<string, string> | undefined;
      const { available: availableAmenityList, onRequest: onRequestAmenityList } =
        classifyAmenities(rawAmenitiesStr, amenityClasses);
      // For SOP {PROPERTY_AMENITIES}: use on-request items if classifications exist, else full list
      const { onRequest: sopOnRequestItems } = classifyAmenities(rawAmenitiesStr, amenityClasses);
      const propertyAmenities = (amenityClasses && Object.keys(amenityClasses).length > 0 && sopOnRequestItems.length > 0)
        ? sopOnRequestItems.join(', ')
        : rawAmenitiesStr;

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

      // ── SOP Classification — handled inline via tool loop (matches production) ──
      // No separate classification call. The AI calls get_sop when it needs SOP guidance.
      let sopClassification: { categories: string[]; confidence: string; reasoning: string; inputTokens: number; outputTokens: number; durationMs: number } = {
        categories: ['none'], confidence: 'high', reasoning: 'No SOP classification — handled inline via tool loop', inputTokens: 0, outputTokens: 0, durationMs: 0,
      };
      let sopContent = '';

      // ── Escalation signals ─────────────────────────────────────────────
      const escalationSignals = detectEscalationSignals(ragQuery);

      // ── Build property info (matches production buildPropertyInfo) ──────
      const { reservationDetails, accessConnectivity, propertyDescription } = buildPropertyInfo(
        guestName || 'Test Guest',
        checkIn,
        checkOut,
        guestCount || 2,
        listing,
        retrievedChunks,
        reservationStatus,
        kb,
        (kb?.summarizedDescription as string) || property.listingDescription || '',
      );

      // Inject escalation signals into reservation details
      let reservationDetailsWithSignals = reservationDetails;
      if (escalationSignals.length > 0) {
        reservationDetailsWithSignals += '\n\n### SYSTEM SIGNALS\n';
        reservationDetailsWithSignals += escalationSignals.map(s => `\u26a0 ${s.signal}`).join('\n');
        reservationDetailsWithSignals += '\nNote: These signals were automatically detected from the guest message. Consider them when deciding whether to escalate.';
      }

      const localTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });

      // Migrate legacy model names to GPT-5.4 Mini
      const rawModel = tenantConfig?.model || personaCfg.model;
      const effectiveModel = rawModel?.startsWith('claude-') ? 'gpt-5.4-mini-2026-03-17' : rawModel;
      const effectiveTemperature = tenantConfig?.temperature ?? personaCfg.temperature;
      const effectiveMaxTokens = tenantConfig?.maxTokens || personaCfg.maxTokens;
      const effectiveAgentName = tenantConfig?.agentName || agentName;

      // DB-backed system prompts (editable via Configure AI), fallback to JSON config
      let effectiveSystemPrompt = isInquiry
        ? (tenantConfig?.systemPromptScreening || personaCfg.systemPrompt)
        : (tenantConfig?.systemPromptCoordinator || personaCfg.systemPrompt);
      if (tenantConfig?.agentName && tenantConfig.agentName !== 'Omar') {
        effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName);
      }
      if (tenantConfig?.customInstructions) {
        effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\nThe following instructions are specific to this property and override general guidelines where they conflict:\n${tenantConfig.customInstructions}`;
      }

      // SOP content is injected via the get_sop tool handler in the main tool loop.
      // No pre-injection needed — matches production.

      // ── Read document checklist for conditional tool availability ────────
      const reservation = await prisma.reservation.findFirst({ where: { id: { not: undefined }, conversations: { some: { property: { id: propertyId } } } }, select: { id: true, screeningAnswers: true } });
      const sbChecklistData = (reservation?.screeningAnswers as any)?.documentChecklist as DocumentChecklist | undefined;
      const sbChecklistPending = hasPendingItems(sbChecklistData ?? null);

      // Build document checklist text
      let documentChecklistText = '';
      if (!isInquiry && sbChecklistData && sbChecklistPending) {
        documentChecklistText = `Passports/IDs: ${sbChecklistData.passportsReceived}/${sbChecklistData.passportsNeeded} received`;
        if (sbChecklistData.marriageCertNeeded) {
          documentChecklistText += `\nMarriage Certificate: ${sbChecklistData.marriageCertReceived ? 'received' : 'pending'}`;
        }
      }

      // ── Tool definitions — identical to production (ai.service.ts) ──────
      let sbToolDefs: Awaited<ReturnType<typeof getToolDefinitions>> = [];
      try {
        sbToolDefs = await getToolDefinitions(tenantId, prisma);
      } catch (err) {
        console.warn('[Sandbox] Failed to load tool definitions — falling back to no tools:', err);
      }

      // Build tool set — get_sop uses dynamic definition, others from DB
      const toolsForCall: any[] = sbToolDefs
        .filter(t => t.enabled && t.agentScope.split(',').map(s => s.trim()).includes(reservationStatus))
        .filter(t => t.name !== 'get_sop') // get_sop uses dynamic definition with category enum
        .filter(t => t.name !== 'mark_document_received' || sbChecklistPending) // conditional
        .map(t => ({
          type: 'function' as const,
          name: t.name,
          description: t.description,
          strict: t.type === 'system',
          parameters: t.parameters as Record<string, unknown>,
        }));
      // Add get_sop with dynamic category descriptions from enabled SOP definitions
      const sopToolDef = await buildToolDefinition(tenantId, prisma);
      toolsForCall.push(sopToolDef);

      // Look up hostawayListingId for extend-stay tool
      let hostawayListingId = '';
      if (!isInquiry) {
        try {
          const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { hostawayListingId: true } });
          hostawayListingId = prop?.hostawayListingId || '';
        } catch { /* fallback: empty */ }
      }

      // ── Build content blocks via template variable system — identical to production ──
      const agentType = isInquiry ? 'screening' as const : 'coordinator' as const;

      // Apply per-listing variable overrides if configured
      const varOverrides = (kb?.variableOverrides || {}) as Record<string, { customTitle?: string; notes?: string }>;

      const variableDataMap: Record<string, string> = {
        CONVERSATION_HISTORY: historyText,
        RESERVATION_DETAILS: applyPropertyOverrides(reservationDetailsWithSignals, varOverrides.RESERVATION_DETAILS),
        ACCESS_CONNECTIVITY: accessConnectivity
          ? applyPropertyOverrides(accessConnectivity, varOverrides.ACCESS_CONNECTIVITY) : '',
        PROPERTY_DESCRIPTION: propertyDescription
          ? applyPropertyOverrides(propertyDescription, varOverrides.PROPERTY_DESCRIPTION) : '',
        AVAILABLE_AMENITIES: availableAmenityList.length > 0
          ? applyPropertyOverrides(availableAmenityList.join(', '), varOverrides.AVAILABLE_AMENITIES) : '',
        ON_REQUEST_AMENITIES: onRequestAmenityList.length > 0
          ? applyPropertyOverrides(
              `The following amenities are available ON REQUEST ONLY (guest must ask, then confirm delivery time):\n${onRequestAmenityList.map(a => `- ${a}`).join('\n')}`,
              varOverrides.ON_REQUEST_AMENITIES,
            ) : '',
        OPEN_TASKS: 'No open tasks.',
        CURRENT_MESSAGES: currentMsgsText,
        CURRENT_LOCAL_TIME: localTime,
        DOCUMENT_CHECKLIST: documentChecklistText
          ? applyPropertyOverrides(documentChecklistText, varOverrides.DOCUMENT_CHECKLIST) : '',
      };

      // Resolve variables — system prompt stays static (cacheable), data becomes content blocks
      const { cleanedPrompt, contentBlocks: userContent } = resolveVariables(
        effectiveSystemPrompt,
        variableDataMap,
        agentType,
      );
      // Use cleanedPrompt (without content blocks) for instructions — blocks go in input
      effectiveSystemPrompt = cleanedPrompt;

      // Single user message — matches production (no multi-turn splitting)
      const userMessage = userContent.map(b => b.text).join('\n\n');
      const inputTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user' as const, content: userMessage },
      ];

      // ── Determine reasoning effort — matches production logic ───────────
      const VALID_EFFORTS = ['none', 'low', 'medium', 'high'];
      let reasoningEffort: 'none' | 'low' | 'medium' | 'high';
      if (requestedReasoning && VALID_EFFORTS.includes(requestedReasoning)) {
        // Sandbox allows explicit override for testing
        reasoningEffort = requestedReasoning as any;
      } else {
        // Production logic: tenant config > minimum 'low' when 'auto'
        const tenantReasoning = isInquiry
          ? (tenantConfig as any)?.reasoningScreening || 'none'
          : (tenantConfig as any)?.reasoningCoordinator || 'auto';
        reasoningEffort = tenantReasoning === 'auto' ? 'low' : tenantReasoning;
      }

      // ── Call OpenAI — identical to production createMessage ──────────────
      const createParams: any = {
        model: effectiveModel,
        max_output_tokens: effectiveMaxTokens,
        ...(reasoningEffort !== 'none' ? { reasoning: { effort: reasoningEffort } } : { reasoning: { effort: 'none' } }),
        ...(reasoningEffort === 'none' && effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
        ...(toolsForCall?.length ? { tools: toolsForCall, tool_choice: 'auto' } : {}),
        instructions: effectiveSystemPrompt,
        input: inputTurns,
        text: { format: isInquiry ? SCREENING_SCHEMA : COORDINATOR_SCHEMA },
        truncation: 'auto',
        store: true,
        prompt_cache_key: `tenant-${tenantId}-${isInquiry ? 'screening' : 'coordinator'}`,
        prompt_cache_retention: '24h',
      };

      let response = await withRetry(() =>
        (openai.responses as any).create(createParams)
      ) as any;

      // ── Tool use loop — identical to production ────────────────────────
      let toolUsed = false;
      let toolName: string | undefined;
      let toolInput: any;
      let toolResults: any;
      let toolDurationMs: number | undefined;

      const MAX_TOOL_ROUNDS = 5;
      let sbToolRound = 0;
      let sbFnCalls = (response.output || []).filter((i: any) => i.type === 'function_call');

      const safeTenant = tenant!; // Already null-checked above
      async function executeSandboxTool(fnCall: any): Promise<string> {
        const input = JSON.parse(fnCall.arguments);

        if (fnCall.name === 'get_sop') {
          // ── get_sop handler — matches production ──
          const typedInput = input as { categories: string[]; confidence: string; reasoning: string };
          // Update sopClassification for logging/metadata
          sopClassification = {
            categories: typedInput.categories,
            confidence: typedInput.confidence,
            reasoning: typedInput.reasoning,
            inputTokens: 0, outputTokens: 0, durationMs: 0,
          };
          console.log(`[Sandbox] SOP classification (inline): [${typedInput.categories.join(', ')}] confidence=${typedInput.confidence} — ${typedInput.reasoning}`);

          const cats = typedInput.categories.filter(c => c !== 'none' && c !== 'escalate');

          // Fetch and return SOP content
          if (cats.length === 0) return JSON.stringify({ category: 'none', content: '' });
          const texts = await Promise.all(
            cats.map(c => getSopContent(tenantId, c, reservationStatus || 'DEFAULT', propertyId, propertyAmenities, prisma, variableDataMap))
          );
          sopContent = texts.filter(Boolean).join('\n\n---\n\n');
          return JSON.stringify({ categories: cats, content: sopContent || 'No SOP content available for this category.' });
        } else if (fnCall.name === 'search_available_properties') {
          const typedInput = input as { amenities: string[]; min_capacity?: number; reason?: string };
          const currentAddress = listing.address || '';
          const cityParts = currentAddress.split(',').map(s => s.trim()).filter(Boolean);
          const currentCity = cityParts[cityParts.length - 1] || cityParts[0] || '';
          return searchAvailableProperties(typedInput, {
            tenantId, currentPropertyId: propertyId, checkIn, checkOut,
            channel: channel || 'DIRECT', hostawayAccountId: safeTenant.hostawayAccountId,
            hostawayApiKey: safeTenant.hostawayApiKey, currentCity,
          });
        } else if (fnCall.name === 'create_document_checklist') {
          const typedInput = input as { passports_needed: number; marriage_certificate_needed: boolean; reason: string };
          if (reservation?.id) {
            const cl = await createChecklist(reservation.id, { passportsNeeded: typedInput.passports_needed, marriageCertNeeded: typedInput.marriage_certificate_needed, reason: typedInput.reason }, prisma);
            return JSON.stringify({ created: true, passportsNeeded: cl.passportsNeeded, marriageCertNeeded: cl.marriageCertNeeded });
          }
          return JSON.stringify({ created: false, error: 'No reservation in sandbox context' });
        } else if (fnCall.name === 'check_extend_availability') {
          return checkExtendAvailability(input, {
            listingId: hostawayListingId, currentCheckIn: checkIn, currentCheckOut: checkOut,
            channel: channel || 'DIRECT', numberOfGuests: guestCount || 1,
            hostawayAccountId: safeTenant.hostawayAccountId, hostawayApiKey: safeTenant.hostawayApiKey,
          });
        } else if (fnCall.name === 'mark_document_received') {
          const typedInput = input as { document_type: 'passport' | 'marriage_certificate'; notes: string };
          if (reservation?.id) {
            const updated = await updateChecklist(reservation.id, { documentType: typedInput.document_type, notes: typedInput.notes }, prisma);
            return JSON.stringify({ passportsReceived: updated.passportsReceived, passportsNeeded: updated.passportsNeeded, marriageCertReceived: updated.marriageCertReceived, allComplete: !hasPendingItems(updated) });
          }
          return JSON.stringify({ error: 'No reservation in sandbox context' });
        } else {
          const customToolDef = sbToolDefs.find(t => t.name === fnCall.name);
          if (customToolDef?.webhookUrl) {
            return callWebhook(customToolDef.webhookUrl, input, customToolDef.webhookTimeout);
          }
          return JSON.stringify({ error: `Unknown tool: ${fnCall.name}` });
        }
      }

      while (sbFnCalls.length > 0 && sbToolRound < MAX_TOOL_ROUNDS) {
        sbToolRound++;
        const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> = [];
        const toolStartMs = Date.now();

        for (const fnCall of sbFnCalls) {
          try {
            const result = await executeSandboxTool(fnCall);
            toolOutputs.push({ type: 'function_call_output', call_id: fnCall.call_id, output: result });

            // Log first tool for response metadata
            if (!toolUsed) {
              toolUsed = true;
              toolName = fnCall.name;
              try { toolInput = JSON.parse(fnCall.arguments); } catch { toolInput = fnCall.arguments; }
              try { toolResults = JSON.parse(result); } catch { toolResults = result; }
            }
          } catch (toolErr) {
            console.error(`[Sandbox] Tool handler error for ${fnCall.name}:`, toolErr);
            toolOutputs.push({ type: 'function_call_output', call_id: fnCall.call_id, output: JSON.stringify({ error: 'Tool execution failed' }) });
          }
        }
        toolDurationMs = Date.now() - toolStartMs;

        console.log(`[Sandbox] Tool round ${sbToolRound}: ${sbFnCalls.map((f: any) => f.name).join(', ')} (${toolDurationMs}ms)`);

        response = await withRetry(() =>
          (openai.responses as any).create({
            model: effectiveModel,
            instructions: effectiveSystemPrompt,
            input: toolOutputs,
            previous_response_id: response.id,
            max_output_tokens: effectiveMaxTokens,
            reasoning: { effort: reasoningEffort },
            text: { format: isInquiry ? SCREENING_SCHEMA : COORDINATOR_SCHEMA },
            store: true,
          })
        ) as any;

        sbFnCalls = (response.output || []).filter((i: any) => i.type === 'function_call');
      }

      // ── Extract response text ──────────────────────────────────────────
      const rawResponseText = response.output_text || '';
      const durationMs = Date.now() - startMs;

      // ── Parse JSON response ────────────────────────────────────────────
      let responseMessage = rawResponseText;
      let escalation: { title: string; note: string; urgency: string } | null = null;
      let manager: { needed: boolean; title: string; note: string } | null = null;

      try {
        if (isInquiry) {
          const parsed = JSON.parse(rawResponseText) as { 'guest message': string; manager?: { needed: boolean; title: string; note: string } };
          responseMessage = parsed['guest message'] || rawResponseText;
          if (parsed.manager) manager = parsed.manager;
        } else {
          const parsed = JSON.parse(rawResponseText) as { guest_message: string; escalation: { title: string; note: string; urgency: string } | null };
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
