/**
 * Feature 041 sprint 03 — TOOL_CONFIG accept dispatch.
 *
 *   POST /api/tuning-suggestions/:id/accept-tool-config
 *
 * The legacy `/accept` handler cannot update a `ToolDefinition` because
 * `TuningActionType` has no TOOL_CONFIG enum value (sprint-02 maps it to the
 * least-wrong legacy value `EDIT_SYSTEM_PROMPT`, which expects a
 * `systemPromptVariant` and 400s on tool-config rows). This endpoint is the
 * correct path for the `diagnosticCategory === 'TOOL_CONFIG'` dispatch.
 *
 * Contract (additive, no schema change):
 *   body: {
 *     toolDefinitionId: string,           // required — manager picks in UI
 *     editedDescription?: string,         // if present, used verbatim
 *     applyMode?: 'IMMEDIATE' | 'QUEUED',
 *     editedFromOriginal?: boolean        // triggers PreferencePair write
 *   }
 */

import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../types';
import { broadcastCritical } from '../services/socket.service';
import { updateCategoryStatsOnAccept } from '../services/tuning/category-stats.service';
import { recordPreferencePair } from '../services/tuning/preference-pair.service';

export function makeTuningToolConfigController(prisma: PrismaClient) {
  return {
    async accept(req: AuthenticatedRequest, res: Response): Promise<void> {
      const { tenantId } = req;
      const { id } = req.params;
      const userId = (req as any).userId ?? null;
      const body = req.body || {};

      try {
        const suggestion = await prisma.tuningSuggestion.findFirst({
          where: { id, tenantId },
        });
        if (!suggestion) {
          res.status(404).json({ error: 'SUGGESTION_NOT_FOUND' });
          return;
        }
        if (suggestion.status !== 'PENDING') {
          res.status(409).json({ error: 'SUGGESTION_NOT_PENDING' });
          return;
        }
        // Defensive: enforce that the accept-tool-config endpoint only runs for
        // rows tagged TOOL_CONFIG. Legacy rows (null diagnosticCategory) can
        // still be force-routed here, but refuse any other explicit category.
        if (
          suggestion.diagnosticCategory &&
          suggestion.diagnosticCategory !== 'TOOL_CONFIG'
        ) {
          res.status(409).json({ error: 'CATEGORY_MISMATCH' });
          return;
        }

        const toolDefinitionId =
          typeof body.toolDefinitionId === 'string' ? body.toolDefinitionId : null;
        if (!toolDefinitionId) {
          res.status(400).json({ error: 'MISSING_TOOL_DEFINITION_ID' });
          return;
        }

        const tool = await prisma.toolDefinition.findFirst({
          where: { id: toolDefinitionId, tenantId },
        });
        if (!tool) {
          res.status(404).json({ error: 'TOOL_DEFINITION_NOT_FOUND' });
          return;
        }

        const finalDescription: string =
          (typeof body.editedDescription === 'string' && body.editedDescription) ||
          suggestion.proposedText ||
          tool.description;
        if (!finalDescription) {
          res.status(400).json({ error: 'MISSING_DESCRIPTION' });
          return;
        }

        const beforeDescription = tool.description;

        await prisma.toolDefinition.update({
          where: { id: tool.id },
          data: { description: finalDescription },
        });

        const applyMode: 'IMMEDIATE' | 'QUEUED' =
          body.applyMode === 'QUEUED' ? 'QUEUED' : 'IMMEDIATE';

        const updated = await prisma.tuningSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: 'ACCEPTED',
            appliedAt: new Date(),
            appliedPayload: {
              toolDefinitionId: tool.id,
              toolName: tool.name,
              before: beforeDescription,
              after: finalDescription,
            } as any,
            appliedByUserId: userId,
            applyMode,
          },
        });

        await updateCategoryStatsOnAccept(prisma, tenantId, updated.diagnosticCategory);

        if (body.editedFromOriginal === true && suggestion.proposedText && finalDescription !== suggestion.proposedText) {
          await recordPreferencePair(prisma, {
            tenantId,
            suggestionId: suggestion.id,
            category: updated.diagnosticCategory,
            before: beforeDescription,
            rejectedProposal: suggestion.proposedText,
            preferredFinal: finalDescription,
          }).catch((err) =>
            console.error('[preference-pair] tool-config write failed:', err),
          );
        }

        broadcastCritical(tenantId, 'tuning_suggestion_updated', {
          suggestionId: updated.id,
          status: 'ACCEPTED',
          appliedByUserId: userId,
          applyMode,
        });

        res.json({
          ok: true,
          suggestion: updated,
          targetUpdated: { kind: 'tool_definition', id: tool.id },
        });
      } catch (err) {
        console.error(`[tuning-tool-config] [${id}] accept failed:`, err);
        res.status(500).json({
          error: 'INTERNAL_ERROR',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
