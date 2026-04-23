/**
 * BullMQ queue for debounced AI replies.
 * Preserves the existing debounce behavior: each new guest message removes
 * and re-adds the job, resetting the delay timer. The LAST message fires.
 * Gracefully disabled when REDIS_URL is missing — falls back to poll.
 */
import { Queue } from 'bullmq';

let _queue: Queue | null = null;
let _warned = false;
let _initialized = false;

function initQueue(): Queue | null {
  if (_initialized) return _queue;
  _initialized = true;

  const { REDIS_URL } = process.env;
  if (!REDIS_URL) {
    if (!_warned) {
      console.warn('[Queue] REDIS_URL missing — BullMQ disabled, falling back to 30s poll');
      _warned = true;
    }
    return null;
  }
  try {
    // Pass URL string directly — avoids ioredis version conflicts with bullmq's bundled ioredis
    _queue = new Queue('ai-replies', {
      connection: { url: REDIS_URL, maxRetriesPerRequest: null } as any,
    });
    console.log('[Queue] BullMQ connected to Redis');
    return _queue;
  } catch (err) {
    console.warn('[Queue] Failed to connect to Redis (non-fatal):', err);
    return null;
  }
}

export async function addAiReplyJob(
  conversationId: string,
  tenantId: string,
  delayMs: number
): Promise<void> {
  const q = initQueue();
  if (!q) return;
  try {
    // Remove existing job for this conversation (debounce reset)
    const existing = await q.getJob(conversationId);
    if (existing) {
      await existing.remove();
    }
    await q.add(
      'process-reply',
      { conversationId, tenantId },
      {
        jobId: conversationId,
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        // Bugfix (2026-04-23): was missing `removeOnFail`, so jobs that
        // exhausted their 3 retries lingered in the BullMQ "failed" set
        // indefinitely — slow memory creep on the Redis instance and
        // no natural GC. Keep failures for 2h (audit / inspection via
        // BullBoard) then drop. Matches the cleanup cadence of other
        // transient logs.
        removeOnFail: { age: 2 * 60 * 60 },
      }
    );
  } catch (err) {
    console.warn(`[Queue] Failed to add job for ${conversationId} (non-fatal):`, err);
  }
}

export async function removeAiReplyJob(conversationId: string): Promise<void> {
  const q = initQueue();
  if (!q) return;
  try {
    const existing = await q.getJob(conversationId);
    if (existing) await existing.remove();
  } catch (err) {
    console.warn(`[Queue] Failed to remove job for ${conversationId} (non-fatal):`, err);
  }
}

export async function closeQueue(): Promise<void> {
  try {
    if (_queue) await _queue.close();
  } catch (err) {
    console.warn('[Queue] Error during shutdown (non-fatal):', err);
  }
}
