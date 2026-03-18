# Claude Code Task — LLM-as-Judge + Self-Improvement Loop

## Read First
- `CLAUDE.md` (project context)
- `backend/src/services/classifier.service.ts` (the KNN classifier)
- `backend/src/services/classifier-data.ts` (training examples + SOP content)
- `backend/src/services/classifier-store.service.ts` (DB-backed examples)
- `backend/src/services/rag.service.ts` (where classifier is called)
- `backend/src/services/ai.service.ts` (where AI responses are generated)
- `backend/src/services/observability.service.ts` (Langfuse tracing)
- `backend/src/routes/knowledge.ts` (existing classifier endpoints)
- `backend/prisma/schema.prisma` (current schema)

## What We're Building

An LLM-as-judge that evaluates classifier retrieval quality after every guestCoordinator AI response, and automatically adds new training examples when the classifier wasn't confident enough. This makes the classifier self-improving in production.

## How It Works

### Trigger: After every guestCoordinator AI response

1. The classifier runs and returns `{ labels, method, topK }` — the `topK` array contains the nearest neighbor similarities.
2. The AI generates its response using whatever chunks were retrieved.
3. **After the response is sent**, a background (fire-and-forget) judge evaluation runs.

### Judge Evaluation

The judge (Claude Haiku) receives:
- The guest message
- The list of available SOP chunk IDs and their descriptions
- What the classifier actually retrieved
- The AI's response
- The classifier's confidence (nearest neighbor similarity)

The judge returns:
- `retrieval_correct: true/false`
- `correct_labels: ["sop-maintenance", "property-info"]` — what SHOULD have been retrieved
- `confidence: "high" | "medium" | "low"`
- `reasoning: "one sentence"`

### Self-Improvement Trigger

If ALL of these are true:
1. Classifier's nearest neighbor similarity was **< 0.7** (low confidence)
2. Judge says `retrieval_correct: false`
3. Judge provides `correct_labels` that differ from what was retrieved
4. The exact guest message text doesn't already exist as a training example

Then:
1. Add the **actual guest message** as a new `ClassifierExample` with the judge's `correct_labels`
2. Source: `"llm-judge"`
3. Trigger classifier re-initialization (re-embed all examples)

If nearest neighbor similarity was >= 0.7 (high confidence) but judge says retrieval was wrong:
- Log it as an evaluation but do NOT auto-add an example (might be a judge error on a confident classification)
- Flag it for human review

### Safety Guards

- **Max 10 new examples per hour per tenant** — prevents runaway loops
- **Deduplication** — never add an example if the exact text already exists
- **Never auto-correct high-confidence classifications** — only auto-fix when the classifier admits it's unsure (sim < 0.7)
- **Judge failures are silent** — if the judge API call fails, parsing fails, or returns garbage, log and move on. Never crash the AI pipeline.

---

## Schema Changes

Add to `backend/prisma/schema.prisma`:

```prisma
model ClassifierEvaluation {
  id                  String   @id @default(cuid())
  tenantId            String
  conversationId      String?
  guestMessage        String   @db.Text
  classifierLabels    String[] @default([])
  classifierMethod    String   @default("")
  classifierTopSim    Float    @default(0)
  judgeCorrectLabels  String[] @default([])
  retrievalCorrect    Boolean  @default(true)
  judgeConfidence     String   @default("high")
  judgeReasoning      String   @db.Text @default("")
  autoFixed           Boolean  @default(false)
  createdAt           DateTime @default(now())

  tenant              Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, retrievalCorrect])
  @@index([tenantId, createdAt(sort: Desc)])
  @@index([tenantId, autoFixed])
}
```

Add `classifierEvaluations ClassifierEvaluation[]` to the `Tenant` model.

Run: `npx prisma migrate dev --name add_classifier_evaluations`

---

## New Files

### File 1: `backend/src/services/judge.service.ts`

