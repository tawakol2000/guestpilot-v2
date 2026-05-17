import * as dotenv from 'dotenv';
dotenv.config();
import { classifyEditCategory } from '../src/services/tuning/category-pre-classifier.service';
import { semanticSimilarity } from '../src/services/tuning/diff.service';

const SAMPLES = [
  {
    label: 'Capitalization-only polish',
    original: "you're welcome — let me know if anything else comes up during your stay.",
    edited: "You're welcome — let me know if anything else comes up during your stay.",
    expected: 'NO_FIX',
  },
  {
    label: 'WiFi: AI didn\'t know → manager supplied credentials',
    original: "I'm sorry, I don't have that information. The host should be able to share the WiFi password with you directly — I'll let them know.",
    edited: "Hey! The WiFi is 'SunsetLofts-3B' and the password is 'welcome2024'. It's also on the back of the router in the living room.",
    expected: 'FAQ or SOP (real factual gap)',
  },
  {
    label: 'Early check-in: time + price + currency all wrong',
    original: "I'm sorry, our standard check-in starts at 2 PM. We can offer paid early check-in at $25 per hour before 3 PM — would you like me to set that up?",
    edited: "Hi! 11am works — there's a £30 early check-in fee. Want me to confirm and send the payment link?",
    expected: 'SOP (SOP_CONTENT — wrong policy)',
  },
  {
    label: 'Wrong-topic SOP fetched (check-in instead of parking)',
    original: "Standard check-in is at 2 PM. We'll send you the door code an hour before. Looking forward to having you!",
    edited: "Parking is in the underground garage — entrance on Sunset Way. Use bay 12 marked '3B'. The gate code is 4827.",
    expected: 'SOP (SOP_ROUTING — wrong SOP fetched)',
  },
];

async function main() {
  for (const s of SAMPLES) {
    const sim = semanticSimilarity(s.original, s.edited);
    console.log('═'.repeat(80));
    console.log(`SAMPLE: ${s.label}`);
    console.log(`Similarity: ${sim.toFixed(2)}   Expected: ${s.expected}`);
    console.log(`ORIGINAL: ${s.original}`);
    console.log(`EDITED  : ${s.edited}`);

    const t0 = Date.now();
    const result = await classifyEditCategory({
      originalText: s.original,
      editedText: s.edited,
      similarity: sim,
      channel: 'AIRBNB',
    });
    const wall = Date.now() - t0;

    if (!result) {
      console.log('→ CLASSIFIER returned null (api key missing or error)');
      continue;
    }
    console.log(`→ ${result.category} (conf=${result.confidence.toFixed(2)}, ${result.latencyMs}ms model / ${wall}ms wall, model=${result.modelUsed})`);
    console.log(`  ${result.rationale}`);

    // Decision: would the controller skip the full diagnostic?
    if (result.category === 'NO_FIX' && result.confidence >= 0.7) {
      console.log('  → DECISION: SKIP DIAGNOSTIC (NO_FIX high confidence). Saves ~$0.21 + ~120s.');
    } else if (result.category !== 'NO_FIX' && result.confidence >= 0.6) {
      console.log(`  → DECISION: would run cooldown probe on ${result.category}, then full diagnostic if no recent hit.`);
    } else {
      console.log('  → DECISION: low confidence — full diagnostic runs.');
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
