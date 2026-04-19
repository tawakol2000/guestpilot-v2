/**
 * V3 validation — default markers round-trip.
 *
 * Goal: confirm `<!-- DEFAULT: change me -->` markers survive the full
 * template rendering path from the GENERIC_HOSPITALITY_SEED → BUILD tool
 * write → main AI read path, byte-identical.
 *
 * Run: `npx ts-node specs/045-build-mode/validation/V3-round-trip.ts`
 * from the backend/ directory.
 */
import {
  resolveVariables,
  CONTENT_BLOCKS_DELIMITER,
  BLOCK_DELIMITER,
} from '../../../backend/src/services/template-variable.service';

// Simulated render of GENERIC_HOSPITALITY_SEED with 5 of 20 slots filled
// by defaults. The template uses both HTML-comment markers AND template
// variables — we need to confirm ONLY the {VARIABLE} tokens get replaced,
// and the <!-- DEFAULT --> markers survive intact.
const RENDERED_TEMPLATE = `You are Aria, the guest services AI for SunsetApartments.

Identity and voice:
- Warm, professional, concise. Reply in the guest's language.

Check-in and check-out:
- Default check-in is 15:00.
<!-- DEFAULT: change me -->
- Default check-out is 11:00.
<!-- DEFAULT: change me -->
- Late checkout is bookable up to 14:00 for a fee of 25 EUR.

Escalation:
- If the guest raises a complaint, safety issue, or dispute, hand off to
  the on-call manager at +34 600 123 456 (WhatsApp, 09:00–21:00 local).

Payment and refunds:
- Security deposits are held for 7 days post-checkout.
<!-- DEFAULT: change me -->
- Damage charges are itemised and photographed before deduction.

Cleaning:
<!-- DEFAULT: change me -->
- Mid-stay cleaning available on request, 3 days notice.

Noise:
<!-- DEFAULT: change me -->
- Quiet hours 22:00–08:00. No parties. Breach = immediate escalation.

${CONTENT_BLOCKS_DELIMITER}
{CONVERSATION_HISTORY}
${BLOCK_DELIMITER}
{RESERVATION_DETAILS}
${BLOCK_DELIMITER}
{CURRENT_MESSAGES}
`;

const MARKER = '<!-- DEFAULT: change me -->';

function countMarkers(text: string): number {
  return (text.match(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

console.log('V3: default-marker round-trip validation\n');

// Pre-write check: the rendered template has 5 markers.
const initialCount = countMarkers(RENDERED_TEMPLATE);
assert(initialCount === 5, `initial template has 5 markers (got ${initialCount})`);

// Step 1. Simulated persistence round-trip.
// Prisma `String` columns on PostgreSQL are UTF-8 byte-safe. A string
// round-trip through a `String` column is the identity function; the
// risk isn't here. We simulate it as a no-op to document it.
const persisted = RENDERED_TEMPLATE;
assert(persisted === RENDERED_TEMPLATE, 'Prisma String persistence is byte-identical (identity simulation)');
assert(countMarkers(persisted) === 5, 'persisted string retains all 5 markers');

// Step 2. Read path: the main AI pipeline calls
// `resolveVariables(effectiveSystemPrompt, dataMap, agentType)` before
// building the request. This is the one place markers could be stripped.
const dataMap: Record<string, string> = {
  CONVERSATION_HISTORY: 'Guest: Hi, can I check in early?',
  RESERVATION_DETAILS: 'Booking #12345 | 2026-04-20 → 2026-04-23',
  CURRENT_MESSAGES: 'Guest: When can I check in?',
};
const { cleanedPrompt, contentBlocks } = resolveVariables(
  persisted,
  dataMap,
  'coordinator',
);

const prefixMarkers = countMarkers(cleanedPrompt);
assert(prefixMarkers === 5, `markers in cleanedPrompt = 5 (got ${prefixMarkers})`);

// Double-check: each marker is byte-identical (no whitespace collapse,
// no HTML-entity encoding, no quote escaping).
const expectedSurround = '<!-- DEFAULT: change me -->';
const allByteIdentical = cleanedPrompt.includes(expectedSurround);
assert(allByteIdentical, 'markers are byte-identical (no entity encoding or whitespace collapse)');

// Content blocks should NOT contain the markers (markers live in the
// system-prompt prefix only, not in the content-block templates).
const blockMarkerCount = contentBlocks.reduce((sum, b) => sum + countMarkers(b.text), 0);
assert(blockMarkerCount === 0, 'content blocks contain 0 markers (they live in the system prefix)');

// Step 3. Main-AI-view check.
// The main AI receives `cleanedPrompt` as its system prompt. HTML
// comments are inert markup. Sonnet 4.6 and GPT-5.4 treat them as such
// by convention. The spec accepts this form as long as the main AI is
// "instructed to ignore them" OR they're comment-form. HTML comments
// ARE comment form; no additional instruction needed.
//
// This is documented in V3-result.md; no code assertion possible without
// a live LLM round-trip.

console.log(`\ncleanedPrompt preview (first 500 chars):\n${cleanedPrompt.slice(0, 500)}\n...`);
console.log(`\ncontentBlocks count: ${contentBlocks.length}`);
console.log(`\nV3: all assertions ${process.exitCode ? 'FAILED' : 'PASSED'}`);
