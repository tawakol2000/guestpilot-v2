/**
 * Sprint 059-A F1.5 — runtime dispatcher unit tests.
 *
 * Run:  npx tsx --test src/build-tune-agent/__tests__/runtime-dispatcher.test.ts
 *
 * Scope: `runTuningAgentTurn()` branches on `BUILD_AGENT_DIRECT_TRANSPORT`.
 *
 *   1. Flag OFF → `runSdkTurn()` is invoked; direct wiring is NOT called.
 *   2. Flag ON + direct succeeds → direct result is returned verbatim.
 *   3. Flag ON + direct signals fallback → BOTH direct AND sdk are called;
 *      sdk's result is what runtime returns.
 *
 * The two runner modules are stubbed at the require layer so we can observe
 * call order deterministically without touching DB / MCP / hooks.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-runtime-dispatcher';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

type CallLog = string[];

/**
 * Monkey-patch `Module._load` so that imports of `./sdk-runner`,
 * `./direct/wire-direct`, and `./prompt-cache-blocks` resolve to our stubs
 * during the test run. Cleanup restores the original loader.
 */
function installStubs(
  callLog: CallLog,
  config: {
    directEnabled: boolean;
    directOutcome: 'success' | 'fallback' | 'error';
    sdkThrows?: boolean;
  },
) {
  const originalLoad = (Module as any)._load;

  (Module as any)._load = function patched(request: string, parent: any, ...rest: any[]) {
    // Resolve relative `./sdk-runner` imports coming from runtime.ts.
    if (request.endsWith('/sdk-runner') || request === './sdk-runner') {
      return {
        runSdkTurn: async (_input: unknown) => {
          callLog.push('sdk');
          if (config.sdkThrows) throw new Error('sdk-boom');
          return {
            sdkSessionId: 'sess-sdk',
            finalAssistantText: 'sdk-reply',
            toolCallsInvoked: [],
            persistedDataParts: [],
            error: null,
          };
        },
      };
    }
    if (request.endsWith('/direct/wire-direct') || request === './direct/wire-direct') {
      return {
        runDirectTurnWithFullSetup: async (_input: unknown) => {
          callLog.push('direct');
          if (config.directOutcome === 'success') {
            return {
              status: 'success',
              sdkResult: {
                sdkSessionId: 'sess-direct',
                finalAssistantText: 'direct-reply',
                toolCallsInvoked: [],
                persistedDataParts: [],
                error: null,
              },
            };
          }
          if (config.directOutcome === 'fallback') {
            return { status: 'fallback', fallbackReason: 'api_error' };
          }
          return { status: 'error', fallbackReason: 'api_error', message: 'boom' };
        },
      };
    }
    if (request.endsWith('/prompt-cache-blocks') || request === './prompt-cache-blocks') {
      return {
        isDirectTransportEnabled: () => config.directEnabled,
      };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };

  return () => {
    (Module as any)._load = originalLoad;
  };
}

function clearRuntimeCache() {
  // Drop the cached runtime.ts so the NEXT require picks up fresh stubs.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/build-tune-agent/runtime.') || key.endsWith('/build-tune-agent/runtime.ts')) {
      delete require.cache[key];
    }
  }
}

function loadRuntime() {
  // Use require (CJS) to play well with the Module._load patch.
  return require('../runtime') as typeof import('../runtime');
}

beforeEach(() => {
  clearRuntimeCache();
});

afterEach(() => {
  clearRuntimeCache();
});

const FAKE_INPUT = {
  prisma: {} as any,
  tenantId: 't1',
  userId: null,
  conversationId: 'c1',
  userMessage: 'hi',
  selectedSuggestionId: null,
  assistantMessageId: 'asst-1',
  writer: { write: () => {} } as any,
};

// ─── Tests ─────────────────────────────────────────────────────────────

test('F1.5 dispatcher — flag OFF runs SDK path, does NOT touch direct wiring', async () => {
  const log: CallLog = [];
  const restore = installStubs(log, {
    directEnabled: false,
    directOutcome: 'success', // unused
  });
  try {
    const { runTuningAgentTurn } = loadRuntime();
    const result = await runTuningAgentTurn(FAKE_INPUT as any);
    assert.deepEqual(log, ['sdk']);
    assert.equal(result.finalAssistantText, 'sdk-reply');
  } finally {
    restore();
  }
});

test('F1.5 dispatcher — flag ON + direct success returns direct result', async () => {
  const log: CallLog = [];
  const restore = installStubs(log, {
    directEnabled: true,
    directOutcome: 'success',
  });
  try {
    const { runTuningAgentTurn } = loadRuntime();
    const result = await runTuningAgentTurn(FAKE_INPUT as any);
    assert.deepEqual(log, ['direct']);
    assert.equal(result.finalAssistantText, 'direct-reply');
    assert.equal(result.sdkSessionId, 'sess-direct');
  } finally {
    restore();
  }
});

test('F1.5 dispatcher — flag ON + direct fallback falls through to SDK path', async () => {
  const log: CallLog = [];
  const restore = installStubs(log, {
    directEnabled: true,
    directOutcome: 'fallback',
  });
  try {
    const { runTuningAgentTurn } = loadRuntime();
    const result = await runTuningAgentTurn(FAKE_INPUT as any);
    assert.deepEqual(log, ['direct', 'sdk']);
    assert.equal(result.finalAssistantText, 'sdk-reply');
    assert.equal(result.sdkSessionId, 'sess-sdk');
  } finally {
    restore();
  }
});
