# Sentry Integration Plan

**Status:** Deferred to beta-prep batch
**Estimated time:** 2 hours

---

## Package

```
npm install @sentry/node
```

## Setup

### 1. Init in server.ts (before app creation)

```typescript
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,  // 10% of transactions for performance monitoring
    beforeSend(event) {
      // Scrub sensitive data
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
      }
      return event;
    },
  });
  console.log('[Sentry] Initialized');
}
```

### 2. Express middleware in app.ts

```typescript
// After all routes, before error handler:
Sentry.setupExpressErrorHandler(app);
```

### 3. Request context enrichment

Add Sentry middleware early in the stack to tag every request:

```typescript
app.use((req, res, next) => {
  const tenantId = (req as any).tenantId;
  if (tenantId) {
    Sentry.setTag('tenantId', tenantId);
  }
  next();
});
```

## Key captures

| Source | What to capture | Extra tags |
|---|---|---|
| Express error handler | All unhandled errors | `tenantId`, route path |
| messages.controller.ts | Hostaway send failures (deliveryStatus='failed') | `tenantId`, `conversationId`, `deliveryError` |
| ai.service.ts | AI pipeline failures, tool use errors | `tenantId`, `conversationId`, `model`, `agentName` |
| webhooks.controller.ts | Webhook processing errors | `tenantId`, webhook event type |
| hostaway.service.ts | Retry exhaustion (3x failed) | `tenantId`, HTTP status, error code |
| debounce.service.ts | Working hours timezone parse failures | `tenantId`, timezone string |

## Privacy: fields to scrub

Before any event is sent to Sentry:

- `passwordHash` — never include
- `Authorization` header (contains JWT) — strip from request headers
- `hostawayApiKey` — strip from breadcrumbs/context
- `dashboardJwt` — strip from breadcrumbs/context
- `VAPID_PRIVATE_KEY` — should never appear, but scrub if found
- Guest PII (email, phone, nationality) — strip from error context

Use `beforeSend` hook to filter these patterns.

## Environment variables

```
SENTRY_DSN=https://xxx@o123.ingest.sentry.io/456
```

- Store in Railway env vars
- Free Sentry account (developer plan) is sufficient for current scale
- Graceful no-op if `SENTRY_DSN` not set (same pattern as Langfuse/Redis)

## Source maps

Add `--sourcemap` to the build step for meaningful stack traces in production:

```json
"build": "prisma generate && tsc --sourcemap && cp -r src/config dist/"
```

Upload source maps to Sentry via `@sentry/cli` in CI/CD or Railway build step.

## Not included in this plan

- Performance monitoring (traces) — only errors for now
- Cron monitoring — Railway handles restarts
- User feedback widget — backend only, no UI
- Release tracking — add later when CI/CD is formalized