```typescript
/**
 * LLM-as-Judge for classifier retrieval evaluation.
 * Runs after every guestCoordinator AI response (fire-and-forget).
 * When classifier confidence is low AND judge finds wrong retrieval,
 * automatically adds the guest message as a new training example.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { addExample, getExampleByText } from './classifier-store.service';
import { reinitializeClassifier } from './classifier.service';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Rate limit: max auto-fixes per hour per tenant
const _fixCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_FIXES_PER_HOUR = 10;

function canAutoFix(tenantId: string): boolean {
  const now = Date.now();
  const entry = _fixCounts.get(tenantId);
  if (!entry || now > entry.resetAt) {
    _fixCounts.set(tenantId, { count: 0, resetAt: now + 3600000 });
    return true;
  }
  return entry.count < MAX_FIXES_PER_HOUR;
}

function recordAutoFix(tenantId: string): void {
  const entry = _fixCounts.get(tenantId);
  if (entry) entry.count++;
}

// All valid SOP chunk IDs the judge can recommend
const VALID_CHUNK_IDS = [
  'sop-cleaning',
  'sop-amenity-request',
  'sop-maintenance',
  'sop-wifi-doorcode',
  'sop-visitor-policy',
  'sop-early-checkin',
  'sop-late-checkout',
  'sop-escalation-info',
  'property-info',
  'property-description',
  'property-amenities',
];

const JUDGE_SYSTEM_PROMPT = `You are a retrieval quality evaluator for a hospitality AI system.

The system works like this:
- A guest sends a message
- A classifier selects which SOP (Standard Operating Procedure) documents to include in the AI's context
- The AI then responds using those documents

Your job: evaluate whether the classifier selected the RIGHT documents.

Available SOP document IDs and what they cover:
- sop-cleaning: cleaning requests, housekeeping, mopping, $20 fee
- sop-amenity-request: item requests (towels, pillows, crib, blender, etc.)
- sop-maintenance: broken items, leaks, AC, electrical, plumbing, pests, mold
- sop-wifi-doorcode: WiFi password, WiFi name, door code, internet connection issues
- sop-visitor-policy: visitors, friends coming over, family visits, passport verification
- sop-early-checkin: early check-in, arriving before 3pm, bag drop
- sop-late-checkout: late checkout, leaving after 11am, extending stay
- sop-escalation-info: restaurant recommendations, local info, refunds, discounts, reservation changes
- property-info: address, floor, bedrooms, check-in/out times, door code, WiFi credentials
- property-description: building features, pool, gym, parking
- property-amenities: list of available items and appliances

Messages that are just acknowledgments ("ok", "thanks", "sure", "got it", "👍") or contextual follow-ups ("5am", "tomorrow works") should get NO documents at all — return empty correct_labels.

Messages about house rules, smoking, parties, noise, scheduling/working hours, or emergencies (gas leak, safety threats, wanting to speak to manager) are handled by the system prompt and should also get NO documents — return empty correct_labels.

