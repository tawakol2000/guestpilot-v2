/**
 * Hostaway Dashboard Login Service
 *
 * The automatic browser login approach was abandoned — reCAPTCHA Enterprise
 * consistently blocks headless browsers regardless of stealth measures.
 *
 * Instead, users connect via bookmarklet (runs in THEIR real browser)
 * or manual token paste from browser console.
 */

// This file is kept for potential future use but contains no active automation.
// Login flow is handled entirely via:
// - GET /api/hostaway-connect/callback?token=<jwt> (bookmarklet redirect)
// - POST /api/hostaway-connect/manual (paste token)
