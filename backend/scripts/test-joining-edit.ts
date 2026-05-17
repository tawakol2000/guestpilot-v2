import * as dotenv from 'dotenv';
dotenv.config();
import { classifyEditCategory } from '../src/services/tuning/category-pre-classifier.service';
import { semanticSimilarity } from '../src/services/tuning/diff.service';

const ORIGINAL = "Thanks, Mohmoud — and who will be joining you for the 3 guests? Also please confirm your nationality so I can check eligibility.";
const EDITED   = "Thanks, Mohmoud — and who will be joining you for the 3 guests? Also please confirm your nationality.";

async function main() {
  const sim = semanticSimilarity(ORIGINAL, EDITED);
  console.log('Message: cmp9op2tb000jbt9wnyet5kls (2026-05-17T11:21:27)');
  console.log('Similarity:', sim.toFixed(2));
  console.log('ORIGINAL:', ORIGINAL);
  console.log('EDITED  :', EDITED);

  const t0 = Date.now();
  const result = await classifyEditCategory({
    originalText: ORIGINAL,
    editedText: EDITED,
    similarity: sim,
    channel: 'AIRBNB',
    reservationStatus: 'INQUIRY',
  });
  const wall = Date.now() - t0;

  if (!result) {
    console.log('classifier returned null');
    return;
  }
  console.log(`\n→ ${result.category} (conf=${result.confidence.toFixed(2)}, ${result.latencyMs}ms model / ${wall}ms wall)`);
  console.log(`  ${result.rationale}`);

  if (result.category === 'NO_FIX' && result.confidence >= 0.7) {
    console.log('  → DECISION: SKIP diagnostic. Saves ~$0.21 + ~120s.');
  } else if (result.category !== 'NO_FIX' && result.confidence >= 0.6) {
    console.log(`  → DECISION: scoped cooldown probe on ${result.category}, then full diagnostic if no hit.`);
  } else {
    console.log('  → DECISION: low confidence — full diagnostic runs.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