Return ONLY raw JSON, no markdown, no explanation outside the JSON:
{"retrieval_correct":true,"correct_labels":[],"confidence":"high","reasoning":"one sentence"}`;

export interface JudgeInput {
  tenantId: string;
  conversationId: string;
  guestMessage: string;
  classifierLabels: string[];
  classifierMethod: string;
  classifierTopSim: number;
  aiResponse: string;
}

export interface JudgeResult {
  retrievalCorrect: boolean;
  correctLabels: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Run LLM-as-judge evaluation and handle self-improvement.
 * FIRE AND FORGET — call without await. Never blocks the AI pipeline.
 */
export async function evaluateAndImprove(input: JudgeInput, prisma: PrismaClient): Promise<void> {
  try {
    // Step 1: Call the judge
    const judgeResult = await callJudge(input);
    if (!judgeResult) return; // Judge failed, silently bail

    // Step 2: Save evaluation to DB
    await prisma.classifierEvaluation.create({
      data: {
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        guestMessage: input.guestMessage,
        classifierLabels: input.classifierLabels,
        classifierMethod: input.classifierMethod,
        classifierTopSim: input.classifierTopSim,
        judgeCorrectLabels: judgeResult.correctLabels,
        retrievalCorrect: judgeResult.retrievalCorrect,
        judgeConfidence: judgeResult.confidence,
        judgeReasoning: judgeResult.reasoning,
        autoFixed: false,
      },
    }).catch(err => console.warn('[Judge] Failed to save evaluation:', err));

    // Step 3: Decide whether to auto-fix
    if (
      !judgeResult.retrievalCorrect &&
      input.classifierTopSim < 0.7 &&
      canAutoFix(input.tenantId)
    ) {
      // Verify the labels are valid
      const validLabels = judgeResult.correctLabels.filter(l => VALID_CHUNK_IDS.includes(l));

      // Check for duplicate
      const existing = await getExampleByText(input.tenantId, input.guestMessage, prisma);
      if (existing) {
        console.log(`[Judge] Example already exists for: "${input.guestMessage.substring(0, 50)}"`);
        return;
      }

      // Add the actual guest message as a new training example
      await addExample(input.tenantId, input.guestMessage, validLabels, 'llm-judge', prisma);
      recordAutoFix(input.tenantId);

      // Mark evaluation as auto-fixed
      // (We don't have the eval ID here easily, so update by matching)
      await prisma.classifierEvaluation.updateMany({
        where: {
          tenantId: input.tenantId,
          guestMessage: input.guestMessage,
          autoFixed: false,
        },
        data: { autoFixed: true },
      }).catch(() => {});

      // Re-initialize the classifier with the new example
      await reinitializeClassifier(input.tenantId, prisma);

      console.log(`[Judge] Self-improvement: added "${input.guestMessage.substring(0, 50)}" → [${validLabels.join(', ')}]`);
    } else if (!judgeResult.retrievalCorrect && input.classifierTopSim >= 0.7) {
      console.log(`[Judge] High-confidence misclassification (sim=${input.classifierTopSim.toFixed(2)}), flagged for review: "${input.guestMessage.substring(0, 50)}"`);
    }
  } catch (err) {
    console.warn('[Judge] evaluateAndImprove failed (non-fatal):', err);
  }
}

async function callJudge(input: JudgeInput): Promise<JudgeResult | null> {
  try {
    const userMessage = `GUEST MESSAGE: "${input.guestMessage}"
CLASSIFIER RETRIEVED: [${input.classifierLabels.join(', ') || 'nothing'}]
CLASSIFIER CONFIDENCE: ${input.classifierTopSim.toFixed(3)} (nearest neighbor similarity)
CLASSIFIER METHOD: ${input.classifierMethod}
AI RESPONSE: "${input.aiResponse.substring(0, 500)}"

Was the retrieval correct? If not, what should have been retrieved?`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      temperature: 0,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';

    // Parse JSON — strip markdown fences if present
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate and normalize
    const result: JudgeResult = {
      retrievalCorrect: parsed.retrieval_correct === true,
      correctLabels: Array.isArray(parsed.correct_labels)
        ? parsed.correct_labels.filter((l: string) => typeof l === 'string')
        : [],
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };

    return result;
  } catch (err) {
    console.warn('[Judge] callJudge failed:', err);
    return null;
  }
}
```

---

## Modified Files

### Modify: `backend/src/services/classifier.service.ts`

Two changes needed:

**1. Export the top similarity score from `classifyMessage()`**

The return type already includes `topK` which has similarities. But we need to make it easy to get the top similarity. Add a convenience field:

In the `classifyMessage()` return, add `topSimilarity`:

```typescript
const topSimilarity = topK.length > 0 ? topK[0].similarity : 0;

return { labels, method: 'knn_vote', topK: topKDetails, tokensUsed, topSimilarity };
```

Also add `topSimilarity: number` to the return type.

Do the same for the contextual_match return:
```typescript
return { labels: [], method: 'contextual_match', topK: topKDetails, tokensUsed: 0, topSimilarity: topK.length > 0 ? topK[0].similarity : 0 };
```

And for error returns:
```typescript
return { labels: [], method: 'classifier_not_initialized', topK: [], tokensUsed: 0, topSimilarity: 0 };
return { labels: [], method: 'embedding_failed', topK: [], tokensUsed: 0, topSimilarity: 0 };
```

**2. Add `reinitializeClassifier()`**

