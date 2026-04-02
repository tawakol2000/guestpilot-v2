/**
 * Fixed FAQ categories for the FAQ Knowledge System.
 * 15 categories covering 95% of serviced apartment guest questions.
 * These are constants — not DB-configurable — for consistent classification and analytics.
 */

export const FAQ_CATEGORIES = [
  'check-in-access',
  'check-out-departure',
  'wifi-technology',
  'kitchen-cooking',
  'appliances-equipment',
  'house-rules',
  'parking-transportation',
  'local-recommendations',
  'attractions-activities',
  'cleaning-housekeeping',
  'safety-emergencies',
  'booking-reservation',
  'payment-billing',
  'amenities-supplies',
  'property-neighborhood',
] as const;

export type FaqCategory = typeof FAQ_CATEGORIES[number];

export const FAQ_CATEGORY_LABELS: Record<FaqCategory, string> = {
  'check-in-access': 'Check-in & Access',
  'check-out-departure': 'Check-out & Departure',
  'wifi-technology': 'WiFi & Technology',
  'kitchen-cooking': 'Kitchen & Cooking',
  'appliances-equipment': 'Appliances & Equipment',
  'house-rules': 'House Rules & Policies',
  'parking-transportation': 'Parking & Transportation',
  'local-recommendations': 'Local Recommendations',
  'attractions-activities': 'Attractions & Activities',
  'cleaning-housekeeping': 'Cleaning & Housekeeping',
  'safety-emergencies': 'Safety & Emergencies',
  'booking-reservation': 'Booking & Reservation',
  'payment-billing': 'Payment & Billing',
  'amenities-supplies': 'Amenities & Supplies',
  'property-neighborhood': 'Property & Neighborhood',
};
