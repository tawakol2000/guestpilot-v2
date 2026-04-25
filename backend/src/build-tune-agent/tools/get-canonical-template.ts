/**
 * studio_get_canonical_template — sprint 060-D phase 8.
 *
 * Closes the GREENFIELD onboarding gap. The BUILD agent can offer
 * "start from template" but previously had no tool to fetch the
 * canonical text. Returns the full hospitality template (with slot
 * placeholders intact) or a single slot's guidance when `slot` is
 * passed.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import {
  GENERIC_HOSPITALITY_SEED,
  GENERIC_HOSPITALITY_SEED_VERSION,
  TEMPLATE_SLOT_KEYS,
} from '../templates';
import { asCallToolResult, asError, type ToolContext } from './types';

const LOAD_BEARING_SLOTS = [
  'property_identity',
  'checkin_time',
  'checkout_time',
  'escalation_contact',
  'payment_policy',
  'brand_voice',
] as const;

const NON_LOAD_BEARING_SLOTS = [
  'cleaning_policy',
  'amenities_list',
  'local_recommendations',
  'emergency_contact',
  'noise_policy',
  'pet_policy',
  'smoking_policy',
  'max_occupancy',
  'id_verification',
  'long_stay_discount',
  'cancellation_policy',
  'channel_coverage',
  'timezone',
  'ai_autonomy',
] as const;

type LoadBearingSlot = (typeof LOAD_BEARING_SLOTS)[number];
type NonLoadBearingSlot = (typeof NON_LOAD_BEARING_SLOTS)[number];
type SlotKey = LoadBearingSlot | NonLoadBearingSlot;

const ALL_SLOTS: readonly SlotKey[] = [
  ...LOAD_BEARING_SLOTS,
  ...NON_LOAD_BEARING_SLOTS,
];

const DESCRIPTION = `Return the canonical hospitality template — the structural skeleton + per-slot guidance the GREENFIELD onboarding flow uses for write_system_prompt. Pass a slot key to get just one slot's structure + guidance + default; omit for the full template plus the slot inventory. Load-bearing slots (6) gate graduation; non-load-bearing slots (14) can be defaulted.`;

export function buildGetCanonicalTemplateTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_get_canonical_template',
    DESCRIPTION,
    {
      slot: z.enum(ALL_SLOTS as unknown as [SlotKey, ...SlotKey[]]).optional(),
    },
    async (args) => {
      const _c = ctx();
      const span = startAiSpan('build-tune-agent.studio_get_canonical_template', {
        slot: args.slot ?? null,
      });
      try {
        if (args.slot) {
          const slot = args.slot;
          const guidance = extractSlotGuidance(slot);
          const isLoadBearing = (LOAD_BEARING_SLOTS as readonly string[]).includes(slot);
          const payload = {
            slot,
            loadBearing: isLoadBearing,
            templateVersion: GENERIC_HOSPITALITY_SEED_VERSION,
            placeholder: `{{${slot}}}`,
            guidance,
          };
          span.end({ slot });
          return asCallToolResult(payload);
        }

        const payload = {
          templateVersion: GENERIC_HOSPITALITY_SEED_VERSION,
          loadBearingSlots: LOAD_BEARING_SLOTS,
          nonLoadBearingSlots: NON_LOAD_BEARING_SLOTS,
          allSlots: TEMPLATE_SLOT_KEYS,
          template: GENERIC_HOSPITALITY_SEED,
        };
        span.end({});
        return asCallToolResult(payload);
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_get_canonical_template failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}

/**
 * Extract the `<!-- guidance: ... -->` line that immediately precedes
 * a slot's `{{slot_key}}` placeholder. Returns an empty string when no
 * guidance comment is found (defensive: future template edits may
 * remove it without breaking this tool).
 */
function extractSlotGuidance(slot: string): string {
  const placeholder = `{{${slot}}}`;
  const idx = GENERIC_HOSPITALITY_SEED.indexOf(placeholder);
  if (idx < 0) return '';
  const before = GENERIC_HOSPITALITY_SEED.slice(0, idx);
  const guidanceMatch = before.match(/<!--\s*guidance:\s*([\s\S]*?)\s*-->\s*$/);
  if (!guidanceMatch) return '';
  return guidanceMatch[1].trim();
}
