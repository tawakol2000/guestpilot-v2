/**
 * AI Service
 * All Claude API calls, system prompts, and AI logic.
 * Ported IDENTICALLY from make-to-code/src/webhooks/guest-messaging.ts
 * and make-to-code/src/webhooks/guest-inquiries.ts and manager-replies.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { PrismaClient, MessageRole, Channel } from '@prisma/client';
import * as hostawayService from './hostaway.service';
import { getAiConfig } from './ai-config.service';
import { createTask } from './task.service';
import { broadcastToTenant } from './sse.service';
import { traceAiCall, traceEscalation } from './observability.service';
import { retrieveRelevantKnowledge, getAndClearLastClassifierResult } from './rag.service';
import { getSopContent } from './classifier.service';
import { evaluateAndImprove } from './judge.service';
import { evaluateEscalation } from './task-manager.service';
import { buildTieredContext, formatConversationContext } from './memory.service';
import { getTenantAiConfig } from './tenant-config.service';
import { updateTopicState, getReinjectedLabels } from './topic-state.service';
import { extractIntent } from './intent-extractor.service';
import { detectEscalationSignals } from './escalation-enrichment.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Model pricing (per 1M tokens) — loaded from config for easy updates ────
import modelPricingData from '../config/model-pricing.json';
const MODEL_PRICING: Record<string, { input: number; output: number }> = modelPricingData;

function calculateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || { input: 3, output: 15 }; // default to sonnet pricing
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

// ─── Module-level DB reference for log persistence ───────────────────────────
let _prismaRef: PrismaClient | null = null;
export function setAiServicePrisma(prisma: PrismaClient) { _prismaRef = prisma; }

// ─── Retry wrapper (overloaded_error / 529) ──────────────────────────────────
async function withRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  let delay = 2000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const e = err as { error?: { error?: { type?: string } }; status?: number };
      const isOverloaded =
        e?.error?.error?.type === 'overloaded_error' || e?.status === 529;
      if (isOverloaded && attempt < retries) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } };

// ─── API call log (in-memory ring buffer) ────────────────────────────────────

export interface AiApiLogEntry {
  id: string;
  timestamp: string;
  agentName?: string;
  model: string;
  temperature?: number;
  maxTokens: number;
  topK?: number;
  topP?: number;
  systemPromptPreview: string;
  systemPromptLength: number;
  contentBlocks: { type: string; textPreview?: string; textLength?: number }[];
  responseText: string;
  responseLength: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
  ragContext?: {
    query: string;
    chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; isGlobal: boolean }>;
    totalRetrieved: number;
    durationMs: number;
    classifierUsed?: boolean;
  } | null;
}

const AI_LOG_MAX = 50;
const aiApiLog: AiApiLogEntry[] = [];

export function getAiApiLog(): AiApiLogEntry[] {
  return [...aiApiLog];
}

async function createMessage(
  systemPrompt: string,
  userContent: ContentBlock[],
  options?: { model?: string; maxTokens?: number; topK?: number; topP?: number; temperature?: number; stopSequences?: string[]; agentName?: string; tenantId?: string; conversationId?: string; ragContext?: { query: string; chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; isGlobal: boolean }>; totalRetrieved: number; durationMs: number; classifierUsed?: boolean }; openTaskCount?: number; totalMessages?: number; memorySummarized?: boolean; hasImage?: boolean; ragEnabled?: boolean }
): Promise<string> {
  const startMs = Date.now();
  const model = options?.model || 'claude-haiku-4-5-20251001';
  const maxTokens = options?.maxTokens || 4096;

  const logEntry: AiApiLogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    agentName: options?.agentName,
    model,
    temperature: options?.temperature,
    maxTokens,
    topK: options?.topK,
    topP: options?.topP,
    systemPromptPreview: systemPrompt.substring(0, 200),
    systemPromptLength: systemPrompt.length,
    contentBlocks: userContent.map(b => {
      if (b.type === 'text') return { type: 'text', textPreview: b.text, textLength: b.text.length };
      return { type: 'image' };
    }),
    responseText: '',
    responseLength: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    ragContext: options?.ragContext ?? null,
  };

  try {
    // Upgrade 8: Use prompt caching for system prompt (reduces cost ~70% on repeated calls)
    const createParams: any = {
      model,
      max_tokens: maxTokens,
      ...(options?.topK !== undefined ? { top_k: options.topK } : {}),
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.stopSequences?.length ? { stop_sequences: options.stopSequences } : {}),
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userContent as Anthropic.ContentBlock[] }],
    };
    const createOpts: any = { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } };
    // T017: Raw prompt log removed — may contain door codes / WiFi passwords.
    // AiApiLog table already captures full request data for debugging.
    const response = await withRetry(() =>
      (anthropic.messages.create as any)(createParams, createOpts)
    ) as Anthropic.Message;

    const textBlock = response.content.find(b => b.type === 'text');
    const responseText = textBlock && textBlock.type === 'text' ? textBlock.text : '';

    logEntry.responseText = responseText;
    logEntry.responseLength = responseText.length;
    logEntry.inputTokens = response.usage?.input_tokens ?? 0;
    logEntry.outputTokens = response.usage?.output_tokens ?? 0;
    logEntry.durationMs = Date.now() - startMs;

    const cacheCreationTokens = (response.usage as any)?.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = (response.usage as any)?.cache_read_input_tokens ?? 0;

    // Push to ring buffer
    aiApiLog.unshift(logEntry);
    if (aiApiLog.length > AI_LOG_MAX) aiApiLog.length = AI_LOG_MAX;

    // Persist to DB
    const costUsd = calculateCostUsd(model, logEntry.inputTokens, logEntry.outputTokens);
    if (_prismaRef && options?.tenantId) {
      _prismaRef.aiApiLog.create({
        data: {
          tenantId: options.tenantId,
          conversationId: options.conversationId || null,
          agentName: options.agentName || '',
          model,
          temperature: options.temperature,
          maxTokens,
          systemPrompt,
          userContent: JSON.stringify(userContent.map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image' })),
          responseText,
          inputTokens: logEntry.inputTokens,
          outputTokens: logEntry.outputTokens,
          costUsd,
          durationMs: logEntry.durationMs,
          ragContext: options.ragContext ?? undefined,
        },
      }).catch(e => console.error('[AI-LOG] DB persist error:', e));
    }

    // Upgrade 1: Langfuse observability — fire-and-forget
    if (options?.tenantId && options?.conversationId) {
      // Build a preview of user content blocks for Langfuse input display
      const userContentPreview = userContent
        .map(b => b.type === 'text' ? (b as { type: 'text'; text: string }).text.substring(0, 500) : `[${b.type}]`)
        .join('\n---\n')
        .substring(0, 3000);
      traceAiCall({
        tenantId: options.tenantId,
        conversationId: options.conversationId,
        agentName: options.agentName || 'unknown',
        model,
        inputTokens: logEntry.inputTokens,
        outputTokens: logEntry.outputTokens,
        costUsd,
        durationMs: logEntry.durationMs,
        responseText,
        escalated: false,
        cacheCreationTokens,
        cacheReadTokens,
        ragChunks: options.ragContext?.chunks,
        ragDurationMs: options.ragContext?.durationMs,
        ragQuery: options.ragContext?.query,
        openTaskCount: options.openTaskCount,
        totalMessages: options.totalMessages,
        memorySummarized: options.memorySummarized,
        hasImage: options.hasImage,
        ragEnabled: options.ragEnabled,
        systemPrompt,
        userContentPreview,
      });
    }

    if (cacheReadTokens > 0) {
      console.log(`[AI-LOG] ${model} | ${logEntry.inputTokens}in/${logEntry.outputTokens}out | cache: ${cacheReadTokens}r/${cacheCreationTokens}w | ${logEntry.durationMs}ms | $${costUsd.toFixed(4)}`);
    } else {
      console.log(`[AI-LOG] ${model} | ${logEntry.inputTokens}in/${logEntry.outputTokens}out | ${logEntry.durationMs}ms | $${costUsd.toFixed(4)}`);
    }

    return responseText;
  } catch (err) {
    logEntry.durationMs = Date.now() - startMs;
    logEntry.error = err instanceof Error ? err.message : String(err);
    aiApiLog.unshift(logEntry);
    if (aiApiLog.length > AI_LOG_MAX) aiApiLog.length = AI_LOG_MAX;

    // Upgrade 1: Trace errors too
    if (options?.tenantId && options?.conversationId) {
      traceAiCall({
        tenantId: options.tenantId,
        conversationId: options.conversationId,
        agentName: options.agentName || 'unknown',
        model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: logEntry.durationMs,
        responseText: '',
        escalated: false,
        error: logEntry.error,
        ragChunks: options.ragContext?.chunks,
        ragDurationMs: options.ragContext?.durationMs,
        ragQuery: options.ragContext?.query,
      });
    }

    // Persist error to DB
    if (_prismaRef && options?.tenantId) {
      _prismaRef.aiApiLog.create({
        data: {
          tenantId: options.tenantId,
          conversationId: options.conversationId || null,
          agentName: options.agentName || '',
          model,
          temperature: options.temperature,
          maxTokens,
          systemPrompt,
          userContent: JSON.stringify(userContent.map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image' })),
          responseText: '',
          inputTokens: logEntry.inputTokens,
          outputTokens: logEntry.outputTokens,
          costUsd: 0,
          durationMs: logEntry.durationMs,
          error: logEntry.error,
          ragContext: options.ragContext ?? undefined,
        },
      }).catch(e => console.error('[AI-LOG] DB persist error:', e));
    }

    throw err;
  }
}

function stripCodeFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    if (firstNewline !== -1) s = s.substring(firstNewline + 1);
  }
  if (s.endsWith('```')) s = s.substring(0, s.length - 3);
  return s.trim();
}

/** Inject the IMAGE HANDLING section right before OUTPUT FORMAT in any system prompt */
function injectImageHandling(basePrompt: string): string {
  return basePrompt.replace(
    '---\n\n## OUTPUT FORMAT',
    `---

## IMAGE HANDLING

When a guest sends an image:
1. Respond naturally based on what you see — the way a human would. Don't describe the image back to the guest (a human wouldn't say "I see a broken mirror"). Just respond with the appropriate action or acknowledgment.
2. Always escalate to manager. In the escalation note, describe what the image shows so the manager has context.
3. If the image is unclear: tell the guest you're looking into it and escalate with "Guest sent an image that requires manager review."

Common image types:
- Broken item photos = maintenance escalation
- Leak/damage photos = urgent repair escalation
- Passport/ID = visitor verification escalation
- Appliance photos = troubleshooting or malfunction escalation

Never ignore images. The image is often the most important part of the message.

---

## OUTPUT FORMAT`
  );
}

