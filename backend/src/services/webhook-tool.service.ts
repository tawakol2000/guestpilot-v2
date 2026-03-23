/**
 * Webhook Tool Service
 *
 * Calls external webhook URLs for custom tool invocations.
 * POST JSON body with timeout handling, graceful error return.
 */
import axios from 'axios';

/**
 * Call a webhook URL with the tool input payload.
 * Returns the response body as a string.
 * On error (timeout, network, non-2xx): returns a JSON error string instead of throwing.
 */
export async function callWebhook(
  url: string,
  input: unknown,
  timeoutMs: number = 10000,
): Promise<string> {
  try {
    const response = await axios.post(url, input, {
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
      // Accept any 2xx status
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Return response body as string
    if (typeof response.data === 'string') {
      return response.data;
    }
    return JSON.stringify(response.data);
  } catch (err: any) {
    const details = err.code === 'ECONNABORTED'
      ? `Webhook timed out after ${timeoutMs}ms`
      : err.response
        ? `HTTP ${err.response.status}: ${typeof err.response.data === 'string' ? err.response.data.substring(0, 200) : JSON.stringify(err.response.data).substring(0, 200)}`
        : err.message || 'Unknown error';

    console.error(`[WebhookTool] Failed to call ${url}:`, details);

    return JSON.stringify({
      error: 'Webhook failed',
      details,
    });
  }
}
