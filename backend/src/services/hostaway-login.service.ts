/**
 * Hostaway Dashboard Login Service
 *
 * Hostaway's login requires TWO tokens:
 * 1. captchaToken — Google reCAPTCHA Enterprise (solved via CapSolver)
 * 2. auditToken — Castle.io device fingerprint (generated via browser)
 *
 * Flow: Browser generates auditToken → CapSolver solves reCAPTCHA →
 * Direct API POST to /account/session → JWT returned in response.
 */

import axios from 'axios';
import { chromium, Browser } from 'rebrowser-playwright';

const LOGIN_API_URL = 'https://platform.hostaway.com/account/session';
const LOGIN_PAGE_URL = 'https://dashboard.hostaway.com/login';
const RECAPTCHA_SITEKEY = '6Le23SIrAAAAADpWBeJSU7b8wNAdL4vwQl7F1kli';

// 2FA sessions
interface LoginSession {
  email: string;
  password: string;
  createdAt: number;
  timeout: NodeJS.Timeout;
}
const pendingSessions = new Map<string, LoginSession>();

function cleanupSession(sessionId: string) {
  const session = pendingSessions.get(sessionId);
  if (session) {
    clearTimeout(session.timeout);
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

// ─── CapSolver: Solve reCAPTCHA Enterprise ──────────────────────────────────

async function solveCaptcha(): Promise<string> {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) throw new Error('CAPSOLVER_API_KEY not configured');

  console.log('[HostawayLogin] Solving reCAPTCHA Enterprise via CapSolver...');

  const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV3EnterpriseTaskProxyLess',
      websiteURL: LOGIN_PAGE_URL,
      websiteKey: RECAPTCHA_SITEKEY,
    },
  });

  if (createData.errorId !== 0) {
    throw new Error(`CapSolver: ${createData.errorCode} — ${createData.errorDescription}`);
  }

  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const { data } = await axios.post('https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId: createData.taskId,
    });

    if (data.status === 'ready') {
      console.log(`[HostawayLogin] reCAPTCHA solved in ~${(i + 1) * 1.5}s`);
      return data.solution.gRecaptchaResponse;
    }
    if (data.errorId !== 0) throw new Error(`CapSolver: ${data.errorCode}`);
  }
  throw new Error('reCAPTCHA solve timed out');
}

// ─── Castle.io: Generate auditToken via browser ─────────────────────────────

/**
 * Generate BOTH tokens by filling the login form and intercepting the POST.
 * The SPA generates auditToken (Castle.io) and captchaToken (reCAPTCHA Enterprise)
 * through its own code path — we just intercept and steal them.
 */
export async function generateBothTokens(): Promise<{ auditToken: string; captchaToken: string }> {
  console.log('[HostawayLogin] Generating tokens by intercepting form submission...');
  let browser: Browser | null = null;

  try {
    const isProduction = process.env.NODE_ENV === 'production';
    browser = await chromium.launch({
      headless: !isProduction,
      executablePath: isProduction ? '/usr/bin/google-chrome-stable' : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    let capturedAuditToken: string | null = null;
    let capturedCaptchaToken: string | null = null;

    // Intercept the login POST to steal both tokens
    await page.route('**/account/session', async (route) => {
      try {
        const body = route.request().postDataJSON();
        capturedAuditToken = body?.auditToken || null;
        capturedCaptchaToken = body?.captchaToken || null;
        console.log(`[HostawayLogin] Intercepted POST — auditToken: ${capturedAuditToken ? capturedAuditToken.length + ' chars' : 'null'}, captchaToken: ${capturedCaptchaToken ? capturedCaptchaToken.length + ' chars' : 'null'}`);
      } catch (e: any) {
        console.error('[HostawayLogin] Intercept parse error:', e.message);
      }
      // ABORT the request — we don't want the browser to consume the tokens
      // We'll use them in our own API call
      await route.abort();
    });

    await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });

    // Fill form with dummy credentials to trigger token generation
    // (we'll use the real credentials in our own API call)
    await page.locator('input[type="email"], input[name="email"]').pressSequentially('test@example.com', { delay: 30 });
    await page.locator('input[type="password"], input[name="password"]').pressSequentially('dummypassword', { delay: 30 });

    // Wait for reCAPTCHA and Castle to be ready
    await page.waitForTimeout(3000);

    // Click submit — this triggers the SPA to generate both tokens and POST
    console.log('[HostawayLogin] Clicking submit to trigger token generation...');
    await page.click('button[type="submit"]');

    // Wait for the intercepted request
    await page.waitForTimeout(8000);

    await browser.close();

    console.log(`[HostawayLogin] Final — auditToken: ${capturedAuditToken ? String(capturedAuditToken).length + ' chars' : 'FAILED'}, captchaToken: ${capturedCaptchaToken ? String(capturedCaptchaToken).length + ' chars' : 'FAILED'}`);

    return {
      auditToken: capturedAuditToken || '',
      captchaToken: capturedCaptchaToken || '',
    };
  } catch (err: any) {
    console.error('[HostawayLogin] Token generation failed:', err.message);
    if (browser) await browser.close().catch(() => {});
    return { auditToken: '', captchaToken: '' };
  }
}


// ─── Direct API Login ───────────────────────────────────────────────────────