```typescript
/**
 * Force reload: clear cached embeddings, reload from DB, re-embed.
 * Called after new training examples are added by the judge.
 */
export async function reinitializeClassifier(tenantId: string, prisma: PrismaClient): Promise<void> {
  // Import here to avoid circular dependency
  const { getActiveExamples } = await import('./classifier-store.service');

  const startMs = Date.now();
  try {
    const dbExamples = await getActiveExamples(tenantId, prisma);
    if (dbExamples.length === 0) {
      console.warn('[Classifier] No examples found for reinit');
      return;
    }

    _examples = dbExamples.map(ex => ({
      text: ex.text,
      labels: ex.labels.filter(l => !BAKED_IN_CHUNKS.has(l)),
    }));

    const texts = _examples.map(e => e.text);
    _exampleEmbeddings = await embedBatch(texts);

    _initDurationMs = Date.now() - startMs;
    _initialized = true;
    console.log(`[Classifier] Re-initialized: ${_examples.length} examples, ${_initDurationMs}ms`);
  } catch (err) {
    console.error('[Classifier] Re-initialization failed:', err);
  }
}
```

Make sure to add `PrismaClient` import at the top if not already present:
```typescript
import { PrismaClient } from '@prisma/client';
```

### Modify: `backend/src/services/classifier-store.service.ts`

Add this new function:

```typescript
export async function getExampleByText(
  tenantId: string,
  text: string,
  prisma: PrismaClient
): Promise<{ id: string; text: string; labels: string[] } | null> {
  const existing = await prisma.classifierExample.findFirst({
    where: { tenantId, text, active: true },
    select: { id: true, text: true, labels: true },
  });
  return existing;
}
```

### Modify: `backend/src/services/rag.service.ts`

In the `retrieveRelevantKnowledge()` function, where the classifier is called for guestCoordinator, capture the `topSimilarity` and pass it along.

Find the section where `classifyMessage` is called and update it to capture the full result:

```typescript
const classifierResult = await classifyMessage(query);
```

The `classifierResult` already has `topSimilarity` after the change above. Store it so we can pass it to the judge later. The easiest way: attach it to the return value or pass it via a different channel.

**Best approach**: Return the classifier metadata alongside the chunks. Add an optional output parameter or return it in a wrapper.

Actually, the cleanest approach is to have `retrieveRelevantKnowledge` return extra metadata. Add to its return type:

```typescript
// Change the return to include classifier metadata
export async function retrieveRelevantKnowledge(
  ...existing params...
): Promise<{
  chunks: Array<{ content: string; category: string; similarity: number; sourceKey: string; propertyId: string | null }>;
  classifierMeta?: {
    method: string;
    labels: string[];
    topSimilarity: number;
  };
}>
```

BUT — this is a big signature change that touches `ai.service.ts` everywhere. Simpler approach:

**Use a module-level variable to stash the last classifier result:**

In `rag.service.ts`, add at the top:

```typescript
// Last classifier result — used by judge service for evaluation
let _lastClassifierResult: { method: string; labels: string[]; topSimilarity: number } | null = null;

export function getLastClassifierResult() {
  return _lastClassifierResult;
}
```

Then in the classifier code path:
```typescript
const classifierResult = await classifyMessage(query);
_lastClassifierResult = {
  method: classifierResult.method,
  labels: classifierResult.labels,
  topSimilarity: classifierResult.topSimilarity,
};
```

### Modify: `backend/src/services/ai.service.ts`

After the AI response is sent successfully (after the `broadcastToTenant` call at the end of `generateAndSendAiReply()`), add the judge evaluation:

```typescript
// Import at top of file
import { evaluateAndImprove } from './judge.service';
import { getLastClassifierResult } from './rag.service';
```

Then after the AI message is sent and saved, add:

```typescript
// Fire-and-forget: LLM-as-judge evaluation + self-improvement
if (!isInquiry) {
  const classifierMeta = getLastClassifierResult();
  if (classifierMeta) {
    evaluateAndImprove({
      tenantId,
      conversationId,
      guestMessage: ragQuery,
      classifierLabels: classifierMeta.labels,
      classifierMethod: classifierMeta.method,
      classifierTopSim: classifierMeta.topSimilarity,
      aiResponse: guestMessage,
    }, prisma).catch(err =>
      console.warn('[AI] Judge evaluation failed (non-fatal):', err)
    );
  }
}
```

Place this AFTER the message is sent to Hostaway and saved to DB — it must never delay the response.

### Modify: `backend/src/routes/knowledge.ts`