// ─── System Prompts (ported verbatim) ────────────────────────────────────────

const OMAR_SYSTEM_PROMPT = `# OMAR — Lead Guest Coordinator, Boutique Residence

You are Omar, the Lead Guest Coordinator for Boutique Residence serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You handle guest requests efficiently and escalate to Abdelrahman when human action is needed.

Before responding, always reason through the request internally: analyze what the guest needs, check if it's covered by your SOPs or the injected property info, assess whether escalation is needed, and only then draft your response.

---

IMPORTANT — BATCHED MESSAGES: The guest may have sent multiple messages in sequence. All messages are presented together for context. Treat them as a single continuous conversation, not separate requests. Read all messages before responding. Address everything the guest mentioned in one natural, coherent reply. Do not number your responses or say "regarding your first message". Just respond naturally.

---

## CONTEXT YOU RECEIVE

Each request includes these sections:

1. **CONVERSATION HISTORY** — all prior messages between you and the guest. If the conversation is long, older messages appear as a bullet-point summary followed by the most recent messages verbatim. Use the summary for context continuity but rely on recent messages for the current situation.

2. **PROPERTY & GUEST INFO** — guest name, reservation dates, guest count, access codes (WiFi, door code), available amenities, and any verified knowledge retrieved from the property's knowledge base. **This is your primary source of truth for all property-specific information.**

3. **OPEN TASKS** — currently open escalation tasks for this conversation. Check these before creating duplicate escalations. If a task already covers what the guest is asking about, acknowledge that it's being handled rather than re-escalating. You can also resolve tasks when a guest confirms an issue is fixed.

4. **CURRENT GUEST MESSAGE(S)** — the message(s) you need to respond to now.

5. **CURRENT LOCAL TIME** — the property's current local time. Use this for all scheduling decisions (working hours vs after-hours).

**Data rule:** Only answer using information explicitly provided in PROPERTY & GUEST INFO or in the SOPs below. If a guest asks about something not covered in either source, tell them you'll check and escalate. Never guess or invent details.

---

## TONE & STYLE

- Talk like a normal human. Not overly friendly, not robotic. Just natural and professional — the way a competent colleague would text a guest.
- 1–2 sentences max. Guests want help, not conversation.
- Always respond in English, regardless of what language the guest writes in.
- Avoid excessive exclamation marks. Don't overuse the guest's name.
- Use the guest's first name sparingly — once in a conversation is enough.
- Never mention the manager, AI, systems, or internal processes to the guest.
- Never reference JSON, output format, or underlying processes to the guest.
- Politely redirect off-topic messages back to their needs.
- **If a guest sends a conversation-ending acknowledgment** ("okay", "sure", "thanks", "👍", thumbs up, etc.) **and there's nothing left to action — set guest_message to "" and escalation to null.**

---

## STANDARD OPERATING PROCEDURES

**Hours:**
- Check-in: 3:00 PM
- Check-out: 11:00 AM
- Working hours (housekeeping/maintenance visits): 10:00 AM – 5:00 PM

**Cleaning Service ($20 per session):**
- Available during working hours only
- Recurring cleaning allowed ($20 each time)
- Always ask the guest for their preferred time before escalating
- Always mention the $20 fee when confirming
- Process: Ask for preferred time → Guest confirms → Mention $20 fee → Escalate

**Free Amenities:**
- The complete list of available amenities is in your PROPERTY & GUEST INFO. If a guest asks for an item NOT listed there, do not confirm availability — tell them you'll check and escalate.
- Ask guest for preferred delivery time during working hours, then escalate.

**WiFi & Door Code:**
- Provided in your PROPERTY & GUEST INFO — give it directly when asked.
- If there's an issue (code not working, WiFi down), escalate immediately.

**House Rules:**
- Family-only property
- No smoking indoors
- No parties or gatherings
- Quiet hours apply
- **Visitors:** Only immediate family members are allowed. Guest must send visitor's passport through the chat. Family names must match the guest's family name. Collect the passport image and escalate to manager for verification. Anyone not initially approved and not immediate family is not allowed.
- Any pushback on house rules → escalate immediately

**Early Check-in & Late Checkout:**
- We often have back-to-back bookings, so early check-in/late checkout can only be confirmed 2 days before the date.
- **More than 2 days before check-in/checkout date:** Do NOT escalate. Simply inform the guest: "We can only confirm early check-in/late checkout 2 days before your date since we may have guests checking out that morning. In the meantime, you're welcome to leave your bags with housekeeping and grab coffee or food at O1 Mall — it's a 1-minute walk." Set escalation to null.
- **Within 2 days of check-in/checkout date:** Tell the guest you'll check with your team. Escalate to manager with urgency "info_request."
- Never confirm early check-in or late checkout yourself.

---

## SCHEDULING LOGIC

**During working hours (10 AM – 5 PM):**
- Ask for preferred time
- If guest says "now" → treat as confirmed, escalate immediately
- If guest gives a specific time → confirm and escalate

**After working hours (after 5 PM):**
- Inform guest it will be arranged for tomorrow
- Ask for preferred morning time → confirm → escalate

**Multiple requests in one message:**
- Assume one time slot unless the guest explicitly wants separate visits (e.g., "bring the crib now, cleaning later when we leave")

---

## ESCALATION LOGIC

### Set "escalation": null when:
- Answering questions from PROPERTY & GUEST INFO (WiFi, door code, check-in/out, address, amenities)
- Asking the guest for their preferred time (before they've confirmed)
- Explaining the $20 cleaning fee
- Providing early check-in/late checkout policy (when request is more than 2 days out — do NOT escalate these)
- Simple clarifications that need no action
- Guest sends a conversation-ending message ("okay", "thanks", 👍) — also set guest_message to ""

### Set "escalation" with urgency "immediate" when:
- Emergencies: fire, gas, flood, medical, safety threats
- Technical issues: WiFi not working, door code failure, broken appliances
- Noise complaints
- Guest complaints or expressed dissatisfaction
- House rule violations or pushback
- Guest sends an image (after you analyze and respond to it)
- Anything you're unsure about

### Set "escalation" with urgency "scheduled" when:
- Cleaning request — after guest confirms time and you've mentioned $20
- Amenity delivery — after guest confirms time
- Maintenance/repair — after guest confirms time
- After-hours requests — after next-day time is confirmed

### Set "escalation" with urgency "info_request" when:
- Local recommendations (restaurants, hospitals, malls, attractions)
- Reservation changes (extend stay, change dates)
- Early check-in or late checkout requests ONLY when within 2 days of the date
- Refund or discount requests — never authorize, always escalate
- Pricing inquiries beyond what's in SOPs
- Any question you don't have the answer to

---

## OUTPUT FORMAT

Respond ONLY with raw JSON. No markdown, no code blocks, no extra text before or after the JSON.

When no escalation is needed:
{"guest_message":"Your message here","escalation":null}

When escalation is needed:
{"guest_message":"Your message here","escalation":{"title":"kebab-case-label","note":"Actionable note for Abdelrahman with guest name, unit, and details","urgency":"immediate"}}

When no reply is needed (guest sent "okay", "thanks", thumbs up, and conversation is ending):
{"guest_message":"","escalation":null}

When resolving a completed task (guest confirms issue is fixed):
{"guest_message":"Glad to hear it.","escalation":null,"resolveTaskId":"task-id-from-open-tasks"}

When updating an existing task with new details:
{"guest_message":"Got it, I'll update that for you.","escalation":{"title":"updated-label","note":"Updated details...","urgency":"scheduled"},"updateTaskId":"task-id-from-open-tasks"}

Rules:
- Both keys must ALWAYS be present: "guest_message" and "escalation"
- When escalation is null, output null — not an empty object
- When escalation is needed, all three fields (title, note, urgency) are required
- Always include the guest's name and unit number in escalation notes
- resolveTaskId: optional — set to a task ID from OPEN TASKS when the guest confirms an issue is resolved
- updateTaskId: optional — set to a task ID from OPEN TASKS when updating an existing escalation with new info
- Never include markdown, code blocks, or extra text outside the JSON

---

## EXAMPLES

**Example 1 — Simple info question:**

Guest: "What's the WiFi password?"

{"guest_message":"WiFi network is [name from property info], password is [password from property info].","escalation":null}

Read WiFi details from PROPERTY & GUEST INFO and provide directly. No filler, no "hope that helps!".

**Example 2 — Cleaning request (two-turn flow):**

Guest: "Can we get the place cleaned today?"

{"guest_message":"Sure, what time works for you? We do visits between 10am and 5pm.","escalation":null}

Guest: "Around 1pm"

{"guest_message":"Got it, housekeeping will come around 1pm. Just so you know, cleaning is $20 per session.","escalation":{"title":"cleaning-scheduled","note":"Guest [Name] in [Unit] requested cleaning at 1pm today. Confirmed. $20 charge applies.","urgency":"scheduled"}}

Fee is mentioned on confirmation, not on the first ask. Tone is casual and direct.

**Example 3 — Urgent issue:**

Guest: "There's no hot water"

{"guest_message":"Sorry about that — I'm getting someone to look into it now.","escalation":{"title":"maintenance-no-hot-water","note":"Guest [Name] in [Unit] reports no hot water. Needs maintenance ASAP.","urgency":"immediate"}}

No panic, no over-apologizing. Just acknowledge and act.

**Example 4 — Unknown item request:**

Guest: "Do you have a phone charger?"

{"guest_message":"Let me check on that and get back to you.","escalation":{"title":"amenity-request-unlisted","note":"Guest [Name] in [Unit] asking for a phone charger. Not on standard amenities list. Please confirm if available.","urgency":"info_request"}}

Never confirm availability of items not in PROPERTY & GUEST INFO.

**Example 5 — After-hours request:**

Guest: "Can someone clean the apartment?" (sent at 8pm)

{"guest_message":"I can arrange cleaning for tomorrow. What time works for you between 10am and 5pm?","escalation":null}

After 5pm, everything gets pushed to the next day. Check CURRENT LOCAL TIME.

**Example 6 — Early check-in, more than 2 days out:**

Guest: "I'm arriving at noon, can I check in before 3pm?" (check-in is far away)

{"guest_message":"We can only confirm early check-in 2 days before your date since there may be guests checking out that morning. You're welcome to leave your bags with housekeeping and grab something at O1 Mall — it's a 1-minute walk.","escalation":null}

No escalation needed. Just inform the policy and offer the alternative.

**Example 7 — Task resolution:**

OPEN TASKS shows: [clm9abc123] maintenance-no-hot-water (immediate)
Guest: "Hot water is working now, thanks!"

{"guest_message":"","escalation":null,"resolveTaskId":"clm9abc123"}

Guest confirmed the issue is resolved — resolve the task and no reply needed.

---

## HARD BOUNDARIES

- Never authorize refunds, credits, or discounts
- Never guarantee specific arrival times — use "shortly" or "as soon as possible"
- Never guess information you don't have — if an item, service, or detail isn't in your SOPs or PROPERTY & GUEST INFO, don't confirm it exists
- Never confirm cleaning/amenity/maintenance without getting the guest's preferred time first
- Never confirm early check-in or late checkout — always escalate
- Never discuss internal processes or the manager with the guest
- Never answer questions or accept requests you don't know the answer to — always escalate to manager if unsure
- Always uphold house rules — escalate any pushback immediately
- Prioritize safety threats above all else
- When in doubt, escalate — it's better to over-escalate than miss something important
- Never output anything other than the JSON object`;

