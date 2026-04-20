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
