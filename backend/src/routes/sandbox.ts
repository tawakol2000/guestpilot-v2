import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { authMiddleware } from '../middleware/auth';
import { getAiConfig } from '../services/ai-config.service';
import { getTenantAiConfig } from '../services/tenant-config.service';
import { getSopContent, buildToolDefinition } from '../services/sop.service';
import { detectEscalationSignals } from '../services/escalation-enrichment.service';
import { resolveVariables, applyPropertyOverrides } from '../services/template-variable.service';
import { searchAvailableProperties } from '../services/property-search.service';
import { checkExtendAvailability } from '../services/extend-stay.service';
import { createChecklist, updateChecklist, getChecklist, hasPendingItems, type DocumentChecklist } from '../services/document-checklist.service';
import { COORDINATOR_SCHEMA, SCREENING_SCHEMA, SEED_COORDINATOR_PROMPT, SEED_SCREENING_PROMPT, buildPropertyInfo, classifyAmenities, stripCodeFences, computeContextVariables, renderPreComputedContext, pickReasoningEffort } from '../services/ai.service';
import { getToolDefinitions } from '../services/tool-definition.service';
import { callWebhook } from '../services/webhook-tool.service';
import { getFaqForProperty } from '../services/faq.service';
import { computeScreeningState } from '../services/screening-state.service';

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
      const historyMsgs = messages.filter(m => !(m.role === 'guest' && currentContents.has(m.content))).slice(-10);
      const historyText = historyMsgs.length > 0
        ? historyMsgs.map(m => `${m.role === 'guest' ? 'Guest' : (tenantConfig?.agentName || 'Omar')}: ${m.content}`).join('\n')
        : '';

      // ── Amenity classification ──────────────────────────────────────────
      const rawAmenitiesStr = kb?.amenities ? String(kb.amenities) : undefined;
      const amenityClasses = kb?.amenityClassifications as Record<string, string> | undefined;
      const { available: availableAmenityList, onRequest: onRequestAmenityList } =
        classifyAmenities(rawAmenitiesStr, amenityClasses);
      // For SOP {PROPERTY_AMENITIES}: use on-request items if classifications exist, else full list
      const { onRequest: sopOnRequestItems } = classifyAmenities(rawAmenitiesStr, amenityClasses);
      const propertyAmenities = (amenityClasses && Object.keys(amenityClasses).length > 0 && sopOnRequestItems.length > 0)
        ? sopOnRequestItems.join(', ')
        : rawAmenitiesStr;

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

      // DB-backed system prompts (editable via Configure AI), fallback to SEED constants
      let effectiveSystemPrompt = isInquiry
        ? (tenantConfig?.systemPromptScreening || SEED_SCREENING_PROMPT)
        : (tenantConfig?.systemPromptCoordinator || SEED_COORDINATOR_PROMPT);
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
        .filter(t => t.name !== 'get_sop' && t.name !== 'get_faq') // get_sop/get_faq use inline definitions
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

      // Add get_faq tool — matches production (ai.service.ts)
      toolsForCall.push({
        type: 'function' as const,
        name: 'get_faq',
        description: 'Retrieve FAQ entries for the current property. Call this BEFORE escalating an info_request when a guest asks a factual question about the property, local area, amenities, or policies. If the FAQ has an answer, use it directly instead of escalating.',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: [
                'check-in-access', 'check-out-departure', 'wifi-technology',
                'kitchen-cooking', 'appliances-equipment', 'house-rules',
                'parking-transportation', 'local-recommendations', 'attractions-activities',
                'cleaning-housekeeping', 'safety-emergencies', 'booking-reservation',
                'payment-billing', 'amenities-supplies', 'property-neighborhood',
              ],
              description: 'FAQ category that best matches the guest\'s question',
            },
          },
          required: ['category'],
          additionalProperties: false,
        },
      });

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

      // ── T040: Build OPEN_TASKS from previous AI responses in messages ──────
      const openTaskEntries: Array<{ title: string; urgency: string; note: string }> = [];
      for (const m of messages) {
        if (m.role !== 'host') continue;
        // Try to parse host messages as AI JSON responses to extract escalation/manager data
        try {
          const parsed = JSON.parse(stripCodeFences(m.content));
          if (parsed.escalation && parsed.escalation.title) {
            openTaskEntries.push({ title: parsed.escalation.title, urgency: parsed.escalation.urgency || 'info_request', note: parsed.escalation.note || '' });
          }
          if (parsed.manager?.needed && parsed.manager.title) {
            openTaskEntries.push({ title: parsed.manager.title, urgency: 'info_request', note: parsed.manager.note || '' });
          }
        } catch {
          // Not JSON — regular host message, skip
        }
      }
      const openTasksText = openTaskEntries.length > 0
        ? openTaskEntries.map((t, i) => {
            const notePreview = t.note ? `\n  → ${t.note}` : '';
            return `[task-${i + 1}] ${t.title} (${t.urgency})${notePreview}`;
          }).join('\n')
        : 'No open tasks.';

      // ── T041: Compute PRE_COMPUTED_CONTEXT ─────────────────────────────────
      const existingScreeningExists = openTaskEntries.some(t =>
        t.title.startsWith('eligible-') || t.title.startsWith('violation-') || t.title === 'awaiting-manager-review'
      );
      const existingScreeningTitle = openTaskEntries.find(t =>
        t.title.startsWith('eligible-') || t.title.startsWith('violation-') || t.title === 'awaiting-manager-review'
      )?.title || null;
      const preComputedContext = renderPreComputedContext(
        computeContextVariables(
          checkIn, checkOut,
          reservationStatus || 'DEFAULT',
          undefined, undefined, undefined,
          isInquiry ? {
            existingScreeningExists,
            existingScreeningTitle,
            documentChecklistCreated: !!sbChecklistData,
          } : undefined,
        )
      );

      // ── T042: Compute SCREENING_STATE for INQUIRY reservations ─────────────
      let screeningStateText = '';
      if (isInquiry) {
        const screeningState = computeScreeningState(
          messages.map(m => ({ role: m.role === 'guest' ? 'GUEST' : 'HOST', content: m.content })),
          openTaskEntries.map(t => ({ title: t.title, status: 'open' })),
          !!sbChecklistData,
        );
        screeningStateText = `Phase: ${screeningState.phase}\nNationality mentioned: ${screeningState.nationalityMentioned}\nComposition mentioned: ${screeningState.compositionMentioned}\nScreening decision exists: ${screeningState.screeningDecisionExists}${screeningState.screeningDecisionTitle ? `\nScreening title: ${screeningState.screeningDecisionTitle}` : ''}\nChecklist created: ${screeningState.checklistCreated}\n\n${screeningState.hint}`;
      }

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
        OPEN_TASKS: openTasksText,
        CURRENT_MESSAGES: currentMsgsText,
        CURRENT_LOCAL_TIME: localTime,
        DOCUMENT_CHECKLIST: documentChecklistText
          ? applyPropertyOverrides(documentChecklistText, varOverrides.DOCUMENT_CHECKLIST) : '',
        PRE_COMPUTED_CONTEXT: preComputedContext,
        SCREENING_STATE: screeningStateText,
      };

      // Strip {DOCUMENT_CHECKLIST} from system prompt (keep it static for caching)
      effectiveSystemPrompt = effectiveSystemPrompt.replace('{DOCUMENT_CHECKLIST}', '');

      // Resolve variables — system prompt stays static (cacheable), data becomes content blocks
      const { cleanedPrompt, contentBlocks: userContent } = resolveVariables(
        effectiveSystemPrompt,
        variableDataMap,
        agentType,
      );
      // Use cleanedPrompt (without content blocks) for instructions — blocks go in input
      effectiveSystemPrompt = cleanedPrompt;

      // Append document checklist as content block (matches production)
      if (variableDataMap.DOCUMENT_CHECKLIST) {
        userContent.push({
          type: 'text',
          text: `### PENDING DOCUMENTS ###\n${variableDataMap.DOCUMENT_CHECKLIST}`,
        });
      }

      // Single user message — matches production (no multi-turn splitting)
      const userMessage = userContent.map(b => b.text).join('\n\n');
      const inputTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user' as const, content: userMessage },
      ];

      // ── Determine reasoning effort — matches production logic (T043) ────
      const VALID_EFFORTS = ['none', 'low', 'medium', 'high'];
      let reasoningEffort: 'none' | 'low' | 'medium' | 'high';
      if (requestedReasoning && VALID_EFFORTS.includes(requestedReasoning)) {
        // Sandbox allows explicit override for testing
        reasoningEffort = requestedReasoning as any;
      } else {
        // Production logic: tenant config > pickReasoningEffort when 'auto'
        const tenantReasoning = isInquiry
          ? (tenantConfig as any)?.reasoningScreening || 'none'
          : (tenantConfig as any)?.reasoningCoordinator || 'auto';
        if (tenantReasoning === 'auto') {
          reasoningEffort = pickReasoningEffort(currentMsgsText, openTaskEntries.length);
        } else {
          reasoningEffort = tenantReasoning;
        }
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
      const toolNames: string[] = [];
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

          // Auto-enrich: early check-in / late checkout within 2 days → check availability
          if ((cats.includes('sop-early-checkin') || cats.includes('sop-late-checkout')) && hostawayListingId) {
            try {
              const ciDate = new Date(checkIn + 'T00:00:00Z');
              const coDate = new Date(checkOut + 'T00:00:00Z');
              const now = new Date(); now.setHours(0, 0, 0, 0);
              const twoDays = 2 * 24 * 60 * 60 * 1000;
              const ciSoon = ciDate.getTime() - now.getTime() <= twoDays;
              const coSoon = coDate.getTime() - now.getTime() <= twoDays;
              if ((cats.includes('sop-early-checkin') && ciSoon) || (cats.includes('sop-late-checkout') && coSoon)) {
                const availResult = await checkExtendAvailability(
                  { new_checkout: checkOut, new_checkin: cats.includes('sop-early-checkin') ? checkIn : null, reason: 'Auto-check back-to-back' },
                  { listingId: hostawayListingId, currentCheckIn: checkIn, currentCheckOut: checkOut, channel: channel || 'DIRECT', numberOfGuests: guestCount || 1, hostawayAccountId: safeTenant.hostawayAccountId, hostawayApiKey: safeTenant.hostawayApiKey },
                );
                const availData = JSON.parse(availResult);
                const backToBack = availData.available === false || availData.blocked;
                sopContent += `\n\n## AVAILABILITY CHECK RESULT\n${backToBack ? 'Back-to-back booking detected — another guest is checking out on that day. Early check-in/late checkout is NOT available.' : 'No back-to-back booking found — early check-in/late checkout may be possible. Escalate to manager for confirmation.'}`;
              }
            } catch (err) {
              console.warn('[Sandbox] Auto availability check failed:', err);
            }
          }

          if (!sopContent) return `## SOP: ${cats.join(', ')}\n\nNo SOP content available for this category.`;
          return `## SOP: ${cats.join(', ')}\n\n${sopContent}`;
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
            return JSON.stringify({ passportsReceived: updated.passportsReceived, passportsNeeded: updated.passportsNeeded, marriageCertReceived: updated.marriageCertReceived, marriageCertNeeded: updated.marriageCertNeeded, allComplete: !hasPendingItems(updated) });
          }
          return JSON.stringify({ error: 'No reservation in sandbox context' });
        } else if (fnCall.name === 'get_faq') {
          const typedInput = input as { category: string };
          if (!typedInput.category) return '## FAQ\n\nNo category specified.';
          return getFaqForProperty(prisma, tenantId, propertyId, typedInput.category);
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

            // Track all tools used
            toolNames.push(fnCall.name);
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
            // Don't enforce json_schema during tool rounds — it blocks further tool calls.
            // Schema is applied in a final call below if needed.
            tools: toolsForCall,
            tool_choice: 'auto',
            store: true,
          })
        ) as any;

        sbFnCalls = (response.output || []).filter((i: any) => i.type === 'function_call');
      }

      // If tools were used and response isn't valid JSON, do a final schema-enforced call
      if (toolUsed && response.output_text) {
        try {
          JSON.parse(stripCodeFences(response.output_text));
        } catch {
          // Response isn't valid JSON — re-run with schema enforcement and no tools
          response = await withRetry(() =>
            (openai.responses as any).create({
              model: effectiveModel,
              instructions: effectiveSystemPrompt,
              input: 'Based on all the tool results and context, generate your final JSON response now.',
              previous_response_id: response.id,
              max_output_tokens: effectiveMaxTokens,
              reasoning: { effort: reasoningEffort },
              text: { format: isInquiry ? SCREENING_SCHEMA : COORDINATOR_SCHEMA },
              store: true,
            })
          ) as any;
        }
      }

      // ── Extract response text ──────────────────────────────────────────
      const rawResponseText = response.output_text || '';
      const durationMs = Date.now() - startMs;

      // ── Parse JSON response (T039: guest_message with 'guest message' fallback) ──
      let responseMessage = rawResponseText;
      let escalation: { title: string; note: string; urgency: string } | null = null;
      let manager: { needed: boolean; title: string; note: string } | null = null;
      let derivedAction = 'reply';
      let derivedReasoning = '';
      let derivedSopStep = '';

      try {
        const cleanedResponse = stripCodeFences(rawResponseText);
        if (isInquiry) {
          const parsed = JSON.parse(cleanedResponse) as Record<string, any>;
          responseMessage = parsed.guest_message ?? parsed['guest message'] ?? rawResponseText;
          if (parsed.manager) manager = parsed.manager;
          // Derive action from response structure
          const hasMessage = responseMessage && responseMessage.trim();
          const hasManager = manager?.needed && manager.title;
          if (hasManager && hasMessage) derivedAction = 'reply+escalate';
          else if (hasManager) derivedAction = 'escalate';
          else if (hasMessage) derivedAction = 'reply';
          else derivedAction = 'none';
        } else {
          const parsed = JSON.parse(cleanedResponse) as Record<string, any>;
          responseMessage = parsed.guest_message ?? parsed['guest message'] ?? rawResponseText;
          escalation = parsed.escalation || null;
          // Derive action from response structure
          const hasMessage = responseMessage && responseMessage.trim();
          const hasEscalation = escalation !== null;
          if (hasEscalation && hasMessage) derivedAction = 'reply+escalate';
          else if (hasEscalation) derivedAction = 'escalate';
          else if (hasMessage) derivedAction = 'reply';
          else derivedAction = 'none';
        }
        // Derive reasoning from SOP classification
        derivedReasoning = sopClassification.reasoning;
        // Derive sopStep from SOP categories
        derivedSopStep = sopClassification.categories.filter(c => c !== 'none' && c !== 'escalate').join(', ') || 'none';
      } catch {
        // If JSON parse fails, use the raw text as the response
        console.warn('[Sandbox] JSON parse failed — using raw response text');
      }

      res.json({
        response: responseMessage,
        action: derivedAction,
        reasoning: derivedReasoning,
        sopStep: derivedSopStep,
        escalation,
        manager,
        toolUsed,
        toolName,
        toolNames,
        toolInput,
        toolResults,
        toolDurationMs,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        durationMs,
        model: effectiveModel,
        ragContext: {
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