const OMAR_SCREENING_SYSTEM_PROMPT = `# OMAR — Guest Screening Assistant, Boutique Residence

You are Omar, a guest screening assistant for Boutique Residence serviced apartments in New Cairo, Egypt. Your manager is Abdelrahman. You screen guest inquiries against house rules, answer basic property questions, and escalate to Abdelrahman when a booking decision is needed.

Before responding, always reason through the request internally: check conversation history for what's already been answered, identify what information is still missing, apply house rules, and only then draft your response.

---

## CONTEXT YOU RECEIVE

Each message contains:
- **\`### CONVERSATION HISTORY ###\`** — all previous messages between you and the guest
- **\`### PROPERTY & GUEST INFO ###\`** — guest name, booking dates, number of guests, unit details
- **\`### CURRENT GUEST MESSAGE(S) ###\`** — the guest's latest message(s)

Always check conversation history first. Do NOT re-ask questions the guest has already answered.

---

## TONE & STYLE

- Talk like a normal human. Not overly friendly, not robotic. Just natural and professional.
- 1–2 sentences max. Keep it short and focused.
- Always respond in English, regardless of what language the guest writes in.
- Avoid excessive exclamation marks. Don't overuse the guest's name.
- Use the guest's first name sparingly — once in a conversation is enough.
- Never mention the manager, AI, systems, screening criteria, or Egyptian government regulations to the guest. Say "house rules" not "regulations."
- Never reference JSON, output format, or internal processes to the guest.
- **If a guest sends a conversation-ending message** ("okay", "thanks", "👍") **and there's nothing left to ask or action — set guest message to "" and manager needed to true with note indicating guest is awaiting manager review.**

When declining:
- Be polite but firm. One sentence is enough.
- Don't over-explain or apologize excessively.
- Example: "Unfortunately, we can only accommodate families and married couples at this property."

---

## SCREENING RULES

### Arab Nationals:

**ACCEPTED:**
- Families (parents with children) — marriage certificate + passports required after booking is accepted, family names must match
- Married couples — marriage certificate required after booking is accepted
- Female-only groups (any size, including solo females)

**NOT ACCEPTED:**
- Single Arab men (except Lebanese and Emirati — see exception below)
- All-male Arab groups (any size)
- Unmarried Arab couples (fiancés, boyfriends/girlfriends, dating partners)
- Mixed-gender Arab groups that are not family

### Lebanese & Emirati Nationals (Exception — effective 1 March 2026):

**ACCEPTED:**
- Solo traveler (male or female) — staying entirely alone in the unit

**NOT ACCEPTED:**
- Any group (male-only, female-only, or mixed) — this exception is for solo guests only
- Unmarried couples — same rule as all other Arabs applies
- If traveling with anyone else, revert to standard Arab rules above

### Non-Arab Nationals:

**ACCEPTED:**
- All configurations — families, couples, friends, solo travelers, any gender mix

### Mixed Nationality Groups:

- If ANY guest in the party is an Arab national, apply Arab rules to the ENTIRE party
- Example: British man + Egyptian woman (unmarried) = NOT accepted

### Important Rules:

- **Always ask nationality explicitly.** Never assume nationality from names. Some Arabs hold other nationalities and are treated as non-Arabs.
- **You can assume gender from names** unless the name is ambiguous (e.g., "Nour" can be male or female — ask in that case).
- **Documents cannot be sent before booking is accepted.** If a guest asks where to send their marriage certificate or passport, tell them: once the booking is accepted, they can send the documents through the chat.
- **Guests who refuse or say they cannot provide required documents** (marriage certificate/passports) = NOT accepted. Escalate with rejection recommendation.

---

## SCREENING WORKFLOW

**Step 1:** Check conversation history — what do you already know?

**Step 2:** If missing, ask for:
1. Nationality — "Could you share your nationality?" (for groups: "What are the nationalities of everyone in your party?")
2. Party composition — "Who will you be traveling with?"
3. Relationship (only if needed for Arab couples) — "Are you married?"

Ask naturally. Don't fire all questions at once if you can infer some from context.

**Step 3:** Once you have nationality + party composition, apply the rules above.

**Step 4:** Respond to guest and escalate appropriately.

---

## PROPERTY INFORMATION

**Hours:**
- Check-in: 3:00 PM
- Check-out: 11:00 AM

**Free Amenities (on request):**
- Baby crib, extra bed, hair dryer, kitchen blender, kids dinnerware, espresso machine
- Extra towels, extra pillows, extra blankets, hangers
- These are the ONLY available amenities. If a guest asks for an item NOT on this list, do not confirm availability. Tell them you'll check and escalate.

**House Rules (shareable with guest):**
- Family-only property
- No outside visitors permitted at any time
- No smoking indoors
- No parties or gatherings
- Quiet hours apply

**You CANNOT answer (escalate to manager):**
- Pricing questions or discounts
- Availability changes or date modifications
- Refund or cancellation policy questions
- Detailed neighborhood/location recommendations
- Special requests beyond listed amenities
- Anything you're unsure about

---

## IMAGE HANDLING

During screening, guests cannot send images before booking is accepted. However, if an image comes through:
1. Acknowledge it and check if it's a marriage certificate, passport, or ID.
2. If it's a document: tell the guest you've received it and escalate to manager for verification.
3. If it's unclear or unrelated: escalate with "Guest sent an image that requires manager review."

If a guest asks where or how to send their documents, tell them: "Once the booking is accepted, you'll be able to send the documents through the chat."

---

## ESCALATION LOGIC

### Set "needed": false when:
- You are still gathering information (asking follow-up questions)
- Answering basic property questions (check-in/out, amenities, house rules)
- Conversation is incomplete — you don't have enough info to make a determination yet

### Set "needed": true when:

**ELIGIBLE — Recommend Acceptance:**
- Non-Arab guest(s), any configuration → title: "eligible-non-arab"
- Arab female-only group or solo female → title: "eligible-arab-females"
- Arab family (certificate + passports requested) → title: "eligible-arab-family-pending-docs"
- Arab married couple (certificate requested) → title: "eligible-arab-couple-pending-cert"
- Lebanese or Emirati solo traveler (male or female) → title: "eligible-lebanese-emirati-single"

**NOT ELIGIBLE — Recommend Rejection:**
- Single Arab male → title: "violation-arab-single-male"
- All-male Arab group → title: "violation-arab-male-group"
- Unmarried Arab couple → title: "violation-arab-unmarried-couple"
- Mixed-gender Arab group (not family) → title: "violation-arab-mixed-group"
- Mixed nationality unmarried couple (Arab rules apply) → title: "violation-mixed-unmarried-couple"
- Guest refuses or cannot provide required documents → title: "violation-no-documents"

**REQUIRES MANAGER:**
- Guest challenges or argues about rules → title: "escalation-guest-dispute"
- Guest asks about visitors (after informing them of the rule) → title: "visitor-policy-informed"
- Ambiguous or unclear situation → title: "escalation-unclear"
- Question beyond your knowledge → title: "escalation-unknown-answer"
- Guest sends conversation-ending message while awaiting booking decision → title: "awaiting-manager-review"

---

## OUTPUT FORMAT

Respond ONLY with raw JSON. No markdown, no code blocks, no extra text before or after the JSON.

When no escalation needed (still gathering info or answering basic questions):
{"guest message":"Your message here","manager":{"needed":false,"title":"","note":""}}

When escalation needed:
{"guest message":"Your message here","manager":{"needed":true,"title":"category-label","note":"Detailed note for Abdelrahman with guest name, unit, nationality, party details, and recommendation."}}

When no reply needed (guest sent "okay"/"thanks" while awaiting booking decision):
{"guest message":"","manager":{"needed":true,"title":"awaiting-manager-review","note":"Guest [Name] for [Unit] — screening complete, awaiting manager booking decision. [Recommendation]."}}

---

## EXAMPLES

**Example 1 — Initial inquiry, need info:**

Guest: "Hi, I'd like to book your place"

{"guest message":"Hi, thanks for reaching out. Could you share your nationality and who you'll be traveling with?","manager":{"needed":false,"title":"","note":""}}

Still gathering info. No escalation yet.

**Example 2 — Non-Arab guest, eligible:**

Guest: "I'm French, traveling with my girlfriend"

{"guest message":"Great, we'd be happy to host you. Our team will confirm your reservation shortly.","manager":{"needed":true,"title":"eligible-non-arab","note":"French couple (non-Arab). All criteria met. Recommend acceptance."}}

Non-Arab = any configuration accepted.

**Example 3 — Arab married couple, eligible pending cert:**

Guest: "We're an Egyptian married couple"

{"guest message":"We'd be happy to host you. Once the booking is accepted, please send a copy of your marriage certificate through the chat for verification.","manager":{"needed":true,"title":"eligible-arab-couple-pending-cert","note":"Egyptian married couple. Eligible. Marriage certificate requested after booking acceptance. Recommend acceptance."}}

Certificate is sent AFTER booking is accepted, not before.

**Example 4 — Arab unmarried couple, not eligible:**

Conversation history: Guest confirmed Egyptian nationality
Guest: "I'm traveling with my fiancée"

{"guest message":"Unfortunately, we can only accommodate married couples with a valid marriage certificate at this property.","manager":{"needed":true,"title":"violation-arab-unmarried-couple","note":"Egyptian guest traveling with fiancée. Unmarried couple. Violates house rules. Recommend rejection."}}

Polite, firm, one sentence. No over-explaining.

**Example 5 — Mixed nationality, Arab rules apply:**

Guest: "I'm British, my girlfriend is Egyptian"

{"guest message":"Since one member of your party is Egyptian, we require couples to be married with a valid marriage certificate.","manager":{"needed":true,"title":"violation-mixed-unmarried-couple","note":"British man + Egyptian woman, unmarried. Arab rules apply to entire party. Violates house rules. Recommend rejection."}}

If ANY guest is Arab, Arab rules apply to everyone.

---

## HARD BOUNDARIES

- Never assume nationality from names — always ask explicitly
- Never accept unmarried Arab couples — no exceptions, including fiancés
- Never confirm a booking yourself — always escalate to manager
- Never share screening criteria or mention government regulations with the guest
- Never guess information you don't have — if it's not in your SOPs or property info, escalate
- Never discuss internal processes, the manager, or AI with the guest
- Always request marriage certificate/passports AFTER booking acceptance, not before
- When in doubt, escalate
- Never output anything other than the JSON object`;

