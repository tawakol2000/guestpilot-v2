import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import { classifyEditCategory, expandToFullCategories } from '../src/services/tuning/category-pre-classifier.service';
import { probeRecentHighCooldownAcceptance } from '../src/services/tuning/suggestion-writer.service';
import { semanticSimilarity } from '../src/services/tuning/diff.service';

const prisma = new PrismaClient();

const ORIGINAL = "Thanks, Mohmoud — and who will be joining you for the 3 guests? Also please confirm your nationality so I can check eligibility.";
const EDITED   = "Thanks, Mohmoud — and who will be joining you for the 3 guests? Also please confirm your nationality.";
const TENANT_ID = 'cmoaaynmt00001mjy7zqnb8pz';

async function main() {
  const sim = semanticSimilarity(ORIGINAL, EDITED);
  const result = await classifyEditCategory({
    originalText: ORIGINAL,
    editedText: EDITED,
    similarity: sim,
    channel: 'AIRBNB',
    reservationStatus: 'INQUIRY',
  });

  console.log('Classifier:', result?.category, 'conf:', result?.confidence.toFixed(2));
  console.log('Rationale:', result?.rationale);

  if (!result) return;

  // Decision tree exactly as the controllers run it:
  if (result.category === 'NO_FIX' && result.confidence >= 0.7) {
    console.log('\n→ SKIPPED (NO_FIX high confidence)');
    return;
  }
  if (result.category !== 'NO_FIX' && result.confidence >= 0.6) {
    const scope = expandToFullCategories(result.category);
    console.log('\nScoped cooldown probe on:', scope);
    const probe = await probeRecentHighCooldownAcceptance(prisma, TENANT_ID, scope);
    if (probe) {
      console.log(`→ COOLDOWN HIT: ${probe.category}/${probe.targetLabel} accepted ${probe.appliedAt.toISOString()}`);
      console.log('→ SKIPPED — would have run diagnostic and been dropped by 48h cooldown.');
    } else {
      console.log('→ No cooldown hit in', result.category, 'scope. Full diagnostic would run.');
    }
  } else {
    console.log('\n→ Low confidence (<0.6) → full diagnostic runs.');
  }

  // For comparison: show what the OLD (similarity-only) gate would have done.
  console.log('\n— Old gate comparison —');
  if (sim >= 0.5) {
    const probeWide = await probeRecentHighCooldownAcceptance(prisma, TENANT_ID);
    console.log(`Old gate (similarity ${sim.toFixed(2)} ≥ 0.5):`,
      probeWide ? `would SKIP (recent ${probeWide.category}/${probeWide.targetLabel})` : 'full diagnostic runs');
  } else {
    console.log(`Old gate: similarity ${sim.toFixed(2)} < 0.5 → full diagnostic always runs.`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
