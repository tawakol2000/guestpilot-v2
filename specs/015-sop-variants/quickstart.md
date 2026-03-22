# Quickstart: Status-Aware SOP Variants

## Scenario 1: Status-Aware Response — Amenity Request

**INQUIRY guest**: "Do you have a pool?"
1. AI classifies → `sop-amenity-request`
2. App calls `getSopContent(tenantId, 'sop-amenity-request', 'INQUIRY', propertyId)`
3. Returns INQUIRY variant: "Confirm whether the amenity exists. Don't discuss delivery."
4. AI responds: "Yes, we have a shared pool at the compound. Would you like to book?"

**CHECKED_IN guest**: "Can I get extra towels?"
1. AI classifies → `sop-amenity-request`
2. App calls `getSopContent(tenantId, 'sop-amenity-request', 'CHECKED_IN', propertyId)`
3. Returns CHECKED_IN variant: "Ask for preferred delivery time during working hours 10am-5pm."
4. AI responds: "Of course! When would you like them delivered? We're available between 10am and 5pm."

## Scenario 2: Operator Edits SOP Content

1. Operator opens SOP Management page
2. Finds "sop-amenity-request" row
3. Clicks "CHECKED_IN" tab in the content area
4. Edits text: adds "Maximum 2 extra towels per request"
5. Clicks Save
6. Next CHECKED_IN guest asking for towels sees the updated procedure

## Scenario 3: Operator Edits Tool Description

1. Operator opens SOP page, finds "sop-maintenance"
2. Edits tool description: adds "Including pest control requests"
3. Saves
4. Tool schema cache invalidates for this tenant
5. Next message: AI classification uses updated description → "there are ants in the kitchen" correctly routes to maintenance

## Scenario 4: Property Override

1. Operator selects "Apartment 101" from property dropdown
2. Sees global SOPs with "(Global)" badge
3. Clicks "Add Override" on sop-cleaning for CHECKED_IN
4. Writes: "Cleaning is FREE for this property (premium unit)."
5. Saves
6. Guests at Apartment 101 get free cleaning; guests at other properties still see $20 fee

## Scenario 5: Disable a Variant

1. Operator opens SOP page
2. Finds sop-early-checkin INQUIRY variant (currently: "Not applicable")
3. Toggles it OFF
4. INQUIRY guests asking about early check-in → system falls back to DEFAULT variant
5. DEFAULT says: "Standard check-in is 3PM..."

## Scenario 6: New Tenant — Automatic Seeding

1. New tenant signs up
2. First API call to get SOP data → no SopDefinition records found
3. System automatically seeds 22 SopDefinition records with:
   - Tool descriptions from hardcoded defaults
   - DEFAULT variants with current SOP content
   - 8 SOPs get additional status variants
4. Tenant sees fully populated SOP page immediately