const MANAGER_TRANSLATOR_SYSTEM_PROMPT = `## SYSTEM INSTRUCTIONS - MANAGER REPLY TRANSLATOR BOT

You are Omar, the Lead Guest Coordinator for Boutique Residence. Your specific role in THIS conversation is to translate internal manager instructions into warm, professional guest-facing messages.

## CRITICAL CONTEXT

What you're receiving:
- The input message is from your manager, Abdelrahman - NOT from the guest
- This is an internal instruction/answer to a guest question you previously escalated
- The guest is waiting for your response

Your task:
- Transform Abdelrahman's internal note into a polished, guest-ready message
- Use conversation history to maintain context and flow
- Respond as if YOU (Omar) are directly answering the guest

What you're NOT doing:
- Do NOT mention "the manager said" or "I asked my team"
- Do NOT escalate back to the manager (this IS the manager's answer)
- Do NOT add your own information unless it's basic courtesy

## TONE & STYLE

Tone: professional, concierge-level hospitality
Length: 1-2 sentences maximum (3 sentences only if providing instructions)
Format:
- Be direct and helpful
- Use bullet points ONLY for step-by-step instructions
- Avoid unnecessary "fluff" or over-apologizing
- Avoid using exclamation marks

## TRANSLATION EXAMPLES

Example 1: Simple answer

Manager instruction: "12345"
Guest context: Previously asked for Netflix password

Your response:
"The Netflix password is 12345."

Example 2: Informative answer

Manager instruction: "tell them the nearest pharmacy is Al Ezaby on road 90, 5 min walk"
Guest context: Asked where to buy medicine

Your response:
"The nearest pharmacy is Al Ezaby Pharmacy on Road 90, just a 5-minute walk from the apartment. Feel free to reach out if you need the exact location"

Example 3: Instructions with steps

Manager instruction: "yes they can late checkout until 2pm, charge them $30 extra"
Guest context: Asked for late checkout

Your response:
"Late checkout until 2:00 PM is available for an additional $30. Let me know if you'd like to arrange this."`;

// ─── Context builder helpers ──────────────────────────────────────────────────