Add these endpoints:

```typescript
// GET /api/knowledge/evaluations — paginated evaluation log
router.get('/evaluations', async (req: any, res) => {
  try {
    const tenantId = req.tenantId as string;
    const { limit: limitStr, offset: offsetStr, correct } = req.query as Record<string, string | undefined>;
    const limit = Math.min(parseInt(limitStr || '50', 10), 200);
    const offset = parseInt(offsetStr || '0', 10);

    const where: Record<string, unknown> = { tenantId };
    if (correct === 'true') where.retrievalCorrect = true;
    if (correct === 'false') where.retrievalCorrect = false;

    const [evals, total] = await Promise.all([
      prisma.classifierEvaluation.findMany({
        where: where as any,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.classifierEvaluation.count({ where: where as any }),
    ]);

    res.json({ evaluations: evals, total, limit, offset });
  } catch (err) {
    console.error('[Knowledge] evaluations query failed:', err);
    res.status(500).json({ error: 'Failed to fetch evaluations' });
  }
});

// GET /api/knowledge/evaluation-stats — aggregate metrics
router.get('/evaluation-stats', async (req: any, res) => {
  try {
    const tenantId = req.tenantId as string;

    const [total, correct, incorrect, autoFixed] = await Promise.all([
      prisma.classifierEvaluation.count({ where: { tenantId } }),
      prisma.classifierEvaluation.count({ where: { tenantId, retrievalCorrect: true } }),
      prisma.classifierEvaluation.count({ where: { tenantId, retrievalCorrect: false } }),
      prisma.classifierEvaluation.count({ where: { tenantId, autoFixed: true } }),
    ]);

    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 100;

    res.json({
      total,
      correct,
      incorrect,
      autoFixed,
      accuracyPercent: accuracy,
    });
  } catch (err) {
    console.error('[Knowledge] evaluation-stats failed:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});
```

### Modify: `backend/prisma/schema.prisma`

Add the ClassifierEvaluation model (shown above) and add `classifierEvaluations ClassifierEvaluation[]` to the Tenant model.

---

## Execution Order

```
1. Add ClassifierEvaluation model to schema.prisma + relation on Tenant
2. Run: npx prisma migrate dev --name add_classifier_evaluations
3. Run: npx prisma generate
4. Create backend/src/services/judge.service.ts
5. Modify backend/src/services/classifier.service.ts (add topSimilarity + reinitializeClassifier)
6. Modify backend/src/services/classifier-store.service.ts (add getExampleByText)
7. Modify backend/src/services/rag.service.ts (stash last classifier result)
8. Modify backend/src/services/ai.service.ts (fire-and-forget judge call)
9. Modify backend/src/routes/knowledge.ts (evaluation endpoints)
10. npm run build — fix all TypeScript errors
11. Test locally or deploy
```

## What NOT to Touch
- ❌ Frontend — no frontend changes
- ❌ screeningAI code path — judge only runs for guestCoordinator
- ❌ The response pipeline timing — judge is ALWAYS fire-and-forget, never awaited
- ❌ classifier-data.ts hardcoded examples — they're still the seed, but runtime uses DB

## Verification After Deploy

```bash
# Check evaluation stats (should start at 0)
curl -H "Authorization: Bearer $TOKEN" "$BACKEND/api/knowledge/evaluation-stats"

# Send a test guest message through the system, wait for AI to respond
# Then check evaluations
curl -H "Authorization: Bearer $TOKEN" "$BACKEND/api/knowledge/evaluations?limit=5"

# Check classifier example count (should grow over time)
curl -H "Authorization: Bearer $TOKEN" "$BACKEND/api/knowledge/classifier-status"

# Check if any self-improvements happened
curl -H "Authorization: Bearer $TOKEN" "$BACKEND/api/knowledge/evaluations?correct=false"
```

## Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Anthropic API down | Judge call fails silently, AI response already sent, no self-improvement |
| Judge returns invalid JSON | Caught in try/catch, logged, evaluation not saved |
| Rate limit hit (10/hour) | New evaluations still logged, just no auto-fix |
| Classifier reinit fails | Old examples still in memory, next init will pick up new ones |
| DB write fails | Judge result lost, AI response unaffected |
