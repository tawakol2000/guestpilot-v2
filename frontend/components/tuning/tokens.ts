// Feature 041 sprint 07 — design tokens for the /tuning surface.
// Overhauled from sprint-03's warm-stone editorial palette to a cool,
// professional neutral palette modelled on Claude Console + OpenAI Platform.
// These tokens stay co-located with the tuning surface so the new direction
// does not leak into the rest of the app (see sprint-07-ui-overhaul.md).

import type { TuningDiagnosticCategory, TuningTriggerType } from '@/lib/api'

export const TUNING_COLORS = {
  // Backgrounds
  canvas: '#F9FAFB',        // cool neutral page background
  surfaceRaised: '#FFFFFF', // elevated cards, modals, chat bubbles
  surfaceSunken: '#F3F4F6', // inset areas, code blocks, reasoning wells

  // Text
  ink: '#1A1A1A',           // primary text — near-black, not warm stone
  inkMuted: '#6B7280',      // secondary text — cool gray
  inkSubtle: '#9CA3AF',     // tertiary text / hints / timestamps

  // Borders / dividers
  hairline: '#E5E7EB',      // primary divider
  hairlineSoft: '#EEF0F3',  // near-invisible divider (distinct from surfaceSunken
                            // so it still reads when drawn on a sunken background)

  // Accent — one purple, used sparingly on interactive affordances
  accent: '#6C5CE7',        // primary accent (buttons, selected states, links)
  accentHover: '#5B4BD4',   // slightly darker for button hover
  accentSoft: '#F0EEFF',    // tinted background for selected items
  accentMuted: '#A29BFE',   // secondary accent, used in confidence gradients

  // Diff surfaces — translucent overlays, not solid tints
  diffAddBg: 'rgba(16, 185, 129, 0.10)',
  diffAddFg: '#047857',
  diffDelBg: 'rgba(239, 68, 68, 0.10)',
  diffDelFg: '#B91C1C',

  // Semantic
  warnBg: '#FFFBEB',
  warnFg: '#B45309',
  successFg: '#059669',
  dangerBg: '#FEF2F2',
  dangerFg: '#B91C1C',
} as const

type CategoryStyle = { bg: string; fg: string; label: string }

// Legacy rows (null diagnosticCategory) reuse the NO_FIX/sunken treatment and
// show the generic word "Edit".
export const LEGACY_CATEGORY_STYLE: CategoryStyle = {
  bg: TUNING_COLORS.surfaceSunken,
  fg: TUNING_COLORS.inkMuted,
  label: 'Edit',
}

// Category pill palette — soft pastel backgrounds with strong foreground
// colors that read clearly at 12px on white. Tuned against the cool neutral
// surfaces above so nothing feels beige.
export const CATEGORY_STYLES: Record<TuningDiagnosticCategory, CategoryStyle> = {
  SOP_CONTENT:        { bg: '#FEF9C3', fg: '#854D0E', label: 'SOP content' },
  SOP_ROUTING:        { bg: '#FFEDD5', fg: '#9A3412', label: 'SOP routing' },
  FAQ:                { bg: '#CCFBF1', fg: '#0F766E', label: 'FAQ' },
  SYSTEM_PROMPT:      { bg: '#DBEAFE', fg: '#1E40AF', label: 'System prompt' },
  TOOL_CONFIG:        { bg: '#EDE9FE', fg: '#6D28D9', label: 'Tool config' },
  MISSING_CAPABILITY: { bg: '#FCE7F3', fg: '#9D174D', label: 'Capability' },
  PROPERTY_OVERRIDE:  { bg: '#CFFAFE', fg: '#0E7490', label: 'Property' },
  NO_FIX:             { bg: TUNING_COLORS.surfaceSunken, fg: TUNING_COLORS.inkMuted, label: 'No fix' },
}

// Lookup by category → color pair for category bars (the 3px left indicator
// on queue items etc). Picks a single representative hue so the bar reads
// regardless of the pastel background it's next to.
export const CATEGORY_ACCENT: Record<TuningDiagnosticCategory | 'LEGACY', string> = {
  SOP_CONTENT:        '#CA8A04',
  SOP_ROUTING:        '#EA580C',
  FAQ:                '#14B8A6',
  SYSTEM_PROMPT:      '#3B82F6',
  TOOL_CONFIG:        '#8B5CF6',
  MISSING_CAPABILITY: '#EC4899',
  PROPERTY_OVERRIDE:  '#06B6D4',
  NO_FIX:             TUNING_COLORS.inkSubtle,
  LEGACY:             TUNING_COLORS.inkSubtle,
}

export function categoryStyle(category: TuningDiagnosticCategory | null): CategoryStyle {
  if (!category) return LEGACY_CATEGORY_STYLE
  return CATEGORY_STYLES[category] ?? LEGACY_CATEGORY_STYLE
}

export function categoryAccent(category: TuningDiagnosticCategory | null): string {
  if (!category) return CATEGORY_ACCENT.LEGACY
  return CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.LEGACY
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
