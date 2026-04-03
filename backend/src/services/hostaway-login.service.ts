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

export async function generateAuditToken(): Promise<string> {
  console.log('[HostawayLogin] Generating Castle.io auditToken via browser...');
  let browser: Browser | null = null;

  try {
    const isProduction = process.env.NODE_ENV === 'production';
    browser = await chromium.launch({
      headless: !isProduction,
      executablePath: isProduction ? '/usr/bin/google-chrome-stable' : undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for Castle.io SDK to initialize (loaded from CloudFront CDN)
    await page.waitForTimeout(5000);

    // Call Castle's createRequestToken() to generate the auditToken
    const auditToken = await page.evaluate(`
      (function() {
        try {
          // Castle SDK exposes createRequestToken on the global castle object
          // or on _castle namespace
          if (typeof castle !== 'undefined' && castle.createRequestToken) {
            return castle.createRequestToken();
          }
          // Try window._castle
          if (typeof _castle !== 'undefined' && _castle.createRequestToken) {
            return _castle.createRequestToken();
          }
          // Search for Castle in window properties
          var keys = Object.keys(window);
          for (var i = 0; i < keys.length; i++) {
            var obj = window[keys[i]];
            if (obj && typeof obj === 'object' && typeof obj.createRequestToken === 'function') {
              return obj.createRequestToken();
            }
          }
          return null;
        } catch(e) {
          return 'ERROR:' + e.message;
        }
      })()
    `) as string | null;

    await browser.close();

    if (auditToken && !auditToken.startsWith('ERROR:')) {
      console.log(`[HostawayLogin] auditToken generated (${auditToken.length} chars)`);
      return auditToken;
    }

    // Fallback: try intercepting the token from the form submission
    console.warn(`[HostawayLogin] Castle.createRequestToken() returned: ${auditToken || 'null'}. Trying form intercept...`);
    return await extractAuditTokenFromForm();
  } catch (err: any) {
    console.error('[HostawayLogin] auditToken generation failed:', err.message);
    if (browser) await browser.close().catch(() => {});
    return '';
  }
}

async function extractAuditTokenFromForm(): Promise<string> {
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
    });
    const page = await context.newPage();

    let captured: string | null = null;

    // Intercept the login POST to capture auditToken
    await page.route('**/account/session', async (route) => {
      try {
        const body = route.request().postDataJSON();
        captured = body?.auditToken || null;
        console.log(`[HostawayLogin] Intercepted auditToken: ${captured ? captured.substring(0, 40) + '...' : 'null'}`);
      } catch {}
      await route.abort();
    });

    await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 15000 });

    // Fill dummy credentials and submit to trigger Castle token generation
    await page.locator('input[type="email"]').pressSequentially('test@test.com', { delay: 30 });
    await page.locator('input[type="password"]').pressSequentially('test', { delay: 30 });
    await page.waitForTimeout(3000);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);

    await browser.close();
    return captured || '';
  } catch (err: any) {
    console.error('[HostawayLogin] Form intercept failed:', err.message);
    if (browser) await browser.close().catch(() => {});
    return '';
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
    // Step 1: Generate Castle.io auditToken (browser-based, ~10s)
    const auditToken = await generateAuditToken();
    console.log(`[HostawayLogin] auditToken: ${auditToken ? 'obtained' : 'FAILED'}`);

    // Step 2: Solve reCAPTCHA via CapSolver (~5-15s)
    const captchaToken = await solveCaptcha();

    // Step 3: Call Hostaway login API directly
    console.log('[HostawayLogin] Calling login API...');
    const result = await callLoginApi(email, password, captchaToken, auditToken);
    console.log(`[HostawayLogin] Response: ${result.status} — ${JSON.stringify(result.data).substring(0, 300)}`);

    // Handle success
    if (result.status === 200) {
      const jwt = extractJwtFromResponse(result.data);
      if (jwt) {
        const payload = decodeJwtPayload(jwt);
        console.log(`[HostawayLogin] Login successful for ${email}`);
        return { success: true, jwt, userEmail: payload?.userEmail || email, accountId: payload?.accountId?.toString() };
      }
      console.log('[HostawayLogin] 200 but no JWT in response body');
      return { success: false, error: 'Login succeeded but token not found in response' };
    }

    // Handle 403
    if (result.status === 403) {
      const msg = result.data?.message || '';
      // 2FA check
      if (msg.toLowerCase().includes('verify') || msg.toLowerCase().includes('email') || msg.toLowerCase().includes('2fa') || msg.toLowerCase().includes('link')) {
        const sessionId = crypto.randomUUID();
        const timeout = setTimeout(() => cleanupSession(sessionId), 180_000);
        pendingSessions.set(sessionId, { email, password, createdAt: Date.now(), timeout });
        console.log(`[HostawayLogin] 2FA required, session: ${sessionId}`);
        return { success: true, pending2fa: true, sessionId };
      }
      return { success: false, error: `Hostaway: ${msg}` };
    }

    return { success: false, error: result.data?.message || `Login failed (${result.status})` };
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
    const auditToken = await generateAuditToken();
    const captchaToken = await solveCaptcha();
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
