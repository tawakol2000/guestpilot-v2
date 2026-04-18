import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  tenantId: string;
  tenantPlan?: string;
}

export interface JwtPayload {
  tenantId: string;
  email: string;
  plan: string;
}

export interface ImportResult {
  properties: number;
  reservations: number;
  messages: number;
}

// Hostaway API types
export interface HostawayListing {
  id: number;
  name?: string;
  internalListingName?: string;
  personCapacity?: number;
  roomType?: string;
  bedroomsNumber?: number;
  bathroomsNumber?: number;
  address?: string;
  city?: string;
  doorSecurityCode?: string;
  wifiUsername?: string;
  wifiPassword?: string;
  description?: string;
  checkInTimeStart?: number;
  checkOutTime?: number;
  houseRules?: string;
  specialInstruction?: string;
  keyPickup?: string;
  amenities?: unknown;
  airbnbListingUrl?: string;
  vrboListingUrl?: string;
  bookingEngineUrls?: unknown;
  [key: string]: unknown;
}

export interface HostawayReservation {
  id: number;
  reservationId?: number;
  guestName?: string;
  guestFirstName?: string;
  guestLastName?: string;
  guestEmail?: string;
  guestPhone?: string;
  phone?: string; // Hostaway's full reservation GET returns the phone here (not guestPhone); confirmed 2026-04-18 on an airbnbOfficial reservation.
  guestPicture?: string;
  guestCountry?: string;
  guestLocale?: string;
  guestZipCode?: string;
  guestAddress?: string;
  guestCity?: string;
  guestTrips?: number;
  guestRecommendations?: number;
  adults?: number;
  children?: number;
  infants?: number;
  pets?: number;
  totalPrice?: number;
  currency?: string;
  hostNote?: string;
  guestNote?: string;
  confirmationCode?: string;
  doorCode?: string;
  checkInTime?: number;
  checkOutTime?: number;
  nights?: number;
  arrivalDate?: string;
  departureDate?: string;
  numberOfGuests?: number;
  listingMapId?: number;
  channelId?: number;
  channelName?: string;
  status?: string;
  [key: string]: unknown;
}

export interface HostawayConversation {
  id: number;
  conversationId?: number;
  guestName?: string;
  listingMapId?: number;
  reservationId?: number;
  [key: string]: unknown;
}

export interface HostawayMessage {
  id: number;
  body?: string;
  isIncoming?: number;
  insertedOn?: string;   // Hostaway's actual timestamp field
  createdAt?: string;    // fallback
  type?: string;
  attachments?: Array<{ url: string; name?: string; mimeType?: string }>;
  imagesUrls?: string[];
  [key: string]: unknown;
}
