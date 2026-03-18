# New Middleware Contracts

## Rate Limit Middleware (`middleware/rate-limit.ts`)

### loginLimiter
- **Applies to**: `POST /auth/login`
- **Window**: 60 seconds
- **Limit**: 5 requests per IP
- **Behavior**: Only count failed requests (`skipSuccessfulRequests`)
- **Response on limit**: `429 { error: "Too many login attempts..." }`
- **Store**: Redis if available, in-memory fallback
- **On store error**: Allow traffic through (`passOnStoreError`)

### signupLimiter
- **Applies to**: `POST /auth/signup`
- **Window**: 60 seconds
- **Limit**: 3 requests per IP
- **Response on limit**: `429 { error: "Too many signup attempts..." }`
- **Store**: Redis if available, in-memory fallback

### webhookLimiter
- **Applies to**: `POST /webhooks/hostaway/:tenantId`
- **Window**: 60 seconds
- **Limit**: 100 requests per tenantId
- **Key**: `req.params.tenantId` (not IP)
- **Store**: Redis if available, in-memory fallback

## Webhook Auth Middleware (`middleware/webhook-auth.ts`)

### webhookAuthMiddleware
- **Applies to**: `POST /webhooks/hostaway/:tenantId`
- **Checks**: `Authorization: Basic <base64>` header
- **Password source**: `tenant.webhookSecret` from database
- **Behavior**:
  - Header present + secret matches: proceed (200)
  - Header present + secret wrong: reject (401)
  - Header absent + tenant has secret: log warning, proceed (grace period)
  - Header absent + tenant has no secret: proceed (unconfigured)
- **Tenant lookup**: By `tenantId` URL param

## Security Headers (`helmet` configuration)

### Applied globally via `app.use(helmet(...))`
- Content-Security-Policy: disabled (API only)
- Cross-Origin-Embedder-Policy: disabled (API only)
- All other helmet defaults: enabled
- `app.set('trust proxy', 1)` for Railway reverse proxy
