# API Endpoints: SOP Management

## New Endpoints

### GET /api/knowledge/sop-definitions

Returns all SOP definitions for the tenant with their variants and property overrides.

**Response**:
```json
{
  "definitions": [
    {
      "id": "uuid",
      "category": "sop-amenity-request",
      "toolDescription": "Requesting supplies or asking what amenities are available...",
      "enabled": true,
      "variants": [
        { "id": "uuid", "status": "DEFAULT", "content": "Guest requests amenities...", "enabled": true },
        { "id": "uuid", "status": "INQUIRY", "content": "Confirm availability only...", "enabled": true },
        { "id": "uuid", "status": "CHECKED_IN", "content": "Ask for delivery time...", "enabled": true }
      ],
      "hasCustomVariants": true
    }
  ],
  "properties": [
    { "id": "uuid", "name": "Apartment 101", "address": "..." }
  ]
}
```

### PUT /api/knowledge/sop-definitions/:id

Update an SOP definition (tool description, enabled state).

**Request**:
```json
{
  "toolDescription": "Updated description...",
  "enabled": true
}
```

### PUT /api/knowledge/sop-variants/:id

Update a variant's content or enabled state.

**Request**:
```json
{
  "content": "Updated procedure text...",
  "enabled": true
}
```

### POST /api/knowledge/sop-variants

Create a new variant for an SOP.

**Request**:
```json
{
  "sopDefinitionId": "uuid",
  "status": "INQUIRY",
  "content": "Procedure text for INQUIRY guests..."
}
```

### DELETE /api/knowledge/sop-variants/:id

Delete a variant (revert to using DEFAULT for that status).

### GET /api/knowledge/sop-property-overrides?propertyId=xxx

Get property-level overrides for a specific property.

### POST /api/knowledge/sop-property-overrides

Create a property override.

**Request**:
```json
{
  "sopDefinitionId": "uuid",
  "propertyId": "uuid",
  "status": "CHECKED_IN",
  "content": "Property-specific procedure..."
}
```

### POST /api/knowledge/sop-definitions/seed

Seed default SOP definitions for the tenant. Called automatically on first access, or manually via UI.

## Modified Endpoints

### GET /api/knowledge/sop-data (replaced)

The existing endpoint is replaced by the more comprehensive `sop-definitions` endpoint above.
