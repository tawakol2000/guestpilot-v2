/**
 * Task Manager Agent — Lightweight post-processor for escalation deduplication.
 *
 * Fires ONLY when Omar generates an escalation. Compares the new escalation against
 * open tasks for the same conversation and decides: CREATE / UPDATE / RESOLVE / SKIP.
 *
 * Cost: ~$0.00005/call (200 tokens in, 30 out)
 * Latency: <500ms
 * Fallback: On any error → CREATE (never lose an escalation)
 */

import OpenAI from 'openai';

// Lazy OpenAI client (same pattern as intent-extractor.service.ts)
let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!_client) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      console.warn('[TaskManager] No OPENAI_API_KEY — task dedup disabled');
      return null;
    }
    _client = new OpenAI({ apiKey: key });
  }
  return _client;
}

const SYSTEM_PROMPT = `You are a task deduplication assistant. You receive an escalation that an AI guest coordinator wants to create, plus any existing open tasks for the same conversation.

Your job: decide if this escalation should CREATE a new task, UPDATE an existing task with new details, RESOLVE an existing task, or be SKIPPED as redundant.

Rules:
- UPDATE when the new escalation is a follow-up to an existing open task (e.g., confirming a time, adding details, changing a request). The topic must be the same.
- RESOLVE when the guest indicates the issue in an existing task is no longer needed or is fixed.
- SKIP when the new escalation adds no new information to an existing task (e.g., repeating what was already captured).
- CREATE when the escalation is about a genuinely new topic not covered by any open task.

When in doubt between UPDATE and CREATE, prefer UPDATE — it's better to keep one well-documented task than create duplicates.

Additional dedup rules:
- If the new escalation title shares 2+ words (split on hyphens) with an existing task's title, this is almost certainly a duplicate. Prefer UPDATE over CREATE.
- If the same guest has sent multiple messages about the same topic in rapid succession, strongly prefer UPDATE over CREATE.
- When consolidating rapid-fire messages, summarize ALL new information in one paragraph. Do not repeat what's in the existing task.

Return ONLY a single JSON line. No explanation outside the JSON.`;

// Stats tracking
let _callCount = 0;
let _createCount = 0;
let _updateCount = 0;
let _resolveCount = 0;
let _skipCount = 0;
let _errorCount = 0;
let _totalDurationMs = 0;

export interface TaskManagerInput {
  tenantId: string;
  conversationId: string;
  newEscalation: { title: string; note: string; urgency: string };
  openTasks: Array<{
    id: string;
    title: string;
    note: string | null;
    urgency: string;
    createdAt: Date;
  }>;
  guestMessage: string;
}

export interface TaskManagerResult {
  action: 'create' | 'update' | 'resolve' | 'skip';
  taskId?: string;
  reason: string;
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export async function evaluateEscalation(input: TaskManagerInput): Promise<TaskManagerResult> {
  _callCount++;

  // Fast path: no open tasks → always create (no API call needed)
  if (input.openTasks.length === 0) {
    _createCount++;
    return { action: 'create', reason: 'no-open-tasks' };
  }

  const client = getClient();
  if (!client) {
    _createCount++;
    return { action: 'create', reason: 'task-manager-disabled' };
  }

  const startMs = Date.now();

  try {
    // Format open tasks
    const tasksFormatted = input.openTasks
      .map(t => {
        const note = t.note ? t.note.substring(0, 300) : 'No details';
        return `[${t.id}] ${t.title} (${t.urgency})\n  Note: ${note}\n  Created: ${formatRelativeTime(t.createdAt)}`;
      })
      .join('\n\n');

    const userMessage = `OPEN TASKS:\n${tasksFormatted}\n\nNEW ESCALATION:\nTitle: ${input.newEscalation.title}\nNote: ${input.newEscalation.note}\nUrgency: ${input.newEscalation.urgency}\n\nGUEST MESSAGE: "${input.guestMessage}"\n\nReturn: {"action":"create|update|resolve|skip","taskId":"id-if-applicable","reason":"brief-reason"}`;

    const response = await (client.responses as any).create({
      model: 'gpt-5.4-nano-2026-03-17',
      max_output_tokens: 256,
      temperature: 0,
      instructions: SYSTEM_PROMPT,
      input: userMessage,
      reasoning: { effort: 'none' },
      store: true,
    });

    const text = response.output_text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[TaskManager] No JSON in response: ${text.substring(0, 100)}`);
      _errorCount++;
      _createCount++;
      return { action: 'create', reason: 'task-manager-parse-error' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const action = ['create', 'update', 'resolve', 'skip'].includes(parsed.action)
      ? parsed.action as TaskManagerResult['action']
      : 'create';
    const taskId = parsed.taskId || undefined;
    const reason = parsed.reason || 'no-reason';

    const durationMs = Date.now() - startMs;
    _totalDurationMs += durationMs;

    // Update stats
    switch (action) {
      case 'create': _createCount++; break;
      case 'update': _updateCount++; break;
      case 'resolve': _resolveCount++; break;
      case 'skip': _skipCount++; break;
    }

    console.log(`[TaskManager] Decision: ${action}${taskId ? ` → ${taskId}` : ''} (${reason}) [${durationMs}ms]`);
    return { action, taskId, reason };
  } catch (err: any) {
    _errorCount++;
    _createCount++;
    const durationMs = Date.now() - startMs;
    _totalDurationMs += durationMs;
    console.warn(`[TaskManager] Failed (non-fatal, fallback to create): ${err.message}`);
    return { action: 'create', reason: 'task-manager-error' };
  }
}

export function getTaskManagerStats() {
  return {
    calls: _callCount,
    creates: _createCount,
    updates: _updateCount,
    resolves: _resolveCount,
    skips: _skipCount,
    errors: _errorCount,
    avgDurationMs: _callCount > 0 ? Math.round(_totalDurationMs / _callCount) : 0,
  };
}
