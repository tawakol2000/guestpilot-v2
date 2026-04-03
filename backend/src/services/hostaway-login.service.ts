/**
 * Hostaway Dashboard Login Service
 * Uses Playwright to automate login to dashboard.hostaway.com.
 * Captures JWT from outgoing request headers after successful login.
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

const pendingSessions = new Map<string, LoginSession>();

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
 * Launch a browser with anti-detection measures.
 */
async function launchStealthBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = await context.newPage();

  // Patch navigator.webdriver and other automation indicators
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // @ts-ignore
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5], // Non-empty plugins array
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });

  return { browser, page };
}

/**
 * Attempt to login to Hostaway dashboard.
 */
export async function loginToHostaway(email: string, password: string): Promise<LoginResult> {
  let browser: Browser | null = null;

  try {
    const launched = await launchStealthBrowser();
    browser = launched.browser;
    const page = launched.page;

    // ── Capture JWT from outgoing request headers ──
    // After login, the Hostaway SPA makes API calls with a `jwt` header.
    // This is the most reliable way to capture the token.
    let capturedJwt: string | null = null;

    page.on('request', (request) => {
      const jwtHeader = request.headers()['jwt'];
      if (jwtHeader && jwtHeader.startsWith('eyJ') && !capturedJwt) {
        capturedJwt = jwtHeader;
        console.log(`[HostawayLogin] JWT captured from request header: ${request.url()}`);
      }
    });

    // Also try capturing from response bodies
    page.on('response', async (response) => {
      if (capturedJwt) return;
      try {
        const url = response.url();
        if (url.includes('hostaway') && response.status() === 200) {
          const ct = response.headers()['content-type'] || '';
          if (!ct.includes('json') && !ct.includes('text')) return;
          const body = await response.text();
          const match = body.match(/"(?:jwt|token)"\s*:\s*"(eyJ[^"]+)"/);
          if (match) {
            capturedJwt = match[1];
            console.log(`[HostawayLogin] JWT captured from response body: ${url}`);
          }
        }
      } catch { /* body not available */ }
    });

    // ── Navigate to login page ──
    console.log('[HostawayLogin] Navigating to login page...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15_000 });

    // ── Fill credentials ──
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);
    console.log('[HostawayLogin] Credentials filled, submitting...');

    // ── Submit form ──
    await page.click('button[type="submit"]');

    // ── Wait for redirect AWAY from /login ──
    // Bug fix: old code matched /login as success because dashboard.hostaway.com/** includes /login
    let loginSucceeded = false;
    try {
      await page.waitForURL(
        (url) => url.toString().startsWith(DASHBOARD_URL_PREFIX) && !url.toString().includes('/login'),
        { timeout: 20_000 }
      );
      loginSucceeded = true;
      console.log(`[HostawayLogin] Login redirect detected: ${page.url()}`);
    } catch {
      // Page didn't redirect away from /login within 20s
      console.log(`[HostawayLogin] Still on login page: ${page.url()}`);
    }

    // ── If still on login page, check for errors or 2FA ──
    if (!loginSucceeded) {
      // Check for visible error messages
      const errorText = await page.evaluate(`
        (function() {
          var selectors = ['.error', '[class*="error"]', '[role="alert"]', '.toast', '[class*="toast"]', '[class*="notification"]'];
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent && el.textContent.trim()) return el.textContent.trim();
          }
          return null;
        })()
      `).catch(() => null) as string | null;

      if (errorText) {
        console.log(`[HostawayLogin] Error on page: ${errorText}`);
        await browser.close();
        if (errorText.toLowerCase().includes('captcha') || errorText.toLowerCase().includes('robot')) {
          return { success: false, error: 'Automated login was blocked by captcha. Please use the manual connection method.' };
        }
        return { success: false, error: errorText };
      }

      // No error visible — might be 2FA or captcha silently blocking
      // Check if the form is still visible (captcha block) vs a 2FA message
      const formStillVisible = await page.$('input[type="password"]');
      if (formStillVisible) {
        // Form is still there with password field — likely captcha blocked the submission
        await browser.close();
        return { success: false, error: 'Automated login was blocked. Please use the manual connection method.' };
      }

      // 2FA screen — keep session alive
      const sessionId = crypto.randomUUID();
      const timeout = setTimeout(() => cleanupSession(sessionId), TWO_FA_TIMEOUT);
      pendingSessions.set(sessionId, { browser, page, createdAt: Date.now(), timeout });
      console.log(`[HostawayLogin] 2FA required for ${email}, session: ${sessionId}`);
      return { success: true, pending2fa: true, sessionId };
    }

    // ── Login succeeded — wait for JWT from request headers ──
    // The SPA will immediately make API calls with the jwt header
    if (!capturedJwt) {
      console.log('[HostawayLogin] Waiting for JWT from SPA API calls...');
      for (let i = 0; i < 10; i++) {
        if (capturedJwt) break;
        await page.waitForTimeout(1000);
      }
    }

    // Last resort: try localStorage
    if (!capturedJwt) {
      console.log('[HostawayLogin] Trying localStorage fallback...');
      capturedJwt = await page.evaluate(() => localStorage.getItem('jwt')).catch(() => null);
    }

    if (!capturedJwt) {
      console.warn('[HostawayLogin] JWT not found from any source');
      await browser.close();
      return { success: false, error: 'Login succeeded but token extraction failed. Please use the manual connection method.' };
    }

    const payload = decodeJwtPayload(capturedJwt);
    await browser.close();

    console.log(`[HostawayLogin] Login successful for ${email}`);
    return {
      success: true,
      jwt: capturedJwt,
      userEmail: payload?.userEmail || email,
      accountId: payload?.accountId?.toString(),
    };
  } catch (err: any) {
    console.error('[HostawayLogin] Login failed:', err.message);
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: 'Login failed. Please try the manual connection method.' };
  }
}