async function callLoginApi(email: string, password: string, captchaToken: string, auditToken: string) {
  const res = await axios.post(LOGIN_API_URL, {
    email, password, captchaToken, auditToken,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Origin': 'https://dashboard.hostaway.com',
      'Referer': 'https://dashboard.hostaway.com/',
    },
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

// ─── Main Login Flow ────────────────────────────────────────────────────────

export async function loginToHostaway(email: string, password: string): Promise<LoginResult> {
  try {
    // Strategy: Let the browser do EVERYTHING naturally.
    // Fill real credentials, let SPA generate tokens, let it submit.
    // Capture JWT from the response or from localStorage after login.
    console.log('[HostawayLogin] Starting full browser login...');

    const isProduction = process.env.NODE_ENV === 'production';
    const browser = await chromium.launch({
      headless: !isProduction,
      executablePath: isProduction ? '/usr/bin/google-chrome-stable' : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    // Capture JWT from the login API response
    let capturedJwt: string | null = null;
    page.on('response', async (response) => {
      try {
        if (response.url().includes('/account/session') && response.status() === 200) {
          const body = await response.json().catch(() => null);
          if (body) {
            const jwt = extractJwtFromResponse(body);
            if (jwt) {
              capturedJwt = jwt;
              console.log('[HostawayLogin] JWT captured from login response!');
            }
          }
        }
      } catch {}
    });

    // Also capture from outgoing request headers (after login redirect)
    page.on('request', (request) => {
      if (capturedJwt) return;
      const jwtHeader = request.headers()['jwt'];
      if (jwtHeader && jwtHeader.startsWith('eyJ')) {
        capturedJwt = jwtHeader;
        console.log('[HostawayLogin] JWT captured from request header!');
      }
    });

    // Navigate and fill form
    await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.locator('input[type="email"], input[name="email"]').pressSequentially(email, { delay: 40 });
    await page.locator('input[type="password"], input[name="password"]').pressSequentially(password, { delay: 40 });
    await page.waitForTimeout(2000);

    // Click submit — SPA generates both tokens and submits
    console.log('[HostawayLogin] Submitting form...');
    await page.click('button[type="submit"]');

    // Wait for redirect away from /login
    let loginSucceeded = false;
    try {
      await page.waitForURL(
        (url) => url.toString().startsWith('https://dashboard.hostaway.com/') && !url.toString().includes('/login'),
        { timeout: 25000 }
      );
      loginSucceeded = true;
      console.log(`[HostawayLogin] Redirected to: ${page.url()}`);
    } catch {
      console.log(`[HostawayLogin] Still on: ${page.url()}`);
    }

    if (!loginSucceeded) {
      // Check for errors or 2FA
      const errorText = await page.evaluate(`
        (function() {
          var el = document.querySelector('[class*="error"], [role="alert"], .toast');
          return el && el.textContent ? el.textContent.trim() : null;
        })()
      `).catch(() => null) as string | null;

      // Check if form is gone (2FA screen)
      const formVisible = await page.$('input[type="password"]');

      await browser.close();

      if (formVisible) {
        return { success: false, error: errorText || 'Login failed. Please use the manual connection method.' };
      }

      // 2FA
      return { success: true, pending2fa: true, sessionId: 'browser-2fa-' + Date.now() };
    }

    // Wait for JWT capture
    if (!capturedJwt) {
      await page.waitForTimeout(5000);
    }
    if (!capturedJwt) {
      capturedJwt = await page.evaluate('localStorage.getItem("jwt")').catch(() => null) as string | null;
    }

    await browser.close();

    if (!capturedJwt) {
      return { success: false, error: 'Login succeeded but token not captured. Please use the manual method.' };
    }

    const payload = decodeJwtPayload(capturedJwt);
    console.log(`[HostawayLogin] Login successful for ${email}`);

    return {
      success: true,
      jwt: capturedJwt,
      userEmail: payload?.userEmail || email,
      accountId: payload?.accountId?.toString(),
    };
  } catch (err: any) {
    console.error('[HostawayLogin] Login error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── 2FA Verification ───────────────────────────────────────────────────────

export async function verify2fa(sessionId: string): Promise<LoginResult> {
  const session = pendingSessions.get(sessionId);
  if (!session) return { success: false, error: 'Session expired. Please try again.' };

  try {
    const tokens = await generateBothTokens();
    let captchaToken = tokens.captchaToken;
    if (!captchaToken && process.env.CAPSOLVER_API_KEY) {
      captchaToken = await solveCaptcha();
    }
    const auditToken = tokens.auditToken;
    const result = await callLoginApi(session.email, session.password, captchaToken, auditToken);

    if (result.status === 200) {
      const jwt = extractJwtFromResponse(result.data);
      cleanupSession(sessionId);
      if (jwt) {
        const payload = decodeJwtPayload(jwt);
        return { success: true, jwt, userEmail: payload?.userEmail, accountId: payload?.accountId?.toString() };
      }
      return { success: false, error: 'Token not found in response' };
    }

    if (result.status === 403) {
      return { success: false, error: 'Email link not clicked yet. Click it and try again.' };
    }

    cleanupSession(sessionId);
    return { success: false, error: result.data?.message || 'Verification failed' };
  } catch (err: any) {
    cleanupSession(sessionId);
    return { success: false, error: err.message };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractJwtFromResponse(data: any): string | null {
  if (typeof data === 'string' && data.startsWith('eyJ')) return data;
  if (data?.jwt) return data.jwt;
  if (data?.token) return data.token;
  if (data?.result?.jwt) return data.result.jwt;
  if (data?.result?.token) return data.result.token;
  if (data?.data?.jwt) return data.data.jwt;
  if (data?.accessToken) return data.accessToken;
  const str = JSON.stringify(data);
  const match = str.match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
  return match ? match[1] : null;
}

function decodeJwtPayload(jwt: string): any {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
}
