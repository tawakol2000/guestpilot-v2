/**
 * Feature 041 sprint 02 — Idempotency guard for trigger-driven diagnostics.
 *
 * Sprint brief §5: "All four triggers must be idempotent-safe: if the same
 * trigger fires twice within 60 seconds for the same messageId, the second
 * invocation is a no-op."
 *
 * Implementation: in-memory Set keyed by `${triggerType}:${messageId}` with a
 * 60s TTL. Each process instance has its own dedup window — that's OK. The
 * same fire-and-forget diagnostic running twice from two instances is a
 * tolerable waste; the bad outcome we want to prevent is double-clicks from
 * the same browser tab or webhook retries within seconds, both of which hit
 * a single backend instance in practice. A DB-backed dedup would add cost
 * without meaningfully improving the multi-instance scenario because the
 * diagnostic itself is fire-and-forget.
 */

const DEDUP_WINDOW_MS = 60 * 1000;

interface Entry {
  expiresAt: number;
}

const registry = new Map<string, Entry>();

/**
 * Returns true the first time it is called with a given key in a 60s window,
 * false for subsequent calls. The caller should skip the downstream work
 * when this returns false.
 */
export function shouldProcessTrigger(triggerType: string, messageId: string | null | undefined): boolean {
  if (!messageId) return true; // No dedup key — let it through.
  const key = `${triggerType}:${messageId}`;
  const now = Date.now();

  // Sweep any expired entries lazily to keep the map bounded on idle.
  if (registry.size > 200) {
    for (const [k, v] of registry.entries()) {
      if (v.expiresAt <= now) registry.delete(k);
    }
  }

  const existing = registry.get(key);
  if (existing && existing.expiresAt > now) {
    return false;
  }
  registry.set(key, { expiresAt: now + DEDUP_WINDOW_MS });
  return true;
}

/** Exposed for tests. */
export function _resetDedupForTests(): void {
  registry.clear();
}
