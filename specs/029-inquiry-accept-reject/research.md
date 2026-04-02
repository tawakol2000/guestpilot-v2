# Research: 029 Inquiry Accept/Reject

## R1: Hostaway Internal Dashboard API Endpoints

**Decision**: Use `platform.hostaway.com` internal API with dashboard JWT auth.

**Rationale**: The public API (`api.hostaway.com`) does not expose inquiry accept/reject/cancel endpoints. These are only available via the internal dashboard API, confirmed through Playwright network interception.

**Confirmed Endpoints**:

| Action | Method | Endpoint | Body | Auth |
|--------|--------|----------|------|------|
| Approve | `PUT` | `/reservations/{id}/status/approved` | None | `jwt` header |
| Cancel | `DELETE` | `/reservations/{id}/status` | None | `jwt` header |
| Reject | TBD | Likely `PUT /reservations/{id}/status/declined` or `DELETE` variant | TBD | `jwt` header |

**Auth Details**:
- Base URL: `https://platform.hostaway.com`
- Auth header: `jwt: <token>` (NOT `Authorization: Bearer`)
- Token source: `localStorage.getItem('jwt')` on `dashboard.hostaway.com`
- Token lifetime: 90 days (decoded from JWT `iat`/`exp`)
- Token NOT IP-bound — confirmed working from server IP different from browser IP

**Login endpoint** (for reference, not used directly):
- `POST /account/session` with `{email, password, auditToken, captchaToken}`
- Requires Cloudflare Turnstile token (cannot bypass programmatically)
- Sometimes triggers email-based 2FA

**Alternatives considered**:
- Public API `PUT /v1/reservations/{id}` — status field is read-only
- Public API `PUT /v1/reservations/{id}/statuses/cancelled` — only cancel, no approve/reject
- Browser extension — too much user friction
- Headless browser (Browserbase) — unnecessary complexity since JWT is not IP-bound

## R2: Token Extraction Mechanism (Bookmarklet)

**Decision**: Bookmarklet that reads JWT from localStorage and redirects to GuestPilot callback URL.

**Rationale**: Cross-origin policy prevents reading localStorage from a popup. A bookmarklet runs in the context of the current page (dashboard.hostaway.com) and has full access to localStorage. One click, no technical knowledge required.

**Flow**:
1. User clicks "Connect Hostaway Dashboard" in settings
2. Instructions modal appears with a draggable bookmarklet button
3. User opens `dashboard.hostaway.com` in a new tab and logs in
4. User clicks the bookmarklet from their bookmark bar
5. Bookmarklet reads `localStorage.getItem('jwt')`, redirects to `https://<guestpilot-app>/api/hostaway-connect/callback?token=<jwt>`
6. GuestPilot backend validates token (decodes JWT, checks exp), stores encrypted, redirects to settings page with success message

**Alternatives considered**:
- Browser extension — requires install, Chrome Web Store review
- Remote browser (Browserbase/Hyperbeam) — expensive, overkill since token is not IP-bound
- Manual JWT paste from DevTools — poor UX, users can't do this
- Reverse proxy login page — blocked by Cloudflare Turnstile domain lock

## R3: Token Encryption at Rest

**Decision**: AES-256-GCM encryption using Node.js built-in `crypto` module with per-tenant IV.

**Rationale**: No existing encryption utility in the codebase. bcryptjs is used for passwords but is one-way hashing (not suitable for tokens that need decryption). AES-256-GCM provides authenticated encryption — both confidentiality and integrity.

**Implementation pattern**:
- Encryption key derived from `JWT_SECRET` env var (already required) via PBKDF2
- Random 12-byte IV per encryption operation, stored alongside ciphertext
- Store as `iv:authTag:ciphertext` hex string in a single DB field
- Utility module: `backend/src/lib/encryption.ts`

**Alternatives considered**:
- Store token in plaintext (like existing `hostawayApiKey`) — rejected per FR-015
- Separate encryption key env var — unnecessary complexity, JWT_SECRET already exists
- AWS KMS / Vault — overkill for this use case

## R4: Reject Endpoint Discovery

**Decision**: Ship with known endpoints (approve + cancel). Discover reject endpoint during implementation testing. Fall back to graceful error if reject fails for certain channels.

**Rationale**: We confirmed approve (`PUT /status/approved`) and cancel (`DELETE /status`). The reject/decline endpoint was not captured because:
- Airbnb inquiry decline was blocked on the web dashboard ("can only be done through Airbnb")
- The cancel action on a direct booking used `DELETE /status`
- The reject endpoint for non-Airbnb inquiries likely follows pattern: `PUT /status/declined` or `PUT /status/denied`

**Testing plan**: During implementation, create a test inquiry from the booking engine and attempt reject via likely endpoint patterns. If none work, the reject button shows a channel-specific limitation message.

## R5: Visual Feedback for Actions

**Decision**: Three-state button feedback — idle → loading (spinner) → success (checkmark, green flash) or error (red, error message).

**Rationale**: User explicitly requested seeing whether an action worked or failed. Standard UX pattern for destructive/important actions.

**States**:
1. **Idle**: Normal button appearance
2. **Loading**: Button disabled, spinner replaces icon, text changes to "Approving..."/"Rejecting..."/"Cancelling..."
3. **Success**: Brief green flash/checkmark animation (~1.5s), then button disappears (status already changed)
4. **Error**: Red error state with message, retry button appears
