/**
 * Webhook Tool Service
 *
 * Calls external webhook URLs for custom tool invocations.
 * POST JSON body with timeout handling, graceful error return.
 *
 * Bugfix (2026-04-23, security pass): added send-time SSRF guard +
 * cap maxRedirects:0 + scrubbed error response body to defeat the
 * SSRF + info-disclosure surface flagged in the security scan. See
 * `lib/url-safety.ts` for the rationale.
 */
import axios from 'axios';
import { assertPublicHttpsUrl } from '../lib/url-safety';

/**
 * Call a webhook URL with the tool input payload.
 * Returns the response body as a string.
 * On error (timeout, network, non-2xx, blocked URL): returns a JSON
 * error string instead of throwing.
 */
export async function callWebhook(
  url: string,
  input: unknown,
  timeoutMs: number = 10000,
): Promise<string> {
  // Send-time SSRF guard. Resolves the hostname via DNS and rejects
  // if it points at a private/loopback/link-local/metadata range.
  // Defeats DNS rebinding (where the hostname was public at
  // write-time validation but private at fetch-time).
  try {
    await assertPublicHttpsUrl(url);
  } catch (err: any) {
    console.error(`[WebhookTool] Refused to call URL ${url}: ${err.message}`);
    return JSON.stringify({
      error: 'Webhook URL blocked',
      details: 'The webhook URL points at a private or restricted address.',
    });
  }
  try {
    const response = await axios.post(url, input, {
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
      // Accept any 2xx status
      validateStatus: (status) => status >= 200 && status < 300,
      // 2026-04-23: cap redirects so an attacker can't smuggle a
      // 30x → internal-IP redirect past the assertPublicHttpsUrl
      // check above. Custom webhooks should respond directly; if a
      // legitimate webhook needs redirects, the operator can flip
      // this on their end.
      maxRedirects: 0,
    });

    // Return response body as string
    if (typeof response.data === 'string') {
      return response.data;
    }
    return JSON.stringify(response.data);
  } catch (err: any) {
    // 2026-04-23 (security pass): do NOT surface upstream response
    // body slices in the error string. The previous version returned
    // up-to-200-char body slices, which combined with a successful
    // SSRF would have leaked internal endpoint responses to the
    // tenant via the AI message / preview / trace. Now the error
    // string carries only the status code + axios error code.
    const details = err.code === 'ECONNABORTED'
      ? `Webhook timed out after ${timeoutMs}ms`
      : err.response
        ? `HTTP ${err.response.status}`
        : err.code
          ? `Network error (${err.code})`
          : 'Unknown error';

    console.error(`[WebhookTool] Failed to call ${url}:`, details);

    return JSON.stringify({
      error: 'Webhook failed',
      details,
    });
  }
}