// Upgrade 5a: Grounded property info — AI only answers from verified data
function buildPropertyInfo(
  guestName: string,
  checkIn: string,
  checkOut: string,
  guestCount: number,
  listing: {
    name?: string;
    internalListingName?: string;
    personCapacity?: number;
    roomType?: string;
    bedroomsNumber?: number;
    bathroomsNumber?: number;
    address?: string;
    city?: string;
    doorSecurityCode?: string;
    wifiUsername?: string;
    wifiPassword?: string;
  },
  retrievedChunks?: Array<{ content: string; category: string }>,
  reservationStatus?: string
): string {
  // Compute human-readable booking status
  const bookingStatusDisplay = (() => {
    if (!reservationStatus) return 'Unknown';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const ci = new Date(checkIn); ci.setHours(0, 0, 0, 0);
    const co = new Date(checkOut); co.setHours(0, 0, 0, 0);
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

  // SECURITY: Only include access codes for CONFIRMED or CHECKED_IN guests.
  // Allowlist approach — any other status (INQUIRY, CANCELLED, CHECKED_OUT, unknown) is blocked.
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

  if (retrievedChunks && retrievedChunks.length > 0) {
    info += '\n### RELEVANT PROCEDURES & KNOWLEDGE\n';
    info += "The following was retrieved based on the guest's current question:\n";
    for (const chunk of retrievedChunks) {
      info += `[${chunk.category}] ${chunk.content}\n`;
    }
  }

  return info;
}

// ─── Content block builder from template ─────────────────────────────────────

function buildContentBlocks(
  template: string | undefined,
  vars: Record<string, string>
): ContentBlock[] {
  if (!template) {
    // Fallback: hardcoded default content blocks
    return [
      { type: 'text', text: `### CONVERSATION HISTORY ###\n${vars.conversationHistory || ''}` },
      { type: 'text', text: `### PROPERTY & GUEST INFO ###\n\n${vars.propertyInfo || ''}` },
      { type: 'text', text: `### CURRENT GUEST MESSAGE(S) ###\n${vars.currentMessages || ''}\n\n### CURRENT LOCAL TIME###\n${vars.localTime || ''}` },
    ];
  }

  // Split template on ### headers and interpolate {{variables}}
  const sections = template.split(/(?=### )/).filter(s => s.trim());
  return sections.map(section => {
    let text = section;
    for (const [key, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }
    return { type: 'text' as const, text };
  });
}

// ─── Escalation handler — creates Task + private [MANAGER] message ───────────

async function handleEscalation(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  propertyId: string | undefined,
  title: string,
  note: string,
  urgency: string,
  updateTaskId?: string | null,
  resolveTaskId?: string | null,
  guestMessage?: string
): Promise<void> {
  try {
    let task;

    // Resolve old task if requested — independent of new task creation so the
    // AI can close one task and open another in the same response.
    // T018: Verify task belongs to tenant before mutating.
    if (resolveTaskId) {
      const resolveTarget = await prisma.task.findFirst({
        where: { id: resolveTaskId, tenantId },
      });
      if (!resolveTarget) {
        console.warn(`[AI] resolveTaskId ${resolveTaskId} not found for tenant ${tenantId} — skipping`);
      } else {
        const resolved = await prisma.task.update({
          where: { id: resolveTaskId },
          data: { status: 'completed', completedAt: new Date() },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task: resolved });
      }
    }

    if (updateTaskId) {
      const updateTarget = await prisma.task.findFirst({
        where: { id: updateTaskId, tenantId },
      });
      if (!updateTarget) {
        console.warn(`[AI] updateTaskId ${updateTaskId} not found for tenant ${tenantId} — skipping`);
      } else {
        task = await prisma.task.update({
          where: { id: updateTaskId },
          data: { title, note, urgency },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task });
      }
    } else if (title) {
      // Task Manager: check if this escalation duplicates an existing open task
      const openTasks = await prisma.task.findMany({
        where: { conversationId, status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      const tmResult = await evaluateEscalation({
        tenantId,
        conversationId,
        newEscalation: { title, note, urgency },
        openTasks: openTasks.map(t => ({
          id: t.id, title: t.title, note: t.note, urgency: t.urgency, createdAt: t.createdAt,
        })),
        guestMessage: guestMessage || '',
      });

      console.log(`[AI] Task Manager: ${tmResult.action}${tmResult.taskId ? ` → ${tmResult.taskId}` : ''} (${tmResult.reason})`);

      if (tmResult.action === 'update' && tmResult.taskId) {
        // Append note to existing task (preserve history)
        const existingTask = openTasks.find(t => t.id === tmResult.taskId);
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
        let updatedNote = (existingTask?.note || '') + `\n[Update ${timeStr}] ${note}`;
        // Cap at 2000 chars — trim oldest [Update] entries if exceeded
        if (updatedNote.length > 2000) {
          const lines = updatedNote.split('\n');
          while (updatedNote.length > 2000 && lines.length > 2) {
            // Remove the second line (first [Update] entry, keep [Original])
            const idx = lines.findIndex((l, i) => i > 0 && l.startsWith('[Update'));
            if (idx > 0) lines.splice(idx, 1);
            else break;
            updatedNote = lines.join('\n');
          }
        }
        task = await prisma.task.update({
          where: { id: tmResult.taskId },
          data: { note: updatedNote, urgency },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task });
      } else if (tmResult.action === 'resolve' && tmResult.taskId) {
        // Close existing task
        task = await prisma.task.update({
          where: { id: tmResult.taskId },
          data: { status: 'completed', completedAt: new Date() },
        });
        broadcastToTenant(tenantId, 'task_updated', { conversationId, task });
      } else if (tmResult.action === 'skip') {
        // Log and return — no task action
        console.log(`[AI] Task Manager: skipped redundant escalation for conv ${conversationId}`);
        return;
      } else {
        // CREATE (default) — existing behavior
        task = await createTask(prisma, {
          tenantId,
          conversationId,
          propertyId,
          title,
          note,
          urgency,
          source: 'ai',
        });
        broadcastToTenant(tenantId, 'new_task', { conversationId, task });
      }

      // Auto-create knowledge suggestion for info_request escalations
      if (urgency === 'info_request') {
        await prisma.knowledgeSuggestion.create({
          data: {
            tenantId,
            propertyId,
            conversationId,
            question: note,
            answer: '',
            status: 'pending',
            source: 'ai_identified',
          },
        }).catch(err => console.warn('[AI] Could not create knowledge suggestion:', err));
        broadcastToTenant(tenantId, 'knowledge_suggestion', { conversationId });
      }
    }

    // Save AI private note and broadcast it so it shows in chat
    // Skip for bare resolves (no new/updated task)
    if (note && task) {
      const privateMsg = await prisma.message.create({
        data: {
          conversationId,
          tenantId,
          role: MessageRole.AI_PRIVATE,
          content: note,
          sentAt: new Date(),
          channel: 'OTHER',
          communicationType: 'internal',
        },
      });
      broadcastToTenant(tenantId, 'message', {
        conversationId,
        message: { role: 'AI_PRIVATE', content: note, sentAt: privateMsg.sentAt.toISOString(), channel: 'OTHER', imageUrls: [] },
        lastMessageRole: 'AI_PRIVATE',
        lastMessageAt: privateMsg.sentAt.toISOString(),
      });
    }

    console.log(`[AI] [${conversationId}] Escalation handled: ${title}`);
  } catch (err) {
    console.error(`[AI] [${conversationId}] Failed to handle escalation:`, err);
  }
}

// ─── Main AI reply generation ─────────────────────────────────────────────────

export interface AiReplyContext {
  tenantId: string;
  conversationId: string;
  propertyId?: string;
  windowStartedAt?: Date;  // start of debounce window — used to filter "current" messages
  hostawayConversationId: string;
  hostawayApiKey: string;
  hostawayAccountId: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  reservationStatus: string;
  listing: {
    name?: string;
    internalListingName?: string;
    personCapacity?: number;
    roomType?: string;
    bedroomsNumber?: number;
    bathroomsNumber?: number;
    address?: string;
    city?: string;
    doorSecurityCode?: string;
    wifiUsername?: string;
    wifiPassword?: string;
  };
  customKnowledgeBase?: Record<string, unknown>;
  listingDescription?: string;
  aiMode?: string;
}

export async function generateAndSendAiReply(
  context: AiReplyContext,
  prisma: PrismaClient
): Promise<void> {
  const { tenantId, conversationId, hostawayConversationId, hostawayApiKey, hostawayAccountId } = context;

  console.log(`[AI] [${conversationId}] Generating AI reply...`);

  try {
    // Upgrade 6d: Fetch per-tenant AI configuration (cached, 5min TTL)
    const tenantConfig = await getTenantAiConfig(tenantId, prisma).catch(() => null);

    // Fetch ALL message history from local DB (not Hostaway API)
    const aiCfg = getAiConfig();
    const dbMessages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });
    // Exclude manager private messages from AI context
    const allMsgs = dbMessages.filter(
      m => !m.content.startsWith('[MANAGER]') && m.role !== 'AI_PRIVATE' && m.role !== 'MANAGER_PRIVATE'
    );

    // Upgrade 4: Tiered memory — summary for old messages + verbatim recent 10
    let historyText: string;
    if (tenantConfig?.memorySummaryEnabled !== false && allMsgs.length > 10) {
      const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
      if (conversation) {
        const tiered = await buildTieredContext({
          conversationId,
          messages: allMsgs,
          conversation,
          prisma,
          anthropicClient: anthropic,
        }).catch(() => ({
          recentMessagesText: allMsgs.slice(-10).map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`).join('\n'),
          summaryText: null,
          totalMessageCount: allMsgs.length,
        }));
        historyText = formatConversationContext(tiered);
      } else {
        historyText = allMsgs.map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`).join('\n');
      }
    } else {
      historyText = allMsgs.map(m => `${m.role === 'GUEST' ? 'Guest' : 'Omar'}: ${m.content}`).join('\n');
    }

    // Current messages = only GUEST messages received during this debounce window.
    // Buffer extends 30 min back from windowStartedAt to handle Hostaway webhook delivery delays:
    // Hostaway timestamps `data.date` as when the guest sent the message, but webhooks can arrive
    // 5–30 min late. Without a large enough buffer, sentAt < windowStart → AI skips responding.
    const WEBHOOK_DELIVERY_BUFFER_MS = 10 * 60 * 1000; // Reduced from 30min to 10min (AUD-041)
    const windowStart = context.windowStartedAt
      ? new Date(context.windowStartedAt.getTime() - WEBHOOK_DELIVERY_BUFFER_MS)
      : null;
    const currentMsgs = windowStart
      ? allMsgs.filter(m => m.role === 'GUEST' && m.sentAt >= windowStart)
      : allMsgs.slice(-5).filter(m => m.role === 'GUEST');
    const currentMsgsText = currentMsgs
      .map(m => `Guest: ${m.content}`)
      .join('\n');

    if (!currentMsgsText.trim()) {
      console.log(`[AI] [${conversationId}] No guest messages in current window — skipping`);
      return;
    }

    // Fetch open tasks for context injection
    const openTasks = await prisma.task.findMany({
      where: { conversationId, status: 'open' },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    const openTasksText = openTasks.length > 0
      ? openTasks.map(t => {
          const notePreview = t.note ? `\n  → ${t.note.substring(0, 300)}` : '';
          return `[${t.id}] ${t.title} (${t.urgency})${notePreview}`;
        }).join('\n')
      : 'No open tasks.';

    // Fetch approved knowledge base for this property
    const approvedKnowledge = await prisma.knowledgeSuggestion.findMany({
      where: {
        tenantId,
        status: 'approved',
        OR: [{ propertyId: context.propertyId || null }, { propertyId: null }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    const knowledgeText = approvedKnowledge.length > 0
      ? approvedKnowledge.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n')
      : 'No additional Q&A available.';

    const localTime = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });

    // Property amenities string for dynamic SOP injection
    const propertyAmenities = context.customKnowledgeBase?.amenities
      ? String(context.customKnowledgeBase.amenities) : undefined;

    // Upgrade 5c: RAG — retrieve relevant property knowledge for this query.
    // Use LAST guest message for classification (cleaner signal for KNN — accumulated
    // messages dilute intent, e.g., "brother" + "Saudi Arabia" oscillates between
    // visitor-policy and non-actionable). AI still sees ALL messages in content blocks.
    const ragQuery = currentMsgs.length > 0
      ? currentMsgs[currentMsgs.length - 1].content
      : currentMsgs.map((m: { content: string }) => m.content).join(' ');
    const ragStart = Date.now();
    // Pass conversationId + recent messages for low-tier intent extraction fallback (T013)
    const recentForRag = allMsgs.slice(-10).map(m => ({
      role: m.role === 'GUEST' ? 'guest' : 'host',
      content: m.content,
    }));
    const ragResult = tenantConfig?.ragEnabled !== false && context.propertyId
      ? await retrieveRelevantKnowledge(
          tenantId, context.propertyId, ragQuery, prisma, 8,
          context.reservationStatus === 'INQUIRY' ? 'screeningAI' : 'guestCoordinator',
          conversationId, recentForRag,
          propertyAmenities
        ).catch(() => ({ chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>, topSimilarity: 0, tier: 'tier2_needed' as const, confidenceTier: undefined as 'high' | 'medium' | 'low' | undefined, topCandidates: undefined as Array<{ label: string; confidence: number }> | undefined, intentExtractorRan: undefined as boolean | undefined }))
      : { chunks: [] as Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>, topSimilarity: 0, tier: 'tier1' as const, confidenceTier: undefined as 'high' | 'medium' | 'low' | undefined, topCandidates: undefined as Array<{ label: string; confidence: number }> | undefined, intentExtractorRan: undefined as boolean | undefined };
    let retrievedChunks = ragResult.chunks;
    const ragDurationMs = Date.now() - ragStart;

    // Capture classifier metadata right after RAG retrieval (for ragContext logging)
    // Atomically snapshot + clear to prevent concurrent request from reading stale data
    const classifierSnap = getAndClearLastClassifierResult();

    // —— Tier 3: Topic State Cache ——————————————————————————
    // Only SOP labels drive topic state — property-* and learned-answers are passive context
    const retrievedLabels = retrievedChunks.map((c: any) => c.category)
      .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
    const retrievedSopLabels = retrievedLabels.filter(
      (l: string) => !l.startsWith('property-') && l !== 'learned-answers' && l !== 'contextual'
    );
    let tier3Reinjected = false;
    let tier3TopicSwitch = false;
    let tier3ReinjectedLabels: string[] = [];

    if (retrievedSopLabels.length > 0) {
      updateTopicState(conversationId, retrievedSopLabels);
    } else if (ragResult.tier !== 'tier1') {
      // Only check Tier 3 when Tier 1 wasn't confident.
      // If Tier 1 returned "contextual" or property-only labels at high confidence, skip Tier 3.
      const tier3Result = getReinjectedLabels(conversationId, ragQuery, classifierSnap?.queryEmbedding);
      tier3Reinjected = tier3Result.reinjected;
      tier3TopicSwitch = tier3Result.topicSwitchDetected;

      if (tier3Result.reinjected && tier3Result.labels.length > 0) {
        // Direct SOP lookup — no redundant vector search needed
        const reinjectedChunks = tier3Result.labels
          .map(label => {
            const content = getSopContent(label, propertyAmenities);
            return content ? {
              content,
              category: label,
              similarity: 1.0,
              sourceKey: label,
              propertyId: null as string | null,
            } : null;
          })
          .filter((c): c is NonNullable<typeof c> => c !== null);

        if (reinjectedChunks.length > 0) {
          retrievedChunks.push(...reinjectedChunks);
          ragResult.tier = 'tier3_cache';
          ragResult.topSimilarity = Math.max(ragResult.topSimilarity, 1.0);
          tier3ReinjectedLabels = tier3Result.labels;
          console.log(`[AI] Tier 3 re-injected ${reinjectedChunks.length} chunks for conv ${conversationId}: [${tier3Result.labels.join(', ')}]`);
        }
      }
    }

    // —— Tier 2: Canonical Intent Extractor (real Haiku call) ——————————
    let tier2ResolvedLabels: string[] | undefined;
    let tier2Output: { topic: string; status: string; urgency: string; sops: string[] } | null = null;
    if (ragResult.tier === 'tier2_needed' && !tier3Reinjected && !ragResult.intentExtractorRan) {
      const recentForTier2 = allMsgs.slice(-10).map(m => ({
        role: m.role === 'GUEST' ? 'guest' : 'host',
        content: m.content,
      }));

      try {
        const tier2Result = await extractIntent(recentForTier2, tenantId, conversationId);
        if (tier2Result) {
          tier2Output = { topic: tier2Result.topic, status: tier2Result.status, urgency: tier2Result.urgency, sops: tier2Result.sops };
        }
        if (tier2Result && tier2Result.sops.length > 0) {
          // Direct SOP lookup — no redundant vector search needed
          const tier2Chunks = tier2Result.sops
            .map(label => {
              const content = getSopContent(label, propertyAmenities);
              return content ? {
                content,
                category: label,
                similarity: 1.0,
                sourceKey: label,
                propertyId: null as string | null,
              } : null;
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);

          if (tier2Chunks.length > 0) {
            retrievedChunks.push(...tier2Chunks);
            ragResult.tier = 'tier1'; // Tier 2 resolved it
            ragResult.topSimilarity = Math.max(ragResult.topSimilarity, 1.0);
            // Update topic state with Tier 2's classification
            updateTopicState(conversationId, tier2Result.sops);
            tier2ResolvedLabels = tier2Result.sops;
            console.log(`[AI] Tier 2 resolved: ${tier2Result.topic} → [${tier2Result.sops.join(', ')}]`);
          }
        } else if (
          tier2Result &&
          tier2Result.sops.length === 0 &&
          ['follow_up', 'ongoing_issue', 'just_chatting'].includes(tier2Result.status)
        ) {
          // Tier 2 says this is contextual — re-inject SOPs from previous AI response
          try {
            const prevLog = await prisma.aiApiLog.findFirst({
              where: { tenantId, conversationId },
              orderBy: { createdAt: 'desc' },
              select: { ragContext: true },
            });
            const prevRag = prevLog?.ragContext as any;
            const prevSopLabels = (prevRag?.chunks || [])
              .map((c: any) => c.category)
              .filter((cat: string) => !cat.startsWith('property-') && cat !== 'learned-answers')
              .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i) as string[];

            if (prevSopLabels.length > 0) {
              const contextChunks = prevSopLabels
                .map(label => {
                  const content = getSopContent(label, propertyAmenities);
                  return content ? {
                    content,
                    category: label,
                    similarity: 1.0,
                    sourceKey: label,
                    propertyId: null as string | null,
                  } : null;
                })
                .filter((c): c is NonNullable<typeof c> => c !== null);

              if (contextChunks.length > 0) {
                retrievedChunks.push(...contextChunks);
                ragResult.tier = 'tier3_cache';
                ragResult.topSimilarity = Math.max(ragResult.topSimilarity, 1.0);
                updateTopicState(conversationId, prevSopLabels);
                console.log(`[AI] Tier 2 contextual → re-injected previous SOPs: [${prevSopLabels.join(', ')}] (status=${tier2Result.status})`);
              }
            }
          } catch (err) {
            console.warn(`[AI] Tier 2 contextual re-injection failed (non-fatal):`, err);
          }
        }
      } catch (err) {
        console.warn(`[AI] Tier 2 failed (non-fatal):`, err);
      }
    }

    // —— Cross-tier deduplication (T004 / FR-001) ——————————————
    // SOPs can be added by Tier 1 (RAG), Tier 3 (re-injection), and Tier 2 (intent extractor).
    // Deduplicate by category to prevent the same SOP appearing multiple times in the prompt.
    {
      const seenCategories = new Set<string>();
      retrievedChunks = retrievedChunks.filter((c: any) => {
        if (seenCategories.has(c.category)) return false;
        seenCategories.add(c.category);
        return true;
      });
    }

    // —— Escalation enrichment (post-routing) ——————————————
    const escalationSignals = detectEscalationSignals(ragQuery);
    if (escalationSignals.length > 0) {
      console.log(`[AI] Escalation signals: ${escalationSignals.map(s => s.signal).join(', ')}`);
    }

    const ragContext: any = {
      query: ragQuery,
      chunks: retrievedChunks.map((c: any) => ({
        content: c.content?.substring(0, 2000),  // Capped at 2000 chars for DB storage (was 200, now reasonable for debugging — AUD-057)
        category: c.category,
        similarity: c.similarity,
        sourceKey: c.sourceKey || '',
        isGlobal: !c.propertyId,
      })),
      totalRetrieved: retrievedChunks.length,
      durationMs: ragDurationMs,
      topSimilarity: ragResult.topSimilarity,
      tier: ragResult.tier,
      // Three-tier confidence routing (T013)
      confidenceTier: ragResult.confidenceTier || null,
      topCandidates: ragResult.topCandidates || null,
      // Tier 1 details
      classifierUsed: context.reservationStatus !== 'INQUIRY',
      classifierLabels: classifierSnap?.labels || [],
      classifierTopSim: classifierSnap?.topSimilarity ?? null,
      classifierMethod: classifierSnap?.method || null,
      classifierConfidence: classifierSnap?.confidence ?? null,
      // Tier 3 details
      tier3Reinjected,
      tier3TopicSwitch,
      tier3ReinjectedLabels,
      // Tier 2 details
      tier2Output,
      // Escalation
      escalationSignals: escalationSignals.map(s => s.signal),
    };

    // T014: Auto-escalate when low tier returns empty (both classifier and intent extractor failed)
    if (ragResult.confidenceTier === 'low' && ragResult.chunks.length === 0) {
      await handleEscalation(prisma, tenantId, conversationId, context.propertyId,
        'classification-failure', 'Both LR classifier and intent extractor failed to classify this message.',
        'info_request');
      console.log(`[AI] [${conversationId}] Classification failure escalation — both LR and intent extractor returned empty`);
    }

    let propertyInfo = buildPropertyInfo(
      context.guestName,
      context.checkIn,
      context.checkOut,
      context.guestCount,
      context.listing,
      retrievedChunks,
      context.reservationStatus
    );

    // T014 / FR-012: Inject escalation signals into prompt so Claude can factor them in
    if (escalationSignals.length > 0) {
      propertyInfo += '\n### SYSTEM SIGNALS\n';
      propertyInfo += escalationSignals.map(s => `⚠ ${s.signal}`).join('\n');
      propertyInfo += '\nNote: These signals were automatically detected from the guest message. Consider them when deciding whether to escalate.\n';
    }

    // Check for image attachments in current window messages (from DB imageUrls field)
    const hasImages = currentMsgs.some(m => m.imageUrls && m.imageUrls.length > 0);

    const isInquiry = context.reservationStatus === 'INQUIRY';
    const agentName = isInquiry ? 'screeningAI' : 'guestCoordinator';
    const personaCfg = isInquiry ? aiCfg.screeningAI : aiCfg.guestCoordinator;

    // Upgrade 6d: Overlay tenant-specific settings onto persona config
    const effectiveModel = tenantConfig?.model || personaCfg.model;
    const effectiveTemperature = tenantConfig?.temperature ?? personaCfg.temperature;
    const effectiveMaxTokens = tenantConfig?.maxTokens || personaCfg.maxTokens;
    const effectiveAgentName = tenantConfig?.agentName || agentName;

    let effectiveSystemPrompt = personaCfg.systemPrompt;
    // Replace agent name in system prompt if customized
    if (tenantConfig?.agentName && tenantConfig.agentName !== 'Omar') {
      effectiveSystemPrompt = effectiveSystemPrompt.replace(/\bOmar\b/g, tenantConfig.agentName);
    }
    // Append custom instructions if configured
    if (tenantConfig?.customInstructions) {
      effectiveSystemPrompt += `\n\n## TENANT-SPECIFIC INSTRUCTIONS\nThe following instructions are specific to this property and override general guidelines where they conflict:\n${tenantConfig.customInstructions}`;
    }

    let guestMessage = '';

    const templateVars = {
      conversationHistory: historyText,
      propertyInfo,
      currentMessages: currentMsgsText,
      localTime,
      openTasks: openTasksText,
      knowledgeBase: knowledgeText,
    };

    if (!hasImages) {
      // Text-only branch
      const userContent = buildContentBlocks(personaCfg.contentBlockTemplate, templateVars);

      const rawResponse = await createMessage(effectiveSystemPrompt, userContent, {
        model: effectiveModel,
        temperature: effectiveTemperature,
        maxTokens: effectiveMaxTokens,
        ...(personaCfg.topK !== undefined ? { topK: personaCfg.topK } : {}),
        ...(personaCfg.topP !== undefined ? { topP: personaCfg.topP } : {}),
        ...(personaCfg.stopSequences?.length ? { stopSequences: personaCfg.stopSequences } : {}),
        agentName: effectiveAgentName,
        tenantId,
        conversationId,
        ragContext,
        openTaskCount: openTasks.length,
        totalMessages: allMsgs.length,
        memorySummarized: tenantConfig?.memorySummaryEnabled !== false && allMsgs.length > 10,
        hasImage: false,
        ragEnabled: tenantConfig?.ragEnabled !== false,
      });

      console.log(`[AI] [${conversationId}] Raw response: ${rawResponse.substring(0, 200)}`);

      try {
        if (isInquiry) {
          const parsed = JSON.parse(stripCodeFences(rawResponse)) as {
            'guest message': string;
            manager?: { needed: boolean; title: string; note: string };
          };
          guestMessage = parsed['guest message'] || '';
          // Handle screening escalation
          if (parsed.manager?.needed) {
            await handleEscalation(prisma, tenantId, conversationId, context.propertyId, parsed.manager.title, parsed.manager.note, 'info_request');
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.manager.title, escalationUrgency: 'info_request',
              escalationNote: parsed.manager.note,
            });
          }
        } else {
          const parsed = JSON.parse(stripCodeFences(rawResponse)) as {
            guest_message: string;
            resolveTaskId?: string | null;
            updateTaskId?: string | null;
            escalation: { title: string; note: string; urgency: string } | null;
          };
          guestMessage = parsed.guest_message || '';
          // T019: Validate AI output escalation fields before use
          if (parsed.escalation) {
            const validUrgencies = ['immediate', 'scheduled', 'info_request'];
            if (!validUrgencies.includes(parsed.escalation.urgency)) {
              parsed.escalation.urgency = 'immediate';
            }
            if (parsed.escalation.title) {
              parsed.escalation.title = parsed.escalation.title.slice(0, 200);
            }
            if (parsed.escalation.note) {
              parsed.escalation.note = parsed.escalation.note.slice(0, 2000);
            }
          }
          // Handle task resolve/update even when escalation is null
          if (parsed.escalation) {
            await handleEscalation(
              prisma, tenantId, conversationId, context.propertyId,
              parsed.escalation.title, parsed.escalation.note, parsed.escalation.urgency,
              parsed.updateTaskId, parsed.resolveTaskId, ragQuery
            );
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.escalation.title, escalationUrgency: parsed.escalation.urgency,
              escalationNote: parsed.escalation.note,
              taskResolved: parsed.resolveTaskId || undefined,
              taskUpdated: parsed.updateTaskId || undefined,
            });
          } else if (parsed.resolveTaskId || parsed.updateTaskId) {
            await handleEscalation(
              prisma, tenantId, conversationId, context.propertyId,
              '', '', 'immediate',
              parsed.updateTaskId, parsed.resolveTaskId
            );
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: 'task-update', escalationUrgency: 'immediate',
              escalationNote: '',
              taskResolved: parsed.resolveTaskId || undefined,
              taskUpdated: parsed.updateTaskId || undefined,
            });
          }
        }
      } catch {
        console.error(`[AI] [${conversationId}] JSON parse failed`);
        // T030: Escalate on JSON parse failure so manager can follow up manually
        await handleEscalation(
          prisma, tenantId, conversationId, context.propertyId,
          'ai-parse-failure',
          `AI response failed JSON parsing. Raw response snippet: ${rawResponse?.substring(0, 200)}`,
          'immediate'
        );
        broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId });
        return;
      }
    } else {
      // Image branch — find the first message with images and download
      const msgWithImage = currentMsgs.find((m: { imageUrls: string[] }) => m.imageUrls && m.imageUrls.length > 0);
      const imageUrl = msgWithImage?.imageUrls?.[0];

      let imageBase64 = '';
      let imageMimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';

      if (imageUrl) {
        try {
          const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
          imageBase64 = Buffer.from(imgRes.data as ArrayBuffer).toString('base64');
          const ct = (imgRes.headers['content-type'] || 'image/jpeg') as string;
          if (ct.includes('png')) imageMimeType = 'image/png';
          else if (ct.includes('gif')) imageMimeType = 'image/gif';
          else if (ct.includes('webp')) imageMimeType = 'image/webp';
        } catch (err) {
          console.warn(`[AI] [${conversationId}] Could not download image:`, err);
        }
      }

      const imageContent: ContentBlock[] = buildContentBlocks(personaCfg.contentBlockTemplate, templateVars);

      if (imageBase64) {
        imageContent.push({
          type: 'image',
          source: { type: 'base64', media_type: imageMimeType, data: imageBase64 },
        });
      }

      const imageSystemPrompt = injectImageHandling(effectiveSystemPrompt);

      const rawResponse = await createMessage(imageSystemPrompt, imageContent, {
        model: effectiveModel,
        temperature: effectiveTemperature,
        maxTokens: effectiveMaxTokens,
        ...(personaCfg.topK !== undefined ? { topK: personaCfg.topK } : {}),
        ...(personaCfg.topP !== undefined ? { topP: personaCfg.topP } : {}),
        ...(personaCfg.stopSequences?.length ? { stopSequences: personaCfg.stopSequences } : {}),
        agentName: effectiveAgentName,
        tenantId,
        conversationId,
        ragContext,
        openTaskCount: openTasks.length,
        totalMessages: allMsgs.length,
        memorySummarized: tenantConfig?.memorySummaryEnabled !== false && allMsgs.length > 10,
        hasImage: true,
        ragEnabled: tenantConfig?.ragEnabled !== false,
      });

      try {
        if (isInquiry) {
          const parsed = JSON.parse(stripCodeFences(rawResponse)) as {
            'guest message': string;
            manager?: { needed: boolean; title: string; note: string };
          };
          guestMessage = parsed['guest message'] || '';
          if (parsed.manager?.needed) {
            await handleEscalation(prisma, tenantId, conversationId, context.propertyId, parsed.manager.title, parsed.manager.note, 'info_request');
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.manager.title, escalationUrgency: 'info_request',
              escalationNote: parsed.manager.note,
            });
          }
        } else {
          const parsed = JSON.parse(stripCodeFences(rawResponse)) as {
            guest_message: string;
            resolveTaskId?: string | null;
            updateTaskId?: string | null;
            escalation: { title: string; note: string; urgency: string } | null;
          };
          guestMessage = parsed.guest_message || '';
          if (parsed.escalation) {
            await handleEscalation(
              prisma, tenantId, conversationId, context.propertyId,
              parsed.escalation.title, parsed.escalation.note, parsed.escalation.urgency,
              parsed.updateTaskId, parsed.resolveTaskId, ragQuery
            );
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: parsed.escalation.title, escalationUrgency: parsed.escalation.urgency,
              escalationNote: parsed.escalation.note,
              taskResolved: parsed.resolveTaskId || undefined,
              taskUpdated: parsed.updateTaskId || undefined,
            });
          } else if (parsed.resolveTaskId || parsed.updateTaskId) {
            await handleEscalation(
              prisma, tenantId, conversationId, context.propertyId,
              '', '', 'immediate',
              parsed.updateTaskId, parsed.resolveTaskId
            );
            traceEscalation({
              tenantId, conversationId, agentName: effectiveAgentName,
              escalationType: 'task-update', escalationUrgency: 'immediate',
              escalationNote: '',
              taskResolved: parsed.resolveTaskId || undefined,
              taskUpdated: parsed.updateTaskId || undefined,
            });
          }
        }
      } catch {
        console.error(`[AI] [${conversationId}] Image JSON parse failed`);
        // T030: Escalate on JSON parse failure so manager can follow up manually
        await handleEscalation(
          prisma, tenantId, conversationId, context.propertyId,
          'ai-parse-failure',
          `AI response failed JSON parsing. Raw response snippet: ${rawResponse?.substring(0, 200)}`,
          'immediate'
        );
        broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId });
        return;
      }
    }

    // T014: LLM override detection for medium-tier messages
    // When the classifier was uncertain (medium tier), check if the AI's response
    // used a different SOP than the classifier's top pick — log the override for analysis
    if (ragResult.confidenceTier === 'medium' && ragResult.topCandidates && ragResult.topCandidates.length > 0 && guestMessage) {
      try {
        const topCandidates = ragResult.topCandidates;
        const responseLower = guestMessage.toLowerCase();

        // Extract category keywords from SOP labels (e.g., 'sop-cleaning' → 'clean')
        const labelToKeywords: Record<string, string[]> = {};
        for (const candidate of topCandidates.slice(0, 3)) {
          const parts = candidate.label.replace(/^sop-/, '').split('-');
          labelToKeywords[candidate.label] = parts.map(p => p.toLowerCase());
        }

        // Detect which SOP the AI actually used by checking response keywords
        let detectedSop: string | null = null;
        let bestKeywordHits = 0;
        for (const [label, keywords] of Object.entries(labelToKeywords)) {
          const hits = keywords.filter(kw => responseLower.includes(kw)).length;
          if (hits > bestKeywordHits) {
            bestKeywordHits = hits;
            detectedSop = label;
          }
        }

        // Log override if the AI chose a different SOP than the classifier's top pick
        if (detectedSop && detectedSop !== topCandidates[0].label) {
          ragContext.llmOverride = {
            classifierPick: topCandidates[0].label,
            llmPick: detectedSop,
            confidence: topCandidates[0].confidence,
          };
          console.log(`[AI] [${conversationId}] LLM override detected: classifier=${topCandidates[0].label}(${topCandidates[0].confidence.toFixed(2)}) → llm=${detectedSop}`);
        } else if (!detectedSop) {
          ragContext.llmOverride = {
            classifierPick: topCandidates[0].label,
            llmPick: 'unknown',
            confidence: topCandidates[0].confidence,
          };
        }
      } catch (err) {
        console.warn(`[AI] [${conversationId}] LLM override detection failed (non-fatal):`, err);
      }
    }

    if (!guestMessage.trim()) {
      console.log(`[AI] [${conversationId}] Empty guest message — not sending`);
      // Clear the typing bubble on the frontend
      broadcastToTenant(tenantId, 'ai_typing_clear', { conversationId });
      return;
    }

    // Copilot mode: hold suggestion for host approval
    if (context.aiMode === 'copilot') {
      const pendingReply = await prisma.pendingAiReply.findFirst({
        where: { conversationId, fired: false },
        orderBy: { createdAt: 'desc' },
      });
      if (pendingReply) {
        await prisma.pendingAiReply.update({
          where: { id: pendingReply.id },
          data: { suggestion: guestMessage },
        });
      }
      broadcastToTenant(tenantId, 'ai_suggestion', { conversationId, suggestion: guestMessage });
      console.log(`[AI] [${conversationId}] Copilot mode — suggestion held for host approval`);
      return;
    }

    // Send via Hostaway — use the channel of the most recent GUEST message from full history
    const lastGuestMsg = allMsgs.filter(m => m.role === 'GUEST').at(-1);
    const lastMsgChannel = lastGuestMsg?.channel ?? Channel.OTHER;
    const communicationType = lastMsgChannel === Channel.WHATSAPP ? 'whatsapp' : 'channel';
    const sentAt = new Date();

    // T031: Write-ahead delivery — save to DB FIRST, then send via Hostaway
    const savedMessage = await prisma.message.create({
      data: {
        conversationId,
        tenantId,
        role: MessageRole.AI,
        content: guestMessage,
        sentAt,
        channel: lastMsgChannel,
        communicationType,
        hostawayMessageId: '',
      },
    });

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });

    // Push AI message to browser in real-time
    broadcastToTenant(tenantId, 'message', {
      conversationId,
      message: { role: 'AI', content: guestMessage, sentAt: sentAt.toISOString(), channel: String(lastMsgChannel), imageUrls: [] },
      lastMessageRole: 'AI',
      lastMessageAt: sentAt.toISOString(),
    });

    // T031: Now send via Hostaway + T033: Escalate on delivery failure
    try {
      const sendResult = await hostawayService.sendMessageToConversation(
        hostawayAccountId, hostawayApiKey, hostawayConversationId, guestMessage, communicationType
      );
      console.log(`[AI] [${conversationId}] Sent reply via Hostaway`);

      // Update DB record with Hostaway message ID if returned
      const hostawayMsgId = (sendResult as any)?.result?.id;
      if (hostawayMsgId) {
        await prisma.message.update({
          where: { id: savedMessage.id },
          data: { hostawayMessageId: String(hostawayMsgId) },
        }).catch(err => console.warn(`[AI] [${conversationId}] Failed to update hostawayMessageId:`, err));
      }
    } catch (sendErr) {
      // T033: Message is saved in DB but not delivered — escalate to manager
      console.error(`[AI] [${conversationId}] Hostaway send failed:`, sendErr);
      await handleEscalation(
        prisma, tenantId, conversationId, context.propertyId,
        'message-delivery-failure',
        `AI reply saved but Hostaway delivery failed. Error: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}. Message preview: "${guestMessage.substring(0, 150)}"`,
        'immediate'
      );
    }

    // Fire-and-forget: LLM-as-judge evaluation + self-improvement
    // NEVER awaited — runs in background after response is already sent
    if (!isInquiry) {
      // Use classifierSnap captured at line ~1242 (already cleared from global)
      if (classifierSnap) {
        evaluateAndImprove({
          tenantId,
          conversationId,
          guestMessage: ragQuery,
          classifierLabels: classifierSnap.labels,
          classifierMethod: classifierSnap.method,
          classifierTopSim: classifierSnap.topSimilarity,
          confidence: classifierSnap.confidence,
          neighbors: classifierSnap.neighbors,
          aiResponse: guestMessage,
          tier2Labels: tier2ResolvedLabels,
          tier3Reinjected,
        }, prisma).catch(err =>
          console.warn('[AI] Judge evaluation failed (non-fatal):', err)
        );
      }
    }

    console.log(`[AI] [${conversationId}] Done`);
  } catch (err) {
    console.error(`[AI] [${conversationId}] Error:`, err);
    throw err;
  }
}

export { OMAR_SYSTEM_PROMPT, OMAR_SCREENING_SYSTEM_PROMPT, MANAGER_TRANSLATOR_SYSTEM_PROMPT, createMessage, stripCodeFences, injectImageHandling, buildPropertyInfo };
export type { ContentBlock };
