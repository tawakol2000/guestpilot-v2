// Sprint 046 Session B — design tokens for the /studio surface.
//
// Source: plan §3.3. The main-app palette — ink/canvas/hairline with a
// single blue accent on primary CTAs — replaces the violet-forward
// tuning tokens. Studio cards must NOT import from
// `frontend/components/tuning/tokens.ts` for chrome; the category
// pastels below (SOP yellow, FAQ teal, etc.) are the sole exception
// because they are artifact-type *labels*, not chrome (plan §3.3
// decision #3, retained after the Linear/Raycast restraint pass).
//
// No violet anywhere. `#6C5CE7` from TUNING_COLORS is intentionally
// absent.

export const STUDIO_COLORS = {
  // Backgrounds
  canvas: '#FFFFFF',
  surfaceSunken: '#F2F2F2',
  surfaceRaised: '#FFFFFF',

  // Borders / dividers
  hairline: '#E5E5E5',
  hairlineSoft: '#EFEFEF',

  // Text
  ink: '#0A0A0A',
  inkMuted: '#666666',
  inkSubtle: '#999999',

  // Accent — main-app blue. Only for primary CTAs and focus rings.
  accent: '#0070F3',
  accentSoft: '#E6F0FF',
  accentHover: '#0060D9',

  // Semantic
  successFg: '#117A3D',
  successBg: '#E7F5EC',
  warnFg: '#9A6A04',
  warnBg: '#FFF7E0',
  dangerFg: '#B42318',
  dangerBg: '#FEE4E2',

  // Diff surfaces — tuned to work on pure-white canvas (not the cool
  // gray the tuning tokens assumed). Keep them as translucent overlays
  // so selection highlights don't fight them.
  diffAddBg: 'rgba(17, 122, 61, 0.10)',
  diffAddFg: '#117A3D',
  diffDelBg: 'rgba(180, 35, 24, 0.10)',
  diffDelFg: '#B42318',

  // Sprint 050 A1 — typographic attribution. Quoted artifact content
  // (what `get_current_state` surfaced) renders as monospace on a tinted
  // background with a left-rule in `attributionQuoteRule`. Pending agent-
  // proposed content (inside a not-yet-approved plan or suggested fix)
  // renders in italic `attributionUnsavedFg` until the plan approves.
  attributionQuoteBg: '#FAFAFA',
  attributionQuoteRule: '#CBD5E1',
  attributionUnsavedFg: '#6B7280',
} as const;

// Artifact-type pill palette. Retained from the tuning palette per plan
// §3.3 decision #3 — these are categorical labels, not chrome. Four of
// the TUNING_COLORS category styles are kept; the others
// (MISSING_CAPABILITY, SOP_ROUTING, etc.) remain available through
// getStudioCategoryStyle but aren't surfaced on the common cards yet.
type CategoryStyle = { bg: string; fg: string; label: string };

export const STUDIO_CATEGORY_STYLES = {
  SOP_CONTENT: { bg: '#FEF9C3', fg: '#854D0E', label: 'SOP content' },
  SOP_ROUTING: { bg: '#FFEDD5', fg: '#9A3412', label: 'SOP routing' },
  FAQ: { bg: '#CCFBF1', fg: '#0F766E', label: 'FAQ' },
  SYSTEM_PROMPT: { bg: '#DBEAFE', fg: '#1E40AF', label: 'System prompt' },
  TOOL_CONFIG: { bg: '#EDE9FE', fg: '#6D28D9', label: 'Tool config' },
  PROPERTY_OVERRIDE: { bg: '#CFFAFE', fg: '#0E7490', label: 'Property' },
  MISSING_CAPABILITY: { bg: '#FCE7F3', fg: '#9D174D', label: 'Capability' },
  NO_FIX: { bg: STUDIO_COLORS.surfaceSunken, fg: STUDIO_COLORS.inkMuted, label: 'No fix' },
} as const satisfies Record<string, CategoryStyle>;

export type StudioCategoryKey = keyof typeof STUDIO_CATEGORY_STYLES;

export function getStudioCategoryStyle(category: string | null | undefined): CategoryStyle {
  if (!category) {
    return {
      bg: STUDIO_COLORS.surfaceSunken,
      fg: STUDIO_COLORS.inkMuted,
      label: 'Edit',
    };
  }
  const hit = (STUDIO_CATEGORY_STYLES as Record<string, CategoryStyle>)[category];
  if (hit) return hit;
  return {
    bg: STUDIO_COLORS.surfaceSunken,
    fg: STUDIO_COLORS.inkMuted,
    label: category,
  };
}

// Audit-report / status-dot palette — NOT emoji. Plan §4.1 rule 6.
export const STUDIO_STATUS_DOT = {
  ok: STUDIO_COLORS.successFg,
  warn: STUDIO_COLORS.warnFg,
  gap: STUDIO_COLORS.warnFg,
  danger: STUDIO_COLORS.dangerFg,
  unknown: STUDIO_COLORS.inkSubtle,
} as const;

export type StudioStatus = keyof typeof STUDIO_STATUS_DOT;

