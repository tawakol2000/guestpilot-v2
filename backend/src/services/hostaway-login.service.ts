/**
 * Hostaway Dashboard Login Service
 * Uses Playwright to automate login to dashboard.hostaway.com,
 * extracting the JWT from localStorage after successful authentication.
 */

import { chromium, Browser, Page } from 'playwright';

const LOGIN_URL = 'https://dashboard.hostaway.com/login';
const DASHBOARD_URL_PREFIX = 'https://dashboard.hostaway.com/';
const LOGIN_TIMEOUT = 30_000;
const TWO_FA_TIMEOUT = 180_000; // 3 minutes for user to click email link

interface LoginSession {
  browser: Browser;
  page: Page;
  createdAt: number;
  timeout: NodeJS.Timeout;
}

// Active 2FA sessions waiting for email verification
const pendingSessions = new Map<string, LoginSession>();

// Cleanup stale sessions
function cleanupSession(sessionId: string) {
  const session = pendingSessions.get(sessionId);
  if (session) {
    clearTimeout(session.timeout);
    session.browser.close().catch(() => {});
    pendingSessions.delete(sessionId);
  }
}

export interface LoginResult {
  success: boolean;
  jwt?: string;
  pending2fa?: boolean;
  sessionId?: string;
  error?: string;
  userEmail?: string;
  accountId?: string;
}

/**
 * Attempt to login to Hostaway dashboard.
 * Returns JWT on success, or a sessionId if 2FA is required.
 */
export async function loginToHostaway(email: string, password: string): Promise<LoginResult> {
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // Intercept network responses to capture JWT
    let capturedJwt: string | null = null;
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('hostaway') && response.status() === 200) {
          const contentType = response.headers()['content-type'] || '';
          if (!contentType.includes('json') && !contentType.includes('text')) return;
          const body = await response.text();
          // Look for JWT token in any response
          const jwtMatch = body.match(/"(?:jwt|token|accessToken)"\s*:\s*"(eyJ[^"]+)"/);
          if (jwtMatch && !capturedJwt) {
            capturedJwt = jwtMatch[1];
            console.log(`[HostawayLogin] JWT captured from response: ${url}`);
          }
        }
      } catch { /* response body might not be available */ }
    });

    // Navigate to login
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });

    // Wait for login form to render
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15_000 });

    // Fill credentials
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);

    // Click submit
    await page.click('button[type="submit"]');

    // Wait for either: redirect to dashboard (success) or stay on login page (2FA/error)
    try {
      await page.waitForURL(`${DASHBOARD_URL_PREFIX}**`, { timeout: 15_000 });
    } catch {
      // Didn't redirect — check if 2FA or error
      const pageUrl = page.url();
      if (pageUrl.includes('/login')) {
        // Check for error messages on the page
        const errorText = await page.textContent('.error, [class*="error"], [role="alert"]').catch(() => null);

        if (errorText && (errorText.includes('Invalid') || errorText.includes('incorrect') || errorText.includes('wrong'))) {
          await browser.close();
          return { success: false, error: 'Invalid email or password' };
        }

        // Likely 2FA — keep session alive
        const sessionId = crypto.randomUUID();
        const timeout = setTimeout(() => cleanupSession(sessionId), TWO_FA_TIMEOUT);
        pendingSessions.set(sessionId, { browser, page, createdAt: Date.now(), timeout });

        console.log(`[HostawayLogin] 2FA required for ${email}, session: ${sessionId}`);
        return { success: true, pending2fa: true, sessionId };
      }
    }

    // Wait for SPA to fully initialize after redirect
    console.log(`[HostawayLogin] Redirected to: ${page.url()}`);
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(3000); // Give SPA time to hydrate

    // Success — extract JWT from localStorage or network capture
    let jwt: string | null = capturedJwt;
    if (jwt) {
      console.log('[HostawayLogin] JWT captured from network response');
    } else {
      for (let attempt = 0; attempt < 20; attempt++) {
        // Try reading JWT from localStorage
        const result = await page.evaluate(() => {
          const keys = Object.keys(localStorage);
          const jwt = localStorage.getItem('jwt');
          return { keys, jwt, url: window.location.href };
        });
        console.log(`[HostawayLogin] Attempt ${attempt + 1}: url=${result.url}, localStorage keys=[${result.keys.join(', ')}], jwt=${result.jwt ? 'FOUND' : 'null'}`);
        if (result.jwt) { jwt = result.jwt; break; }
        await page.waitForTimeout(1000);
      }
    }
    if (!jwt) {
      console.warn('[HostawayLogin] JWT not found after all attempts');
      await browser.close();
      return { success: false, error: 'Login succeeded but no token found. Please try again.' };
    }

    // Decode JWT to get metadata
    const payload = decodeJwtPayload(jwt);
    await browser.close();

    console.log(`[HostawayLogin] Login successful for ${email}`);
    return {
      success: true,
      jwt,
      userEmail: payload?.userEmail || email,
      accountId: payload?.accountId?.toString(),
    };
  } catch (err: any) {
    console.error('[HostawayLogin] Login failed:', err.message);
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: err.message || 'Login failed' };
  }
}

/**
 * Complete 2FA verification — user has clicked the email link.
 * Retry login by refreshing the page and checking for JWT.
 */
export async function verify2fa(sessionId: string): Promise<LoginResult> {
  const session = pendingSessions.get(sessionId);
  if (!session) {
    return { success: false, error: 'Session expired. Please try logging in again.' };
  }

  try {
    const { page, browser } = session;

    // Click submit again (the 2FA verification happens server-side after email click)
    try {
      await page.click('button[type="submit"]');
      await page.waitForURL(`${DASHBOARD_URL_PREFIX}**`, { timeout: 10_000 });
    } catch {
      // Try refreshing the page instead
      await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 10_000 });

      // Check if we're already logged in (redirected to dashboard)
      if (!page.url().includes('/login')) {
        // Already on dashboard
      } else {
        // Still on login — re-fill and submit
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        if (emailInput) {
          // Form is still there, 2FA might not be verified yet
          cleanupSession(sessionId);
          return { success: false, error: 'Email verification not completed yet. Click the link in your email and try again.' };
        }
      }
    }

    // Extract JWT
    const jwt = await page.evaluate(() => localStorage.getItem('jwt'));
    cleanupSession(sessionId);

    if (!jwt) {
      return { success: false, error: 'Verification succeeded but no token found. Please try again.' };
    }

    const payload = decodeJwtPayload(jwt);
    console.log(`[HostawayLogin] 2FA verified for session ${sessionId}`);

    return {
      success: true,
      jwt,
      userEmail: payload?.userEmail,
      accountId: payload?.accountId?.toString(),
    };
  } catch (err: any) {
    console.error('[HostawayLogin] 2FA verification failed:', err.message);
    cleanupSession(sessionId);
    return { success: false, error: 'Verification failed. Please try logging in again.' };
  }
}

function decodeJwtPayload(jwt: string): any {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
