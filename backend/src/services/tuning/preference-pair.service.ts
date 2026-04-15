/**
 * Feature 041 sprint 03 — first caller of the D2 pre-wire `PreferencePair`
 * table. Writes a single (context, rejected proposal, preferred final) row.
 *
 * V1 never reads these rows; they are feed for a future DPO pipeline (see
 * deferred.md D2). Failures must not block the accept flow.
 */

import { PrismaClient, TuningDiagnosticCategory } from '@prisma/client';

export interface PreferencePairInput {
  tenantId: string;
  suggestionId: string;
  category: TuningDiagnosticCategory | null;
  before: string | null;
  rejectedProposal: string;
  preferredFinal: string;
}

export async function recordPreferencePair(
  prisma: PrismaClient,
  input: PreferencePairInput,
): Promise<void> {
  await prisma.preferencePair.create({
    data: {
      tenantId: input.tenantId,
      context: {
        suggestionId: input.suggestionId,
        before: input.before,
      } as any,
      rejectedSuggestion: { text: input.rejectedProposal } as any,
      preferredFinal: { text: input.preferredFinal } as any,
      category: input.category ?? null,
    },
  });
}
