import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';
import { authMiddleware } from '../middleware/auth';
import { makePropertiesController } from '../controllers/properties.controller';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { ingestPropertyKnowledge } from '../services/rag.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SUMMARIZE_INSTRUCTIONS = 'Summarize this property listing into a concise, factual paragraph (~100 words) for an AI assistant. Keep: location, nearby landmarks, transport, key features, capacity. Remove: marketing language, superlatives, booking calls-to-action.';

/**
 * Summarize a property's listingDescription using GPT-5.4 Mini.
 * Saves the result to customKnowledgeBase.summarizedDescription and
 * preserves the original in customKnowledgeBase.originalDescription.
 * Returns the summary string, or null if no description available.
 */
async function summarizeProperty(
  prisma: PrismaClient,
  propertyId: string,
  tenantId: string,
): Promise<{ summary: string; propertyName: string } | null> {
  const property = await prisma.property.findFirst({
    where: { id: propertyId, tenantId },
  });
  if (!property) return null;

  const description = property.listingDescription;
  if (!description || !description.trim()) return null;

  const response = await (openai.responses as any).create({
    model: 'gpt-5.4-mini-2026-03-17',
    max_output_tokens: 300,
    instructions: SUMMARIZE_INSTRUCTIONS,
    input: description,
    reasoning: { effort: 'none' },
    store: true,
  });

  const summary: string = response.output_text || '';
  if (!summary) return null;

  // Read existing KB to merge (don't overwrite other fields)
  const existingKb = (property.customKnowledgeBase as Record<string, unknown>) || {};
  const updatedKb: Record<string, unknown> = {
    ...existingKb,
    summarizedDescription: summary,
  };
  // Preserve original description on first summarize
  if (!existingKb.originalDescription) {
    updatedKb.originalDescription = description;
  }

  await prisma.property.update({
    where: { id: propertyId },
    data: { customKnowledgeBase: updatedKb as never },
  });

  console.log(`[Properties] Summarized description for ${property.name} (${propertyId})`);
  return { summary, propertyName: property.name };
}

