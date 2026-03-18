# Claude Code Task — Classifier Dashboard Frontend

## Read First
- `frontend/components/inbox-v5.tsx` (see how nav tabs work — the `navTab` state and tab strip)
- `frontend/components/ai-logs-v5.tsx` (reference for design tokens, card patterns, animation style)
- `frontend/components/configure-ai-v5.tsx` (reference for form patterns, section cards)
- `frontend/lib/api.ts` (existing API functions — you'll add new ones here)

## What We're Building

A new "Classifier" tab in the main nav bar (between "Configure AI" and "AI Logs") that shows:

1. **Stats bar** — total evaluations, accuracy %, auto-fixed count, training examples count
2. **Live test** — type a message, see what the classifier returns in real time
3. **Evaluation log** — every judge evaluation, filterable by correct/incorrect/auto-fixed
4. **Training examples** — browse all examples, see source (seed vs llm-judge vs manual), add new ones manually

## Design Rules

Match the existing design system exactly. Look at `ai-logs-v5.tsx` and `configure-ai-v5.tsx` for:
- Design tokens `T` object (colors, fonts, shadows, border radius)
- Card patterns with section headers
- Animation keyframes (fadeInUp, scaleIn)
- Font imports (Plus Jakarta Sans, JetBrains Mono)
- Hover states, focus states, transitions
- No Tailwind — all inline styles using the `T` tokens

## API Functions to Add

Add these to `frontend/lib/api.ts`:

```typescript
// Classifier status
export async function apiGetClassifierStatus(): Promise<{
  initialized: boolean;
  exampleCount: number;
  initDurationMs: number;
  sopChunkCount: number;
  bakedInCount: number;
}> {
  return apiFetch('/api/knowledge/classifier-status');
}

// Test classify a message
export async function apiTestClassify(message: string): Promise<{
  labels: string[];
  method: string;
  topK: Array<{ index: number; similarity: number; text: string; labels: string[] }>;
  tokensUsed: number;
  topSimilarity: number;
}> {
  return apiFetch('/api/knowledge/test-classify', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

// Evaluation stats
export async function apiGetEvaluationStats(): Promise<{
  total: number;
  correct: number;
  incorrect: number;
  autoFixed: number;
  accuracyPercent: number;
}> {
  return apiFetch('/api/knowledge/evaluation-stats');
}

// Evaluation log (paginated)
export interface ClassifierEvaluation {
  id: string;
  tenantId: string;
  conversationId: string | null;
  guestMessage: string;
  classifierLabels: string[];
  classifierMethod: string;
  classifierTopSim: number;
  judgeCorrectLabels: string[];
  retrievalCorrect: boolean;
  judgeConfidence: string;
  judgeReasoning: string;
  autoFixed: boolean;
  createdAt: string;
}

export async function apiGetEvaluations(params?: {
  limit?: number;
  offset?: number;
  correct?: boolean;
}): Promise<{
  evaluations: ClassifierEvaluation[];
  total: number;
  limit: number;
  offset: number;
}> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.correct !== undefined) qs.set('correct', String(params.correct));
  const qsStr = qs.toString();
  return apiFetch(`/api/knowledge/evaluations${qsStr ? '?' + qsStr : ''}`);
}

// Classifier examples
export interface ClassifierExampleItem {
  id: string;
  text: string;
  labels: string[];
  source: string;
  active: boolean;
  createdAt: string;
}

export async function apiGetClassifierExamples(params?: {
  limit?: number;
  offset?: number;
  source?: string;
}): Promise<{
  examples: ClassifierExampleItem[];
  total: number;
}> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.source) qs.set('source', params.source);
  const qsStr = qs.toString();
  return apiFetch(`/api/knowledge/classifier-examples${qsStr ? '?' + qsStr : ''}`);
}

export async function apiAddClassifierExample(data: {
  text: string;
  labels: string[];
}): Promise<{ ok: boolean }> {
  return apiFetch('/api/knowledge/classifier-examples', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function apiDeleteClassifierExample(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/knowledge/classifier-examples/${id}`, { method: 'DELETE' });
}

