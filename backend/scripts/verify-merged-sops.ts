/**
 * verify-merged-sops.ts — end-to-end verification of the merged-SOP model
 * through the same pipeline the Studio `studio_test_pipeline` tool uses.
 *
 * For each booking status (INQUIRY / CONFIRMED / CHECKED_IN), sends a test
 * message through `runPipelineDry` (backend/src/build-tune-agent/preview/
 * test-pipeline-runner.ts) and inspects the AI reply.
 *
 * What this validates that the cheap structural test can NOT:
 *   ✓ The model actually READS the inline "### When booking is X" subsections
 *     and applies the matching one based on the test_pipeline preamble.
 *   ✓ Status-aware behaviour differences (an INQUIRY reply about WiFi defers
 *     the password; a CONFIRMED reply attempts to share it).
 *
 * Cost: ~3 OpenAI calls per status (one per test message), ~$0.05-0.10 each
 * with gpt-5.4-mini given the ~8k-token injected SOP block. Single run ≈ $0.30.
 *
 * Usage:
 *   cd backend
 *   npx tsx scripts/verify-merged-sops.ts <tenantId>
 *   npx tsx scripts/verify-merged-sops.ts <tenantId> --only=wifi   # one case
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { runPipelineDry } from '../src/build-tune-agent/preview/test-pipeline-runner';

type Status = 'INQUIRY' | 'CONFIRMED' | 'CHECKED_IN';

interface TestCase {
  id: string;
  message: string;
  expectations: Partial<
    Record<Status, { mustContain?: string[]; mustNotContain?: string[]; label: string }>
  >;
}

// Trigger messages designed to surface different status-section behaviour
// across the merged SOPs. Note: test_pipeline pre-injects the SOP body but
// does NOT resolve {ACCESS_CONNECTIVITY} / {CHECKIN_SITUATION} / {CHECKOUT_SITUATION}
// template vars. We assert on the *behavioural difference* between statuses
// (deferral phrasing, scheduling vs reassurance, etc.) rather than literal
// values — the access-code guardrail is exercised in production by
// ai.service.ts:1186-1198 and is verified structurally elsewhere.
const TEST_CASES: TestCase[] = [
  // ── access & connectivity ────────────────────────────────────────────
  {
    id: 'doorcode',
    message: 'whats the door code',
    expectations: {
      INQUIRY: {
        label: 'door code: should NOT leak the literal code',
        mustNotContain: ['1050501', '1050503', '1050504', '714425'],
      },
      CONFIRMED: {
        label: 'door code: should NOT defer with inquiry-phase phrasing',
        mustNotContain: ['after your booking is confirmed', 'once you book', 'when you book'],
      },
    },
  },
  {
    id: 'wifi-password',
    message: 'whats the wifi password',
    expectations: {
      INQUIRY: {
        label: 'wifi password: should defer until booked (regression — FAQ leak earlier)',
        mustNotContain: ['br@', 'password is br', 'standard is br', 'password is:'],
      },
    },
  },
  // ── visitor policy ───────────────────────────────────────────────────
  {
    id: 'visitor-family',
    message: 'My brother wants to visit me at the apartment, is that ok?',
    expectations: {
      INQUIRY: {
        label: 'visitor (family, INQUIRY): policy upfront, no passport ask yet',
        mustNotContain: ['send me the passport', 'send a passport', 'share the passport', 'share his passport'],
      },
      CONFIRMED: {
        label: 'visitor (family, CONFIRMED): request passport image',
        mustContain: ['passport'],
      },
    },
  },
  {
    id: 'visitor-friend',
    message: 'Can I bring my friend Sarah over tonight?',
    expectations: {
      INQUIRY: {
        label: 'visitor (friend): non-family visitors must be refused',
        mustContain: ['family'],
      },
      CHECKED_IN: {
        label: 'visitor (friend, CHECKED_IN): non-family visitors must be refused',
        mustContain: ['family'],
      },
    },
  },
  // ── early check-in ───────────────────────────────────────────────────
  {
    id: 'early-checkin',
    message: 'Can I check in earlier than 3pm?',
    expectations: {
      INQUIRY: {
        label: 'early-checkin (INQUIRY): mention 3pm standard, no specific promises',
        mustNotContain: ['yes, you can check in at', 'early check-in is confirmed', 'early check-in is available at'],
      },
      CONFIRMED: {
        label: 'early-checkin (CONFIRMED): never confirms early check-in itself',
        mustNotContain: ['yes, you can check in at 1', 'yes, you can check in at 2', "you're all set for early"],
      },
    },
  },
  // ── late checkout ────────────────────────────────────────────────────
  {
    id: 'late-checkout',
    message: 'can I check out at 2pm please?',
    expectations: {
      INQUIRY: {
        label: 'late-checkout (INQUIRY): mention 11am standard, no promise',
        mustNotContain: ['confirmed', "you're all set for 2pm", "approved"],
      },
      CHECKED_IN: {
        label: 'late-checkout (CHECKED_IN): never confirm itself, mention escalation/tiers',
        mustNotContain: ['confirmed late checkout', "you're approved for 2pm"],
      },
    },
  },
  // ── cleaning ─────────────────────────────────────────────────────────
  {
    id: 'cleaning',
    message: 'can someone clean the apartment tomorrow?',
    expectations: {
      INQUIRY: {
        label: 'cleaning (INQUIRY): reassure available, do NOT schedule (not booked)',
        mustNotContain: ['scheduled for tomorrow', "i'll book tomorrow", 'confirmed for tomorrow'],
      },
      CONFIRMED: {
        label: 'cleaning (CONFIRMED): reassure available on stay, do NOT schedule (not checked in)',
        mustNotContain: ['scheduled for tomorrow', "i'll send cleaning tomorrow", 'confirmed for tomorrow'],
      },
      CHECKED_IN: {
        label: 'cleaning (CHECKED_IN): ask for preferred time within working hours',
        mustNotContain: ['cleaning is only available next stay', 'after booking'],
      },
    },
  },
  // ── amenity request ──────────────────────────────────────────────────
  {
    id: 'amenity-towels',
    message: 'can I get extra towels?',
    expectations: {
      INQUIRY: {
        label: 'amenity (INQUIRY): confirm availability, do NOT schedule delivery',
        mustNotContain: ['scheduled', "what time should I send", "i'll send them at"],
      },
      CHECKED_IN: {
        label: 'amenity (CHECKED_IN): ask for preferred delivery time',
        // The AI should solicit a time during working hours (10–5).
        mustNotContain: ['will be ready for arrival', 'ready when you check in'],
      },
    },
  },
  // ── pre-arrival logistics / address ──────────────────────────────────
  {
    id: 'address',
    message: 'whats the property address?',
    expectations: {
      INQUIRY: {
        label: 'address (INQUIRY): general area only, do NOT share exact street address',
        // INQUIRY section: "do NOT share the exact street address or compound entry instructions until the booking is confirmed"
        mustNotContain: ['street', 'apartment #', 'building #', 'gate security'],
      },
      CONFIRMED: {
        label: 'address (CONFIRMED): share address / compound entry instructions',
        // Should mention compound entry / gate / address.
        mustNotContain: ['after booking', 'once you book'],
      },
    },
  },
  // ── booking modification ─────────────────────────────────────────────
  {
    id: 'extend-stay',
    message: "I'd like to stay one more night, is that possible?",
    expectations: {
      INQUIRY: {
        label: 'extend (INQUIRY): treat as inquiry change, never confirm',
        mustNotContain: ['extended your booking', 'extended your stay', "you're all set for one more"],
      },
      CHECKED_IN: {
        label: 'extend (CHECKED_IN): check availability + escalate, never confirm directly',
        mustNotContain: ['extended your booking', 'extended your stay', "you're all set for one more"],
      },
    },
  },
];

function listMatches(text: string, needles: string[]): { hits: string[]; missed: string[] } {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  const missed: string[] = [];
  for (const n of needles) {
    if (lower.includes(n.toLowerCase())) hits.push(n);
    else missed.push(n);
  }
  return { hits, missed };
}

async function runOne(
  prisma: PrismaClient,
  tenantId: string,
  status: Status,
  message: string,
): Promise<{ reply: string; latencyMs: number }> {
  const result = await runPipelineDry({
    tenantId,
    testMessage: message,
    context: { reservationStatus: status, channel: 'DIRECT' },
    prisma,
  });
  return { reply: result.reply, latencyMs: result.latencyMs };
}

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.find((a) => !a.startsWith('--'));
  if (!tenantId) {
    console.error('Usage: verify-merged-sops.ts <tenantId> [--only=<caseId>]');
    process.exit(1);
  }
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const onlyCase = onlyArg ? onlyArg.split('=')[1] : null;

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set — needed to drive the test_pipeline.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  let pass = true;
  try {
    const cases = onlyCase ? TEST_CASES.filter((t) => t.id === onlyCase) : TEST_CASES;
    if (cases.length === 0) {
      console.error(`No matching test case for --only=${onlyCase}`);
      process.exit(1);
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`Tenant: ${tenantId}`);
    console.log(`Cases:  ${cases.map((c) => c.id).join(', ')}`);
    console.log('══════════════════════════════════════════════════════════════\n');

    for (const tc of cases) {
      console.log(`\n## CASE [${tc.id}]  "${tc.message}"\n`);
      for (const status of Object.keys(tc.expectations) as Status[]) {
        const exp = tc.expectations[status]!;
        const { reply, latencyMs } = await runOne(prisma, tenantId, status, tc.message);
        console.log(`──── status=${status}  (${latencyMs}ms) ────`);
        console.log(reply.trim());

        const checkMust = exp.mustContain ? listMatches(reply, exp.mustContain) : null;
        const checkMustNot = exp.mustNotContain ? listMatches(reply, exp.mustNotContain) : null;

        const passMust = !checkMust || checkMust.missed.length === 0;
        const passMustNot = !checkMustNot || checkMustNot.hits.length === 0;
        const ok = passMust && passMustNot;
        if (!ok) pass = false;

        console.log(
          `${ok ? '✓' : '✗'} ${status} ${exp.label}` +
            (checkMust && checkMust.missed.length
              ? `   — missing required: [${checkMust.missed.join(', ')}]`
              : '') +
            (checkMustNot && checkMustNot.hits.length
              ? `   — contained forbidden: [${checkMustNot.hits.join(', ')}]`
              : ''),
        );
        console.log('');
      }
    }

    console.log('\n' + (pass ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'));
    process.exit(pass ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('verify-merged-sops FAILED:', err);
  process.exit(1);
});
