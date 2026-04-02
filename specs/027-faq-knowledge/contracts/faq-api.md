# API Contract: FAQ Management

## GET /api/faq

List all FAQ entries for the tenant. Supports filtering.

**Auth**: Required (JWT)

**Query params:**
- `propertyId` (optional) — filter by property. Omit for all.
- `scope` (optional) — `GLOBAL` or `PROPERTY`
- `status` (optional) — `SUGGESTED`, `ACTIVE`, `STALE`, `ARCHIVED`
- `category` (optional) — one of the 15 fixed categories

**Response 200:**
```json
{
  "entries": [
    {
      "id": "clxyz...",
      "question": "Is there a gym nearby?",
      "answer": "Yes, O1 Mall has a full gym — 1 minute walk.",
      "category": "local-recommendations",
      "scope": "PROPERTY",
      "status": "ACTIVE",
      "propertyId": "clxyz...",
      "propertyName": "Apartment 203",
      "usageCount": 12,
      "lastUsedAt": "2026-04-01T10:30:00Z",
      "source": "AUTO_SUGGESTED",
      "sourceConversationId": "clxyz...",
      "createdAt": "2026-03-15T08:00:00Z"
    }
  ],
  "total": 42,
  "categories": ["check-in-access", "local-recommendations", ...]
}
```

---

## POST /api/faq

Create a new FAQ entry (manual creation by manager).

**Request:**
```json
{
  "question": "Is there parking?",
  "answer": "Yes, underground parking in Building 8. Spot assigned on arrival.",
  "category": "parking-transportation",
  "scope": "PROPERTY",
  "propertyId": "clxyz..."
}
```

**Response 201:**
```json
{ "id": "clxyz...", "status": "ACTIVE", ... }
```

---

## PATCH /api/faq/:id

Update an FAQ entry (edit, approve, reject, toggle scope, archive).

**Request (approve suggestion):**
```json
{ "status": "ACTIVE" }
```

**Request (toggle scope):**
```json
{ "scope": "GLOBAL", "propertyId": null }
```

**Request (edit + approve):**
```json
{
  "question": "Is there parking available?",
  "answer": "Yes, underground parking in B8.",
  "status": "ACTIVE"
}
```

**Request (reject/archive):**
```json
{ "status": "ARCHIVED" }
```

**Response 200:**
```json
{ "id": "clxyz...", "status": "ACTIVE", "scope": "GLOBAL", ... }
```

---

## DELETE /api/faq/:id

Permanently delete an FAQ entry.

**Response 200:**
```json
{ "ok": true }
```

---

## GET /api/faq/categories

List all 15 fixed categories with entry counts for the tenant.

**Response 200:**
```json
{
  "categories": [
    { "id": "local-recommendations", "label": "Local Recommendations", "count": 8 },
    { "id": "check-in-access", "label": "Check-in & Access", "count": 5 },
    ...
  ]
}
```

---

## Socket.IO Event: `faq_suggestion`

Broadcast when the auto-suggest pipeline creates a new suggestion. Used to show the inline "Save as FAQ?" prompt in the chat.

```json
{
  "conversationId": "clxyz...",
  "suggestion": {
    "id": "clxyz...",
    "question": "Is there a gym nearby?",
    "answer": "Yes, O1 Mall has a full gym — 1 minute walk.",
    "category": "local-recommendations",
    "propertyId": "clxyz...",
    "propertyName": "Apartment 203"
  }
}
```
