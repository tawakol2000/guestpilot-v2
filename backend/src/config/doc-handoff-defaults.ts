/**
 * Feature 044: Check-in Document Handoff via WhatsApp
 * Seeded defaults and shared constants for doc-handoff scheduling + WAsender send.
 * See specs/044-doc-handoff-whatsapp/plan.md.
 */

export const DEFAULT_REMINDER_TIME = '22:00';
export const DEFAULT_HANDOFF_TIME = '10:00';

// Matches existing codebase convention (ai.service.ts:1559, ai-config.controller.ts:302, sandbox.ts:160).
// Promote to per-tenant setting if/when a non-Cairo tenant appears.
export const DOC_HANDOFF_TIMEZONE = 'Africa/Cairo';

// Polling interval for the docHandoff.job.ts tick. Matches the cadence decided in research.md.
export const DOC_HANDOFF_TICK_MS = 2 * 60_000;

// Retry policy for transient provider failures.
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [5 * 60_000, 15 * 60_000]; // 5 min, 15 min after attempts 1 and 2

// Validation patterns (application-level — DB accepts any String).
export const PHONE_REGEX = /^\+[1-9]\d{7,14}$/;
export const GROUP_JID_MARKER = '@g.us';
export const TIME_REGEX = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isValidRecipient(value: string | null | undefined): boolean {
  if (!value) return false;
  if (value.includes(GROUP_JID_MARKER)) return true;
  return PHONE_REGEX.test(value);
}

export function isValidTime(value: string | null | undefined): boolean {
  if (!value) return false;
  return TIME_REGEX.test(value);
}

// Message type string constants (avoid a Prisma enum so SKIPPED_* can grow without migration — see data-model.md).
export const MESSAGE_TYPE_REMINDER = 'REMINDER';
export const MESSAGE_TYPE_HANDOFF = 'HANDOFF';

export const STATUS_SCHEDULED = 'SCHEDULED';
export const STATUS_DEFERRED = 'DEFERRED';
export const STATUS_SENT = 'SENT';
export const STATUS_FAILED = 'FAILED';
export const STATUS_SKIPPED_CANCELLED = 'SKIPPED_CANCELLED';
export const STATUS_SKIPPED_NO_RECIPIENT = 'SKIPPED_NO_RECIPIENT';
export const STATUS_SKIPPED_NO_CHECKLIST = 'SKIPPED_NO_CHECKLIST';
export const STATUS_SKIPPED_NO_PROVIDER = 'SKIPPED_NO_PROVIDER';
export const STATUS_SKIPPED_FEATURE_OFF = 'SKIPPED_FEATURE_OFF';

export const ACTIVE_STATUSES = [STATUS_SCHEDULED, STATUS_DEFERRED] as const;
