/**
 * studio_propose_transition — Sprint 060-C.
 *
 * Agent-proposed, host-confirmed inner-state transition. The tool itself
 * mutates nothing on the agent's behalf; it stages a pending proposal in
 * TuningConversation.stateMachineSnapshot and emits a question_choices
 * card so the operator can confirm via UI button. The DB inner_state
 * does NOT change until POST /tuning/conversations/:id/transitions/:nonce/
 * confirm fires.
 *
 * Verifying state auto-exits to drafting via runtime turn-end hook —
 * the agent must NOT call propose_transition to leave verifying.
 */
import { z } from 'zod/v4';
import type { tool as ToolFactory } from '@anthropic-ai/claude-agent-sdk';
import { startAiSpan } from '../../services/observability.service';
import { asCallToolResult, asError, type ToolContext } from './types';
import { mintTransitionNonce } from './lib/transition-nonce';
import {
  coerceSnapshot,
  TRANSITION_EXPIRY_MS,
  type InnerState,
  type PendingTransition,
} from '../state-machine';
import { DATA_PART_TYPES, type QuestionChoicesData } from '../data-parts';

const DESCRIPTION = `Propose a transition to a new inner cognitive state. Returns a server-generated nonce; the state does NOT change until the user confirms via UI.

Use cases:
- In scoping, after gathering enough evidence to draft: propose drafting.
- In drafting, after writing an artifact: propose verifying.
- In drafting or verifying, if you need more info: propose scoping.

Verifying state auto-exits back to drafting when test_pipeline returns; do NOT call this to leave verifying.

Examples:
  studio_propose_transition({to: "drafting", because: "checkin slot confirmed; ready to draft early-checkin SOP"})
  studio_propose_transition({to: "verifying", because: "early-checkin SOP written; test against 3 trigger phrasings"})
  studio_propose_transition({to: "scoping", because: "test failed on framed phrasing; need clarification on weekend rule"})`;

export function buildProposeTransitionTool(
  tool: typeof ToolFactory,
  ctx: () => ToolContext,
) {
  return tool(
    'studio_propose_transition',
    DESCRIPTION,
    {
      to: z.enum(['scoping', 'drafting', 'verifying']),
      because: z.string().min(15).max(280),
    },
    async (args) => {
      const c = ctx();
      const span = startAiSpan('build-tune-agent.studio_propose_transition', {
        to: args.to,
      });
      try {
        if (!c.conversationId) {
          span.end({ error: 'no_conversation' });
          return asError('studio_propose_transition requires a TuningConversation context.');
        }

        const conv = await c.prisma.tuningConversation.findFirst({
          where: { id: c.conversationId, tenantId: c.tenantId },
          select: { id: true, stateMachineSnapshot: true },
        });
        if (!conv) {
          span.end({ error: 'conversation_not_found' });
          return asError('TuningConversation not found.');
        }

        const snapshot = coerceSnapshot(conv.stateMachineSnapshot);
        const currentState: InnerState = snapshot.inner_state;

        if (currentState === 'verifying') {
          span.end({ error: 'verifying_auto_exit_only' });
          return asError(
            'Verifying state auto-exits to drafting after studio_test_pipeline returns. Do not propose a transition out of verifying — run the test instead, or wait for the runtime to flip the state.',
          );
        }

        if (args.to === currentState) {
          span.end({ error: 'no_op' });
          return asError(`Already in ${currentState} state. propose_transition is a no-op.`);
        }

        const now = new Date();
        const nonce = mintTransitionNonce();
        const pending: PendingTransition = {
          to: args.to,
          because: args.because,
          proposed_at: now.toISOString(),
          expires_at: new Date(now.getTime() + TRANSITION_EXPIRY_MS).toISOString(),
          token: nonce,
        };

        await c.prisma.tuningConversation.update({
          where: { id: c.conversationId },
          data: {
            stateMachineSnapshot: {
              ...snapshot,
              pending_transition: pending,
            } as unknown as object,
          },
        });

        // Emit a question_choices card with the transition_proposal
        // discriminator. The frontend renders this as a transition-
        // proposal card with confirm/reject buttons wired to the
        // /transitions/:nonce/(confirm|reject) endpoints.
        if (c.emitDataPart) {
          const card: QuestionChoicesData & {
            kind: 'transition_proposal';
            proposed_state: InnerState;
            current_state: InnerState;
            because: string;
            nonce: string;
          } = {
            kind: 'transition_proposal',
            current_state: currentState,
            proposed_state: args.to,
            because: args.because,
            nonce,
            question: `Move from ${currentState} to ${args.to}?`,
            options: [
              { id: 'confirm', label: `Confirm transition to ${args.to}`, recommended: true },
              { id: 'reject', label: `Keep ${currentState}` },
            ],
            allowCustomInput: false,
          };
          c.emitDataPart({
            type: DATA_PART_TYPES.question_choices,
            id: `transition-proposal:${c.conversationId}:${nonce}`,
            data: card,
          });
        }

        span.end({ to: args.to });
        return asCallToolResult({
          proposed: true,
          nonce,
          current_state: currentState,
          proposed_state: args.to,
          expires_at: pending.expires_at,
          note: 'State does NOT change until the operator confirms via UI. Continue with read-only work or wait for the next turn.',
        });
      } catch (err: any) {
        span.end({ error: String(err) });
        return asError(`studio_propose_transition failed: ${err?.message ?? String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}
