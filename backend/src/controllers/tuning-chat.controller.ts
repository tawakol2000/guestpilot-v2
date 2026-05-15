/**
 * POST /api/tuning/chat — Vercel AI SDK streaming endpoint.
 *
 * Body shape (from @ai-sdk/react `useChat`):
 *   {
 *     id: string,         // a UUID from useChat — we don't use it
 *     messages: UIMessage[],
 *     body: { conversationId: string, suggestionId?: string }
 *   }
 *
 * The last message in `messages` is the new user turn. We:
 *   1. Validate the conversation belongs to the tenant.
 *   2. Persist the user message to TuningMessage.
 *   3. Open a UIMessageStream + pipe to Express response (SSE).
 *   4. Run the tuning-agent runtime, bridging SDK events into the stream.
 *   5. On finish, persist the assembled assistant message (text + data
 *      parts) to TuningMessage.
 */
import { Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from 'ai';
import { AuthenticatedRequest } from '../types';
import { runTuningAgentTurn } from '../build-tune-agent';
import crypto from 'crypto';

function extractLatestUserText(messages: UIMessage[] | undefined): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return '';
  const parts = (last as any).parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  const content = (last as any).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

export function makeTuningChatController(prisma: PrismaClient) {
  return {
    async chat(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const userId = (req as any).userId ?? null;
      const body = (req.body ?? {}) as {
        messages?: UIMessage[];
        id?: string;
        conversationId?: string;
        suggestionId?: string;
        provider?: string;
        body?: { conversationId?: string; suggestionId?: string; provider?: string };
      };

      const conversationId: string | undefined =
        body.conversationId ?? body.body?.conversationId;
      const suggestionId: string | undefined = body.suggestionId ?? body.body?.suggestionId;
      const isOpener: boolean = Boolean(
        (body as any).isOpener ?? (body as any).body?.isOpener
      );
      const rawProvider = body.provider ?? body.body?.provider;
      const providerOverride: 'anthropic' | 'openai' | null =
        rawProvider === 'openai'
          ? 'openai'
          : rawProvider === 'anthropic'
            ? 'anthropic'
            : null;

      if (!conversationId) {
        res.status(400).json({ error: 'MISSING_CONVERSATION_ID' });
        return;
      }
      const userText = extractLatestUserText(body.messages);
      if (!userText) {
        res.status(400).json({ error: 'MISSING_USER_MESSAGE' });
        return;
      }

      // Validate conversation + tenant.
      const conv = await prisma.tuningConversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { id: true },
      });
      if (!conv) {
        res.status(404).json({ error: 'CONVERSATION_NOT_FOUND' });
        return;
      }

      // Persist incoming user message (unless this is a proactive opener
      // trigger — the manager didn't type it, we don't want it to
      // rehydrate on reload or show up as a user turn in the transcript).
      //
      // Sprint 09 follow-up: if the user-message persist fails we MUST stop
      // — otherwise the assistant turn persists at onFinish with no matching
      // user turn, breaking the transcript invariant. Previously the error
      // was only console.warn'd.
      if (!isOpener) {
        try {
          await prisma.tuningMessage.create({
            data: {
              conversationId,
              role: 'user',
              parts: [
                { type: 'text', text: userText },
              ] as unknown as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          console.error('[tuning-chat] user message persist failed:', err);
          res.status(500).json({ error: 'USER_MESSAGE_PERSIST_FAILED' });
          return;
        }
      }

      const assistantMessageId = `asst:${crypto.randomBytes(8).toString('hex')}`;

      // 2026-05-15 H5: AbortController fired on client disconnect so the
      // in-flight agent call (OpenAI Responses API for now) is cancelled
      // server-side instead of running to completion and burning tokens
      // after the operator already navigated away.
      const turnAbort = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) {
          console.warn(
            `[tuning-chat] client disconnected mid-stream (conversationId=${conversationId}) — aborting agent turn.`,
          );
          turnAbort.abort();
        }
      });

      // Build UIMessageStream. `execute` is where we run the agent and emit
      // chunks into the writer. `onFinish` persists the assistant message.
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          await runTuningAgentTurn({
            prisma,
            tenantId,
            userId,
            conversationId,
            userMessage: userText,
            selectedSuggestionId: suggestionId ?? null,
            assistantMessageId,
            writer,
            providerOverride,
            signal: turnAbort.signal,
          });
        },
        onFinish: async (event) => {
          // 2026-05-15 (M5): when the client disconnected mid-stream we
          // aborted the turn. Persisting a half-streamed message here
          // would (a) leave a misleading transcript entry whose `parts`
          // are partial, and (b) bump `priorMessageCount` for the next
          // turn — racing any concurrent re-submit that the operator
          // queued after losing connection. Skip persistence on abort;
          // the user can just retry.
          if (turnAbort.signal.aborted) {
            console.warn(
              `[tuning-chat] skipping onFinish persist — turn was aborted (conversationId=${conversationId})`,
            );
            return;
          }
          try {
            const responseMessage: any = event.responseMessage;
            const parts: unknown[] = Array.isArray(responseMessage?.parts)
              ? responseMessage.parts
              : [];
            // Drop transient parts from persistence so they don't rehydrate
            // on reload. Vercel AI SDK strips these automatically, but we
            // filter defensively.
            const persistableParts = parts.filter(
              (p: any) => !p || p.transient !== true
            );
            await prisma.tuningMessage.create({
              data: {
                conversationId,
                role: 'assistant',
                parts: persistableParts as unknown as Prisma.InputJsonValue,
              },
            });
            // Touch the conversation so the history list reorders.
            await prisma.tuningConversation.update({
              where: { id: conversationId },
              data: { updatedAt: new Date() },
            });
          } catch (err) {
            console.warn('[tuning-chat] assistant message persist failed:', err);
          }
        },
        onError: (err) => {
          console.error('[tuning-chat] stream error:', err);
          // Sprint-10 follow-up: persist a stub assistant message carrying
          // the error so the reloaded transcript doesn't show an orphan
          // user message with no response. Best-effort; if this write
          // itself fails we just log — the client already got the error
          // surfaced via the AI SDK onError channel.
          const errorText = err instanceof Error ? err.message : String(err);
          prisma.tuningMessage
            .create({
              data: {
                conversationId,
                role: 'assistant',
                parts: [
                  {
                    type: 'data-agent-error',
                    id: `error:${assistantMessageId}`,
                    data: { error: errorText },
                  },
                ] as unknown as Prisma.InputJsonValue,
              },
            })
            .catch((persistErr) =>
              console.warn('[tuning-chat] error-stub persist failed:', persistErr),
            );
          return errorText;
        },
      });

      // (The disconnect handler is registered up-front so the abort fires
      // for both `execute` and `onFinish` phases.)

      pipeUIMessageStreamToResponse({
        response: res,
        stream,
      });
    },
  };
}