/**
 * Complete 2FA verification — user has clicked the email link.
 */
export async function verify2fa(sessionId: string): Promise<LoginResult> {
  const session = pendingSessions.get(sessionId);
  if (!session) {
    return { success: false, error: 'Session expired. Please try logging in again.' };
  }

  try {
    const { page, browser } = session;

    // Set up JWT capture from request headers
    let capturedJwt: string | null = null;
    page.on('request', (request) => {
      const jwtHeader = request.headers()['jwt'];
      if (jwtHeader && jwtHeader.startsWith('eyJ') && !capturedJwt) {
        capturedJwt = jwtHeader;
      }
    });

    // Click submit again
    try {
      await page.click('button[type="submit"]');
      await page.waitForURL(
        (url) => url.toString().startsWith(DASHBOARD_URL_PREFIX) && !url.toString().includes('/login'),
        { timeout: 15_000 }
      );
    } catch {
      cleanupSession(sessionId);
      return { success: false, error: 'Email verification not completed yet. Click the link in your email and try again.' };
    }

    // Wait for JWT from request headers
    for (let i = 0; i < 10; i++) {
      if (capturedJwt) break;
      await page.waitForTimeout(1000);
    }
    if (!capturedJwt) {
      capturedJwt = await page.evaluate(() => localStorage.getItem('jwt')).catch(() => null);
    }

    cleanupSession(sessionId);

    if (!capturedJwt) {
      return { success: false, error: 'Verification succeeded but token not found. Please try the manual method.' };
    }

    const payload = decodeJwtPayload(capturedJwt);
    console.log(`[HostawayLogin] 2FA verified for session ${sessionId}`);
    return {
      success: true,
      jwt: capturedJwt,
      userEmail: payload?.userEmail,
      accountId: payload?.accountId?.toString(),
    };
  } catch (err: any) {
    console.error('[HostawayLogin] 2FA verification failed:', err.message);
    cleanupSession(sessionId);
    return { success: false, error: 'Verification failed. Please try again.' };
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
