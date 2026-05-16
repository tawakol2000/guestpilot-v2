/**
 * Feature 044: WAsender WhatsApp provider client.
 * Thin axios wrapper around POST /api/send-message.
 * Contract: specs/044-doc-handoff-whatsapp/contracts/wasender-client.md
 *
 * Graceful-degradation (§I): if WASENDER_API_KEY is missing, isWasenderEnabled() returns false.
 * Callers must check before calling send*; send* will throw WasenderDisabledError otherwise.
 */
import axios, { AxiosError, AxiosInstance } from 'axios';

const DEFAULT_BASE_URL = 'https://wasenderapi.com';
const DEFAULT_TIMEOUT_MS = 15_000;

export class WasenderDisabledError extends Error {
  constructor() {
    super('WASENDER_API_KEY missing — provider disabled');
    this.name = 'WasenderDisabledError';
  }
}

export class WasenderRequestError extends Error {
  public readonly status: number;
  public readonly responseBody?: unknown;
  constructor(message: string, status: number, responseBody?: unknown) {
    super(message);
    this.name = 'WasenderRequestError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class WasenderServerError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WasenderServerError';
    this.status = status;
  }
}

export class WasenderTimeoutError extends Error {
  constructor() {
    super('WAsender request timed out');
    this.name = 'WasenderTimeoutError';
  }
}

export interface SendTextInput {
  to: string;
  text: string;
}

export interface SendImageInput {
  to: string;
  text?: string;
  imageUrl: string;
}

export interface SendResult {
  providerMessageId: string;
  raw: unknown;
}

let _client: AxiosInstance | null = null;
function getClient(): AxiosInstance {
  if (_client) return _client;
  _client = axios.create({
    baseURL: process.env.WASENDER_BASE_URL || DEFAULT_BASE_URL,
    timeout: Number(process.env.WASENDER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
    },
  });
  return _client;
}

export function isWasenderEnabled(): boolean {
  return Boolean(process.env.WASENDER_API_KEY);
}

// Test-only hook to inject an axios instance. Not exported from package root.
export function __setHttpClient(client: AxiosInstance | null): void {
  _client = client;
}

// 2026-05-16: WAsender 4xx error bodies for rate-limit hits typically
// include phrases like "send 1 message every 5 seconds" or "every N
// seconds". Parse the N out so the 429 retry waits long enough; fall
// back to a fixed delay when no number is parseable.
const RATE_LIMIT_FALLBACK_MS = 6_000;
function parseRateLimitWaitMs(responseBody: unknown): number {
  const txt = [
    (responseBody as any)?.error,
    (responseBody as any)?.message,
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
  const m = txt.match(/every\s+(\d+)\s*seconds?/i);
  if (m) return Math.max(Number(m[1]), 1) * 1000 + 500;
  return RATE_LIMIT_FALLBACK_MS;
}

async function postSendMessage(
  body: Record<string, unknown>,
  attempt = 0,
): Promise<SendResult> {
  if (!isWasenderEnabled()) throw new WasenderDisabledError();
  const started = Date.now();
  try {
    const res = await getClient().post('/api/send-message', body, {
      headers: { Authorization: `Bearer ${process.env.WASENDER_API_KEY}` },
    });
    const data = res.data;
    const msgId = data?.data?.msgId;
    if (!msgId) {
      throw new WasenderRequestError('Unexpected response shape from WAsender', res.status, data);
    }
    console.log(`[WAsender] sent msgId=${msgId} to=${body.to} (${Date.now() - started}ms)`);
    return { providerMessageId: String(msgId), raw: data };
  } catch (err) {
    if (err instanceof WasenderRequestError) throw err;
    const axiosErr = err as AxiosError;
    if (axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ETIMEDOUT') {
      console.warn(`[WAsender] timeout to=${body.to}`);
      throw new WasenderTimeoutError();
    }
    const status = axiosErr.response?.status ?? 0;
    const responseBody = axiosErr.response?.data;
    if (status >= 500 || status === 0) {
      console.warn(`[WAsender] server error status=${status}`);
      throw new WasenderServerError(axiosErr.message, status);
    }
    // 2026-05-15 M13: WAsender 4xx error bodies often echo back the
    // `to` field (recipient phone number) plus other request fields. We
    // were logging the full body to application logs, leaking the
    // security desk's phone number on every failed send. Log only the
    // status + a trimmed error string the way the rest of the service
    // does, and keep the full body inside the thrown error for the
    // caller to inspect under controlled conditions.
    const trimmedError =
      typeof (responseBody as any)?.error === 'string'
        ? String((responseBody as any).error).slice(0, 200)
        : typeof (responseBody as any)?.message === 'string'
          ? String((responseBody as any).message).slice(0, 200)
          : 'unknown';
    // 2026-05-16: on 429, wait the WAsender-indicated period and retry
    // once. Production handoff for Apartment 103 lost 2 of 3 passport
    // images because WAsender returned "send 1 message every 5 seconds"
    // and the caller (doc-handoff.service) had no per-call retry — a
    // single 429 immediately abandoned the rest of the loop. One retry
    // here turns a transient burst into a 6-7s pause instead of a
    // partial-delivery incident.
    if (status === 429 && attempt === 0) {
      const waitMs = parseRateLimitWaitMs(responseBody);
      console.warn(
        `[WAsender] 429 rate-limit — sleeping ${waitMs}ms then retrying once. error=${trimmedError}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      return postSendMessage(body, attempt + 1);
    }
    console.warn(`[WAsender] request error status=${status} error=${trimmedError}`);
    throw new WasenderRequestError(axiosErr.message, status, responseBody);
  }
}

export async function sendText(input: SendTextInput): Promise<SendResult> {
  return postSendMessage({ to: input.to, text: input.text });
}

export async function sendImage(input: SendImageInput): Promise<SendResult> {
  const body: Record<string, unknown> = {
    to: input.to,
    imageUrl: input.imageUrl,
  };
  if (input.text) body.text = input.text;
  return postSendMessage(body);
}
