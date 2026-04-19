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

async function postSendMessage(body: Record<string, unknown>): Promise<SendResult> {
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
    console.warn(`[WAsender] request error status=${status} body=${JSON.stringify(responseBody)}`);
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
