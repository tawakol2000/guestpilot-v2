import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';
import { makePropertiesController } from '../controllers/properties.controller';
import { AuthenticatedRequest } from '../types';
import * as hostawayService from '../services/hostaway.service';
import { ingestPropertyKnowledge } from '../services/rag.service';

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

      // Update property in DB
      const updated = await prisma.property.update({
        where: { id: propertyId },
        data: {
          name,
          address,
          listingDescription: listing.description || property.listingDescription,
          customKnowledgeBase: kb,
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
