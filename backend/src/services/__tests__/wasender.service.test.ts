/**
 * Tests for the WAsender 429 retry behavior added 2026-05-16 after a
 * production handoff for Apartment 103 delivered 1/3 passport images:
 * WAsender returned "send 1 message every 5 seconds" and the caller had
 * no retry, so a single 429 abandoned the rest of the loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  __setHttpClient,
  sendImage,
  sendText,
  WasenderRequestError,
} from '../wasender.service';

function makeMockAxios(
  responses: Array<{ status?: number; data?: any; throwAxios?: boolean }>,
) {
  let i = 0;
  const calls: Array<{ url: string; body: any }> = [];
  const mock = {
    post: async (url: string, body: any) => {
      calls.push({ url, body });
      const r = responses[i++];
      if (!r) throw new Error(`mock ran out of responses (got call #${i})`);
      if (r.throwAxios || (r.status && r.status >= 400)) {
        const err: any = new axios.AxiosError(
          'Request failed with status code ' + r.status,
          'ERR_BAD_REQUEST',
        );
        err.response = { status: r.status, data: r.data };
        throw err;
      }
      return { status: r.status ?? 200, data: r.data };
    },
  } as any;
  return { mock, calls };
}

test('sendText: success on first call returns providerMessageId', async () => {
  process.env.WASENDER_API_KEY = 'test';
  const { mock, calls } = makeMockAxios([
    { status: 200, data: { data: { msgId: '111' } } },
  ]);
  __setHttpClient(mock);
  try {
    const result = await sendText({ to: '+201001661803', text: 'hi' });
    assert.equal(result.providerMessageId, '111');
    assert.equal(calls.length, 1);
  } finally {
    __setHttpClient(null);
  }
});

test('sendImage: 429 with "every 5 seconds" message → retries once after parsed wait, succeeds', async () => {
  process.env.WASENDER_API_KEY = 'test';
  const { mock, calls } = makeMockAxios([
    {
      status: 429,
      data: { error: 'You can only send 1 message every 5 seconds.' },
    },
    { status: 200, data: { data: { msgId: '222' } } },
  ]);
  __setHttpClient(mock);
  try {
    const started = Date.now();
    const result = await sendImage({
      to: '+201001661803',
      imageUrl: 'https://example.com/p2.jpg',
    });
    const elapsed = Date.now() - started;
    assert.equal(result.providerMessageId, '222');
    assert.equal(calls.length, 2);
    // 5 seconds + 500ms safety margin parsed from the error message.
    assert.ok(elapsed >= 5_000, `expected ≥5s wait, got ${elapsed}ms`);
    assert.ok(elapsed < 7_000, `expected <7s, got ${elapsed}ms`);
  } finally {
    __setHttpClient(null);
  }
});

test('sendImage: 429 without parseable wait hint → uses 6s fallback', async () => {
  process.env.WASENDER_API_KEY = 'test';
  const { mock, calls } = makeMockAxios([
    { status: 429, data: { error: 'too many requests' } },
    { status: 200, data: { data: { msgId: '333' } } },
  ]);
  __setHttpClient(mock);
  try {
    const started = Date.now();
    await sendImage({ to: '+201001661803', imageUrl: 'https://example.com/p2.jpg' });
    const elapsed = Date.now() - started;
    assert.equal(calls.length, 2);
    assert.ok(elapsed >= 6_000, `expected ≥6s fallback wait, got ${elapsed}ms`);
    assert.ok(elapsed < 8_000, `expected <8s, got ${elapsed}ms`);
  } finally {
    __setHttpClient(null);
  }
});

test('sendImage: second 429 after retry → throws (no infinite loop)', async () => {
  process.env.WASENDER_API_KEY = 'test';
  const { mock, calls } = makeMockAxios([
    { status: 429, data: { error: 'every 1 second' } },
    { status: 429, data: { error: 'every 1 second' } },
  ]);
  __setHttpClient(mock);
  try {
    await assert.rejects(
      sendImage({ to: '+201001661803', imageUrl: 'https://example.com/p2.jpg' }),
      WasenderRequestError,
    );
    assert.equal(calls.length, 2, 'expected exactly 2 attempts, no third retry');
  } finally {
    __setHttpClient(null);
  }
});

test('sendImage: non-429 4xx is not retried', async () => {
  process.env.WASENDER_API_KEY = 'test';
  const { mock, calls } = makeMockAxios([
    { status: 400, data: { error: 'invalid recipient' } },
  ]);
  __setHttpClient(mock);
  try {
    await assert.rejects(
      sendImage({ to: 'not-a-phone', imageUrl: 'https://example.com/p.jpg' }),
      WasenderRequestError,
    );
    assert.equal(calls.length, 1, 'expected no retry on 400');
  } finally {
    __setHttpClient(null);
  }
});
