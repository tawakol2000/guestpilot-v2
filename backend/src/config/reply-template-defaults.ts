// Feature 043 — system-default reply templates for action-card escalations.
// Source of truth for the strings used when a tenant has not saved a custom
// override in AutomatedReplyTemplate. Edited in place when copy changes; never
// written at runtime.

export type EscalationType = 'late_checkout_request' | 'early_checkin_request';
export type TemplateDecision = 'approve' | 'reject';

export const SUPPORTED_ESCALATION_TYPES: ReadonlyArray<EscalationType> = [
  'late_checkout_request',
  'early_checkin_request',
];

export const SUPPORTED_DECISIONS: ReadonlyArray<TemplateDecision> = ['approve', 'reject'];

type DefaultsMap = Record<EscalationType, Record<TemplateDecision, string>>;

const DEFAULTS: DefaultsMap = {
  late_checkout_request: {
    approve:
      "Hi {GUEST_FIRST_NAME} — confirmed, you can check out at {REQUESTED_TIME}. Safe travels!",
    reject:
      "Hi {GUEST_FIRST_NAME} — unfortunately we're unable to accommodate a late checkout this time. Standard checkout remains {CHECK_OUT_TIME}. Let us know if we can help make your departure smoother.",
  },
  early_checkin_request: {
    approve:
      "Hi {GUEST_FIRST_NAME} — confirmed, you can check in from {REQUESTED_TIME}. Looking forward to hosting you!",
    reject:
      "Hi {GUEST_FIRST_NAME} — unfortunately we can't offer an earlier check-in this time. Standard check-in is {CHECK_IN_TIME}. Feel free to drop off luggage if helpful.",
  },
};

export function getDefaultReplyTemplate(
  escalationType: string,
  decision: string
): string | null {
  const byType = (DEFAULTS as Record<string, Record<string, string>>)[escalationType];
  if (!byType) return null;
  return byType[decision] ?? null;
}

export function isSupportedEscalationType(value: string): value is EscalationType {
  return SUPPORTED_ESCALATION_TYPES.includes(value as EscalationType);
}

export function isSupportedDecision(value: string): value is TemplateDecision {
  return SUPPORTED_DECISIONS.includes(value as TemplateDecision);
}
