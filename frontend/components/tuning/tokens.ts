// Feature 041 sprint 03 — design tokens for the /tuning surface.
// Keep these co-located with the surface so the editorial direction doesn't
// leak into the rest of the app. See specs/041-conversational-tuning/sprint-03-design-notes.md.

import type { TuningDiagnosticCategory, TuningTriggerType } from '@/lib/api'

export const TUNING_COLORS = {
  canvas: '#FAFAF9',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#F5F4F1',
  ink: '#0C0A09',
  inkMuted: '#57534E',
  inkSubtle: '#A8A29E',
  hairline: '#E7E5E4',
  accent: '#1E3A8A',
  accentSoft: '#EEF2FF',
  diffAddFg: '#065F46',
  diffAddBg: '#ECFDF5',
  diffDelFg: '#9F1239',
  diffDelBg: '#FEF2F2',
  warnFg: '#92400E',
  warnBg: '#FFFBEB',
} as const

type CategoryStyle = { bg: string; fg: string; label: string }

// Legacy rows (null diagnosticCategory) reuse the NO_FIX/sunken treatment and
// show the generic word "Edit".
export const LEGACY_CATEGORY_STYLE: CategoryStyle = {
  bg: TUNING_COLORS.surfaceSunken,
  fg: TUNING_COLORS.inkMuted,
  label: 'Edit',
}

export const CATEGORY_STYLES: Record<TuningDiagnosticCategory, CategoryStyle> = {
  SOP_CONTENT:        { bg: '#FEFCE8', fg: '#854D0E', label: 'SOP content' },
  SOP_ROUTING:        { bg: '#FFF7ED', fg: '#9A3412', label: 'SOP routing' },
  FAQ:                { bg: '#F0FDFA', fg: '#115E59', label: 'FAQ' },
  SYSTEM_PROMPT:      { bg: '#EFF6FF', fg: '#1E40AF', label: 'System prompt' },
  TOOL_CONFIG:        { bg: '#F5F3FF', fg: '#5B21B6', label: 'Tool config' },
  MISSING_CAPABILITY: { bg: '#FDF2F8', fg: '#9D174D', label: 'Missing capability' },
  PROPERTY_OVERRIDE:  { bg: '#ECFEFF', fg: '#155E75', label: 'Property override' },
  NO_FIX:             { bg: TUNING_COLORS.surfaceSunken, fg: TUNING_COLORS.inkMuted, label: 'No fix' },
}

export function categoryStyle(category: TuningDiagnosticCategory | null): CategoryStyle {
  if (!category) return LEGACY_CATEGORY_STYLE
  return CATEGORY_STYLES[category] ?? LEGACY_CATEGORY_STYLE
}

export const TRIGGER_LABELS: Record<TuningTriggerType, string> = {
  MANUAL:                 'Manual',
  EDIT_TRIGGERED:         'Edited before send',
  REJECT_TRIGGERED:       'Wholesale rewrite',
  COMPLAINT_TRIGGERED:    'Complaint',
  THUMBS_DOWN_TRIGGERED:  'Thumbs down',
  CLUSTER_TRIGGERED:      'Cluster pattern',
  ESCALATION_TRIGGERED:   'Escalation',
}

export function triggerLabel(trigger: TuningTriggerType | null): string {
  if (!trigger) return 'Legacy'
  return TRIGGER_LABELS[trigger] ?? String(trigger)
}