function formatHour(h: number | undefined): string {
  if (h === undefined || h === null) return '';
  if (h === 0) return '12:00 AM';
  if (h === 12) return '12:00 PM';
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

export function propertiesRouter(prisma: PrismaClient): Router {
  const router = Router();
  const ctrl = makePropertiesController(prisma);

  router.use(authMiddleware as unknown as RequestHandler);

  router.get('/', ((req, res) => ctrl.list(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/ai-status', ((req, res) => ctrl.listWithAiStatus(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.get('/:id', ((req, res) => ctrl.get(req as unknown as AuthenticatedRequest, res)) as RequestHandler);
  router.put('/:id/knowledge-base', ((req, res) => ctrl.updateKnowledgeBase(req as unknown as AuthenticatedRequest, res)) as RequestHandler);

  // POST /api/properties/summarize-all — batch summarize all tenant property descriptions (T009)
  router.post('/summarize-all', (async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;

      const properties = await prisma.property.findMany({
        where: { tenantId, listingDescription: { not: '' } },
        select: { id: true, name: true, listingDescription: true },
      });

      // Filter out properties with null/empty descriptions
      const withDescription = properties.filter(p => p.listingDescription && p.listingDescription.trim());
      if (withDescription.length === 0) {
        res.json({ count: 0, results: [] });
        return;
      }

      const results: Array<{ id: string; name: string; summary: string }> = [];
      for (const prop of withDescription) {
        try {
          const result = await summarizeProperty(prisma, prop.id, tenantId);
          if (result) {
            results.push({ id: prop.id, name: result.propertyName, summary: result.summary });
          }
        } catch (err) {
          console.warn(`[Properties] Summarize failed for ${prop.name} (${prop.id}):`, err);
          // Continue with next property — don't fail the whole batch
        }
      }

      console.log(`[Properties] Batch summarized ${results.length}/${withDescription.length} properties for tenant ${tenantId}`);
      res.json({ count: results.length, results });
    } catch (err) {
      console.error('[Properties] Batch summarize failed:', err);
      res.status(500).json({ error: 'Batch summarization failed' });
    }
  }) as RequestHandler);

  // POST /api/properties/:id/summarize — summarize a single property description (T008)
  router.post('/:id/summarize', (async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const propertyId = req.params.id as string;

      const property = await prisma.property.findFirst({
        where: { id: propertyId, tenantId },
        select: { id: true, listingDescription: true },
      });
      if (!property) {
        res.status(404).json({ error: 'Property not found' });
        return;
      }
      if (!property.listingDescription || !property.listingDescription.trim()) {
        res.status(400).json({ error: 'No description to summarize' });
        return;
      }

      const result = await summarizeProperty(prisma, propertyId, tenantId);
      if (!result) {
        res.status(500).json({ error: 'Summarization returned no result' });
        return;
      }

      res.json({ summary: result.summary });
    } catch (err) {
      console.error('[Properties] Summarize failed:', err);
      res.status(500).json({ error: 'Summarization failed' });
    }
  }) as RequestHandler);

  // POST /api/properties/:id/resync — fetch fresh listing from Hostaway, update DB, rebuild RAG chunks
  router.post('/:id/resync', (async (req: any, res) => {
    try {
      const tenantId = req.tenantId as string;
      const propertyId = req.params.id as string;

      const property = await prisma.property.findFirst({ where: { id: propertyId, tenantId } });
      if (!property) { res.status(404).json({ error: 'Property not found' }); return; }

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant?.hostawayAccountId || !tenant?.hostawayApiKey) {
        res.status(400).json({ error: 'Hostaway credentials not configured' });
        return;
      }

      // Fetch fresh listing from Hostaway
      const { result: listing } = await hostawayService.getListing(
        tenant.hostawayAccountId, tenant.hostawayApiKey, property.hostawayListingId
      );

      // Build updated customKnowledgeBase
      const kb: Record<string, string | number> = {};
      if (listing.internalListingName) kb.internalListingName = listing.internalListingName;
      if (listing.personCapacity) kb.personCapacity = listing.personCapacity;
      if (listing.roomType) kb.roomType = listing.roomType;
      if (listing.bedroomsNumber) kb.bedroomsNumber = listing.bedroomsNumber;
      if (listing.bathroomsNumber) kb.bathroomsNumber = listing.bathroomsNumber;
      if (listing.doorSecurityCode) kb.doorCode = listing.doorSecurityCode;
      if (listing.wifiUsername) kb.wifiName = listing.wifiUsername;
      if (listing.wifiPassword) kb.wifiPassword = listing.wifiPassword;
      if (listing.checkInTimeStart !== undefined) kb.checkInTime = formatHour(listing.checkInTimeStart);
      if (listing.checkOutTime !== undefined) kb.checkOutTime = formatHour(listing.checkOutTime);
      if (listing.houseRules) kb.houseRules = listing.houseRules;
      if (listing.specialInstruction) kb.specialInstruction = listing.specialInstruction;
      if (listing.keyPickup) kb.keyPickup = listing.keyPickup;
      // Amenities: Hostaway returns as array of objects or strings
      const rawAmenities = listing.amenities ?? (listing as any).listingAmenities;
      if (rawAmenities) {
        if (Array.isArray(rawAmenities)) {
          const names = rawAmenities.map((a: any) => typeof a === 'string' ? a : (a.amenityName || a.name || a.title || JSON.stringify(a))).filter(Boolean);
          if (names.length > 0) kb.amenities = names.join(', ');
        } else {
          kb.amenities = String(rawAmenities);
        }
      }
      // Listing URLs for cross-sell property suggestions
      if (listing.airbnbListingUrl) kb.airbnbListingUrl = String(listing.airbnbListingUrl);
      if (listing.vrboListingUrl) kb.vrboListingUrl = String(listing.vrboListingUrl);
      if (listing.bookingEngineUrls) {
        const urls = Array.isArray(listing.bookingEngineUrls) ? listing.bookingEngineUrls : [];
        if (urls.length > 0) kb.bookingEngineUrl = String(urls[0]);
      }
      if (listing.cleaningFee) kb.cleaningFee = String(listing.cleaningFee);
      if (listing.squareMeters) kb.squareMeters = String(listing.squareMeters);
      if (listing.bedTypes) kb.bedTypes = Array.isArray(listing.bedTypes) ? (listing.bedTypes as string[]).join(', ') : String(listing.bedTypes);

      const name = listing.internalListingName || listing.name || property.name;
      const address = [listing.address, listing.city].filter(Boolean).join(', ') || property.address;

      // Merge Hostaway KB into existing KB, preserving user-managed keys
      const USER_MANAGED_KEYS = ['amenityClassifications', 'summarizedDescription', 'originalDescription', 'variableOverrides'];
      const existingKb = (property.customKnowledgeBase as Record<string, unknown>) || {};
      const mergedKb: Record<string, unknown> = { ...kb };
      for (const key of USER_MANAGED_KEYS) {
        if (existingKb[key] !== undefined) mergedKb[key] = existingKb[key];
      }

      // Update property in DB
      const updated = await prisma.property.update({
        where: { id: propertyId },
        data: {
          name,
          address,
          listingDescription: listing.description || property.listingDescription,
          customKnowledgeBase: mergedKb as never,
        },
      });

      // Rebuild RAG chunks (property-info + property-description, preserves learned-answers)
      const chunks = await ingestPropertyKnowledge(tenantId, propertyId, updated, prisma);

      res.json({
        ok: true,
        chunks,
        property: {
          id: updated.id,
          name: updated.name,
          address: updated.address,
          listingDescription: updated.listingDescription,
          customKnowledgeBase: updated.customKnowledgeBase,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (err) {
      console.error('[Properties] Resync failed:', err);
      res.status(500).json({ error: 'Resync failed' });
    }
  }) as RequestHandler);

  return router;
}