// ─── TUNE-era compat surface (sprint 046 Session D) ────────────────────
//
// Sprint 046 Session D retired `frontend/components/tuning/tokens.ts`.
// The legacy /tuning/{pairs,history,sessions,…} sub-routes still exist
// (redirect stubs deferred to sprint 047) and their components still
// compile against the old `TUNING_COLORS` / `CATEGORY_STYLES` /
// `categoryStyle` / `triggerLabel` export surface. Rather than inline a
// fallback at every callsite, we publish a compat namespace from the
// Studio tokens module so those components keep compiling without
// reintroducing a second source of truth.
//
// Violet is still gone from the chrome palette. The one token the
// compat surface needs that Studio doesn't use is `accent` — we map it
// to Studio's blue, and expose a muted grey (`accentMuted`) that
// tuning-era confidence gradients relied on. The tuning-era
// `accentHover` and `accentSoft` likewise map to Studio's tokens. The
// category pastels are identical to plan §3.3's retained set.

import type { TuningDiagnosticCategory, TuningTriggerType } from '@/lib/api';

export const TUNING_COLORS = {
  canvas: STUDIO_COLORS.canvas,
  surfaceRaised: STUDIO_COLORS.surfaceRaised,
  surfaceSunken: STUDIO_COLORS.surfaceSunken,
  ink: STUDIO_COLORS.ink,
  inkMuted: STUDIO_COLORS.inkMuted,
  inkSubtle: STUDIO_COLORS.inkSubtle,
  hairline: STUDIO_COLORS.hairline,
  hairlineSoft: STUDIO_COLORS.hairlineSoft,
  accent: STUDIO_COLORS.accent,
  accentHover: STUDIO_COLORS.accentHover,
  accentSoft: STUDIO_COLORS.accentSoft,
  // Muted accent for tuning-era confidence gradients. Studio chrome
  // doesn't surface this; callsites in legacy tuning components do.
  accentMuted: STUDIO_COLORS.inkSubtle,
  diffAddBg: STUDIO_COLORS.diffAddBg,
  diffAddFg: STUDIO_COLORS.diffAddFg,
  diffDelBg: STUDIO_COLORS.diffDelBg,
  diffDelFg: STUDIO_COLORS.diffDelFg,
  warnBg: STUDIO_COLORS.warnBg,
  warnFg: STUDIO_COLORS.warnFg,
  successFg: STUDIO_COLORS.successFg,
  dangerBg: STUDIO_COLORS.dangerBg,
  dangerFg: STUDIO_COLORS.dangerFg,
} as const;

type TuneCategoryStyle = { bg: string; fg: string; label: string };

export const LEGACY_CATEGORY_STYLE: TuneCategoryStyle = {
  bg: STUDIO_COLORS.surfaceSunken,
  fg: STUDIO_COLORS.inkMuted,
  label: 'Edit',
};

export const CATEGORY_STYLES: Record<TuningDiagnosticCategory, TuneCategoryStyle> = {
  SOP_CONTENT: STUDIO_CATEGORY_STYLES.SOP_CONTENT,
  SOP_ROUTING: STUDIO_CATEGORY_STYLES.SOP_ROUTING,
  FAQ: STUDIO_CATEGORY_STYLES.FAQ,
  SYSTEM_PROMPT: STUDIO_CATEGORY_STYLES.SYSTEM_PROMPT,
  TOOL_CONFIG: STUDIO_CATEGORY_STYLES.TOOL_CONFIG,
  MISSING_CAPABILITY: STUDIO_CATEGORY_STYLES.MISSING_CAPABILITY,
  PROPERTY_OVERRIDE: STUDIO_CATEGORY_STYLES.PROPERTY_OVERRIDE,
  NO_FIX: STUDIO_CATEGORY_STYLES.NO_FIX,
};

export const CATEGORY_ACCENT: Record<TuningDiagnosticCategory | 'LEGACY', string> = {
  SOP_CONTENT: '#CA8A04',
  SOP_ROUTING: '#EA580C',
  FAQ: '#14B8A6',
  SYSTEM_PROMPT: '#3B82F6',
  TOOL_CONFIG: '#8B5CF6',
  MISSING_CAPABILITY: '#EC4899',
  PROPERTY_OVERRIDE: '#06B6D4',
  NO_FIX: STUDIO_COLORS.inkSubtle,
  LEGACY: STUDIO_COLORS.inkSubtle,
};

export function categoryStyle(category: TuningDiagnosticCategory | null): TuneCategoryStyle {
  if (!category) return LEGACY_CATEGORY_STYLE;
  return CATEGORY_STYLES[category] ?? LEGACY_CATEGORY_STYLE;
}

export function categoryAccent(category: TuningDiagnosticCategory | null): string {
  if (!category) return CATEGORY_ACCENT.LEGACY;
  return CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.LEGACY;
}

export const TRIGGER_LABELS: Record<TuningTriggerType, string> = {
  MANUAL: 'Manual',
  EDIT_TRIGGERED: 'Edited before send',
  REJECT_TRIGGERED: 'Wholesale rewrite',
  COMPLAINT_TRIGGERED: 'Complaint',
  THUMBS_DOWN_TRIGGERED: 'Thumbs down',
  CLUSTER_TRIGGERED: 'Cluster pattern',
  ESCALATION_TRIGGERED: 'Escalation',
};

export function triggerLabel(trigger: TuningTriggerType | null): string {
  if (!trigger) return 'Legacy';
  return TRIGGER_LABELS[trigger] ?? String(trigger);
}
