/**
 * Canonical hospitality seed template (sprint 045, Gate 4).
 *
 * The `.md` file ships with the product as the GREENFIELD starting point
 * for `write_system_prompt`. Twenty `{{slot_key}}` placeholders, lowercase
 * snake_case keys that match LOAD_BEARING_SLOTS + NON_LOAD_BEARING_SLOTS
 * in `tools/write-system-prompt.ts`. Each slot has a guidance HTML
 * comment immediately above it.
 *
 * Render contract: `renderSeed(slotValues)` substitutes each
 * `{{slot_key}}` with `slotValues[key]`. When a key is missing or empty,
 * the placeholder is replaced with `<!-- DEFAULT: change me -->` so the
 * V3 default-marker round-trip detection (write_system_prompt's
 * `loadBearingDefaulted` check) still fires on unfilled slots.
 *
 * `loadSeed()` returns the raw template text — used by the BUILD agent
 * when it wants to show the manager the template structure, or when the
 * GREENFIELD path opens with "start from the generic template."
 *
 * Versioning: `GENERIC_HOSPITALITY_SEED_VERSION` is a content hash
 * computed once at import — `write_system_prompt`'s
 * `sourceTemplateVersion` parameter expects this exact string so a
 * later edit to the template surfaces in audit logs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TEMPLATE_FILENAME = 'generic-hospitality-seed.md';
const DEFAULT_MARKER = '<!-- DEFAULT: change me -->';
const PLACEHOLDER_RE = /\{\{([a-z_][a-z0-9_]*)\}\}/g;

const TEMPLATE_PATH = join(__dirname, TEMPLATE_FILENAME);

/**
 * Raw template text — `{{slot_key}}` placeholders intact, no substitution.
 * Frozen at module load so the byte-identical round-trip is unambiguous.
 */
export const GENERIC_HOSPITALITY_SEED: string = readFileSync(
  TEMPLATE_PATH,
  'utf8'
);

/**
 * Stable version stamp: `seed-v1-<sha256(first 16 chars)>`. Bumps
 * automatically on any byte change to the .md file. Stored on every
 * `write_system_prompt` write so audits can trace which template
 * generation produced a given AiConfigVersion.
 */
export const GENERIC_HOSPITALITY_SEED_VERSION: string = `seed-v1-${createHash(
  'sha256'
)
  .update(GENERIC_HOSPITALITY_SEED)
  .digest('hex')
  .slice(0, 16)}`;

/**
 * Return the raw template. Stable across calls (the file is read once at
 * module load).
 */
export function loadSeed(): string {
  return GENERIC_HOSPITALITY_SEED;
}

/**
 * Slot keys discovered in the template. Computed once at import. Used by
 * the unit test to assert alignment with LOAD_BEARING_SLOTS +
 * NON_LOAD_BEARING_SLOTS.
 */
export const TEMPLATE_SLOT_KEYS: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const match of GENERIC_HOSPITALITY_SEED.matchAll(PLACEHOLDER_RE)) {
    seen.add(match[1]);
  }
  return Object.freeze([...seen]);
})();

/**
 * Render the template with a slot dictionary. Missing or empty values
 * are replaced with `<!-- DEFAULT: change me -->` so the resulting text
 * still round-trips through `write_system_prompt`'s default detection.
 *
 * Returns the rendered prompt text. The caller owns building the
 * `slotValues` object that goes alongside it on the
 * `write_system_prompt` call.
 */
export function renderSeed(slotValues: Record<string, string>): string {
  return GENERIC_HOSPITALITY_SEED.replace(PLACEHOLDER_RE, (_match, key) => {
    const v = slotValues[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
    return DEFAULT_MARKER;
  });
}
