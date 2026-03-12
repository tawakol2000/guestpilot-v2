/**
 * In-memory import progress store.
 * Keyed by tenantId so the frontend can poll for its own job.
 */

export type ImportPhase = 'idle' | 'deleting' | 'listings' | 'reservations' | 'messages' | 'done' | 'error'

export interface ImportProgress {
  phase: ImportPhase
  total: number
  completed: number
  message: string
  error?: string
  lastSyncedAt?: string
}

const store = new Map<string, ImportProgress>()

export function getProgress(tenantId: string): ImportProgress {
  return store.get(tenantId) ?? { phase: 'idle', total: 0, completed: 0, message: '' }
}

export function setProgress(tenantId: string, progress: Partial<ImportProgress>) {
  const current = getProgress(tenantId)
  store.set(tenantId, { ...current, ...progress })
}

export function resetProgress(tenantId: string) {
  store.set(tenantId, { phase: 'idle', total: 0, completed: 0, message: '' })
}