export async function apiReinitializeClassifier(): Promise<{ ok: boolean; exampleCount: number }> {
  return apiFetch('/api/knowledge/classifier-reinitialize', { method: 'POST' });
}
```

## New Component: `frontend/components/classifier-v5.tsx`

Create a single component file with 4 sections. Here's the structure:

```
ClassifierV5 (main export)
├── StatsBar (4 metric cards across the top)
├── LiveTestSection (type message → see classifier result)
├── EvaluationLog (paginated table of judge evaluations)
└── TrainingExamples (browse/add/delete examples)
```

### Section 1: Stats Bar

4 cards in a row:

| Card | Label | Value | Source |
|------|-------|-------|--------|
| 1 | Training Examples | `{exampleCount}` | classifier-status endpoint |
| 2 | Evaluations | `{total}` | evaluation-stats endpoint |
| 3 | Retrieval Accuracy | `{accuracyPercent}%` | evaluation-stats endpoint |
| 4 | Auto-Fixed | `{autoFixed}` | evaluation-stats endpoint |

Use the same `MetricCard` pattern from `ai-logs-v5.tsx`. Poll every 30 seconds to update.

### Section 2: Live Test

A card with:
- Text input: "Type a guest message to test..."
- "Classify" button
- Results panel (shown after classification):
  - Labels returned (as colored pills)
  - Method used (knn_vote, contextual_match, etc.)
  - Top similarity score (with color: green >0.8, amber 0.6-0.8, red <0.6)
  - Top 3 nearest neighbors (text + similarity + their labels)
  - Tokens used

This is the most important section — it lets you verify the classifier is doing the right thing.

### Section 3: Evaluation Log

A card with:
- Filter pills: All | Correct | Incorrect | Auto-Fixed
- Paginated table/list showing each evaluation:
  - Guest message (truncated)
  - What classifier returned (label pills)
  - What judge said should be returned (label pills, if different)
  - Retrieval correct: ✅ or ❌
  - Auto-fixed: 🔧 badge if true
  - Judge reasoning (expandable)
  - Top similarity score
  - Timestamp
- Click to expand → see full details

Color coding:
- Green row tint if retrieval_correct = true
- Red row tint if retrieval_correct = false
- Blue 🔧 badge if auto-fixed

### Section 4: Training Examples

A card with:
- Count display: "164 seed + 3 llm-judge + 0 manual = 167 total"
- Source filter pills: All | Seed | LLM Judge | Manual
- Search input (filter by text)
- List of examples:
  - Text (the guest message)
  - Labels (as colored pills)
  - Source badge (seed = gray, llm-judge = blue, manual = green)
  - Date added
  - Delete button (with confirmation)
- "Add Example" form at the bottom:
  - Text input
  - Label selector (checkboxes for each valid SOP chunk ID)
  - "Add" button
- "Reinitialize Classifier" button (triggers re-embed of all examples)

### Label Pill Colors

Use consistent colors for SOP chunk labels across all sections:

```typescript
const LABEL_COLORS: Record<string, string> = {
  'sop-cleaning': '#15803D',      // green
  'sop-amenity-request': '#0891B2', // cyan
  'sop-maintenance': '#DC2626',    // red
  'sop-wifi-doorcode': '#7C3AED',  // purple
  'sop-visitor-policy': '#D97706', // amber
  'sop-early-checkin': '#1D4ED8',  // blue
  'sop-late-checkout': '#2563EB',  // blue lighter
  'sop-escalation-info': '#DB2777', // pink
  'property-info': '#57534E',      // gray
  'property-description': '#78716C', // gray lighter
  'property-amenities': '#44403C', // gray dark
};
```

## Modify: `frontend/components/inbox-v5.tsx`

Add the new tab to the nav bar. Find the nav tab array and add:

```typescript
{ id: 'classifier', label: 'Classifier' },
```

Add it between 'configure' and 'logs'.

Add the import:
```typescript
import { ClassifierV5 } from '@/components/classifier-v5'
```

Add the render case at the bottom with the other tab renders:
```typescript
{navTab === 'classifier' && (
  <div style={{ flex: 1, overflow: 'hidden' }}>
    <ClassifierV5 />
  </div>
)}
```

## Execution Order

```
1. Add API functions to frontend/lib/api.ts
2. Create frontend/components/classifier-v5.tsx
3. Modify frontend/components/inbox-v5.tsx (add nav tab + render)
4. Verify the page renders with no errors
5. No backend changes needed — all endpoints already exist
```

## What NOT to Touch
- ❌ Backend — no backend changes
- ❌ Other frontend components (don't modify analytics, settings, etc.)
- ❌ Don't use localStorage or sessionStorage (not supported in Claude artifacts)
- ❌ Don't use any external charting library beyond what's already imported (recharts is available)

## IMPORTANT: Endpoint Verification

Before building the frontend, verify these endpoints exist in the backend by checking `backend/src/routes/knowledge.ts`:
- GET `/api/knowledge/classifier-status`
- POST `/api/knowledge/test-classify`
- GET `/api/knowledge/evaluation-stats`
- GET `/api/knowledge/evaluations`
- GET `/api/knowledge/classifier-examples`
- POST `/api/knowledge/classifier-examples`
- DELETE `/api/knowledge/classifier-examples/:id`
- POST `/api/knowledge/classifier-reinitialize`

If any are missing, create them following the patterns in the existing knowledge routes. The handler logic:
- `classifier-examples` GET: query ClassifierExample with tenantId, paginate, support source filter
- `classifier-examples` POST: create new ClassifierExample with tenantId, text, labels, source="manual"
- `classifier-examples/:id` DELETE: set active=false (soft delete) on the ClassifierExample
- `classifier-reinitialize` POST: call `reinitializeClassifier(tenantId, prisma)` from classifier.service.ts
