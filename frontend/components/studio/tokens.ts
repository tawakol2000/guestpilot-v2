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

// Sprint 046 — STUDIO_COLORS values migrated to the v2 design-overhaul
// palette. Same keys and shape as before; every consumer (Studio chrome,
// block renderers, drawers) picks up the new Augen-blue accent and the
// slightly-warmer neutral stack automatically. TUNING_COLORS (exported
// below) re-exports these, which retires the old accents from the
// legacy /tuning/* routes along with Studio — acceptable per user
// confirmation that the legacy chat history is no longer important.

export const STUDIO_COLORS = {
  // Backgrounds
  canvas: '#ffffff',
  surfaceSunken: '#fafafa',
  surfaceRaised: '#ffffff',

  // Borders / dividers
  hairline: '#e7e8ec',
  hairlineSoft: '#eceef2',

  // Text
  ink: '#0a0a0b',
  inkMuted: '#6b6d76',
  inkSubtle: '#9b9ea6',

  // Accent — Augen blue (v2). Primary CTAs, active states, focus rings.
  accent: '#0a5bff',
  accentSoft: '#eaf1ff',
  accentHover: '#004fe8',

  // Semantic — v2 values from the handoff palette
  successFg: '#16a34a',
  successBg: '#ECFDF5',
  warnFg: '#d97706',
  warnBg: '#fff7e0',
  dangerFg: '#dc2626',
  dangerBg: '#FEE4E2',

  // Diff surfaces — v2 alpha overlays on pure-white canvas.
  diffAddBg: 'rgba(10, 91, 255, 0.06)',
  diffAddFg: '#0a5bff',
  diffDelBg: 'rgba(220, 38, 38, 0.05)',
  diffDelFg: '#dc2626',

  // Sprint 050 A1 — typographic attribution. Quoted artifact content
  // (what `get_current_state` surfaced) renders as monospace on a tinted
  // background with a left-rule in `attributionQuoteRule`. Pending agent-
  // proposed content (inside a not-yet-approved plan or suggested fix)
  // renders in italic `attributionUnsavedFg` until the plan approves.
  attributionQuoteBg: '#FAFAFA',
  attributionQuoteRule: '#CBD5E1',
  attributionUnsavedFg: '#6B7280',
} as const;

// ─── Sprint 046 — STUDIO_TOKENS_V2 (design-overhaul palette) ────────────────
//
// Exact hex values from /Users/at/Downloads/design_handoff_studio/README.md
// (Augen-blue accent #0a5bff + restrained neutral palette + Inter Tight
// typography). New Studio chrome imports these tokens *only*. Legacy
// `/tuning/*` routes keep importing STUDIO_COLORS via the TUNING_COLORS
// compat surface below — do NOT merge the two palettes.
//
// Dark-mode tokens deliberately omitted (spec 046 Clarifications Q5 —
// dark mode is out of scope this release).

export const STUDIO_TOKENS_V2 = {
  // Backgrounds
  bg: '#ffffff',
  surface: '#fafafa',
  surface2: '#f4f5f7',
  surface3: '#eceef2',

  // Borders / dividers
  border: '#e7e8ec',
  borderStrong: '#d7d9df',

  // Text
  ink: '#0a0a0b',
  ink2: '#2a2b30',
  muted: '#6b6d76',
  muted2: '#9b9ea6',

  // Accent — Augen blue. Primary CTAs, active states, diff additions, focus rings.
  blue: '#0a5bff',
  blueHover: '#004fe8',
  blueSoft: '#eaf1ff',
  blueTint: '#f4f7ff',

  // Semantic
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',

  // Diff overlays — handoff-specified alphas on the v2 canvas
  diffAddBg: 'rgba(10, 91, 255, 0.06)',
  diffAddFg: '#0a5bff',
  diffDelBg: 'rgba(220, 38, 38, 0.05)',
  diffDelFg: '#dc2626',

  // Amber warn bg for LATENCY BUDGET threshold breaches (FR-033).
  warnFg: '#d97706',
  warnBg: '#fff7e0',

  // Radii (in px — consume as `radiusLg` or inline as `${v2.radiusLg}px`).
  radiusSm: 7,
  radiusMd: 8,
  radiusLg: 12,
  radiusXl: 14,

  // Shadows
  shadowSm: '0 1px 2px rgba(10,12,20,0.04)',
  shadowMd: '0 2px 8px rgba(10,12,20,0.06)',

  // Icon stroke (px) at 16px default icon size
  iconStroke: 1.6,

  // Scrollbar (WebKit only — applied via CSS at the shell root)
  scrollbarThumb: '#e2e3e8',
  scrollbarThumbHover: '#cacbd2',
  scrollbarWidth: 10,
} as const;

export type StudioTokenV2 = keyof typeof STUDIO_TOKENS_V2;

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

// ─── Sprint 057-A F2 — typographic attribution helper ──────────────────────
//
// Centralises the A1 data-origin grammar so every surface that renders
// text can call `attributedStyle(origin)` rather than hard-coding colour
// values. AI-authored prose → inkMuted grey (#666666). Operator-authored
// prose → ink black (#0A0A0A). Mixed provenance falls to the AI colour
// so the agent portion is never accidentally promoted to human weight.

export type TextOrigin = 'ai' | 'human' | 'mixed'

export function attributedStyle(origin: TextOrigin): React.CSSProperties {
  switch (origin) {
    case 'human':
      return { color: STUDIO_COLORS.ink }
    case 'mixed':
    case 'ai':
      return { color: STUDIO_COLORS.inkMuted }
  }
}

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
