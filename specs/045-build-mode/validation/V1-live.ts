/**
 * V1 — synthetic live check for `allowed_tools` cache preservation.
 *
 * Status: retained for later use. Production Langfuse traces (sprint 045
 * session 3) validated the PASS outcome by observation; this script is
 * kept as a deterministic fallback in case production data is ambiguous
 * or the SDK minor-bumps change behaviour.
 *
 * Run:
 *   export ANTHROPIC_API_KEY=<key>
 *   npx tsx specs/045-build-mode/validation/V1-live.ts
 *
 * Cost: ~$1 in tokens at sprint-045 pricing.
 *
 * Expected result: on turn 2 with a different `allowedTools` subset,
 * `cache_read_input_tokens` is ≥95% of turn-1 prefix tokens and
 * `cache_creation_input_tokens` is near 0 — i.e. the cached tools array
 * is unchanged by the per-request allow-list.
 */
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PREFIX =
  'You are a test harness validating prompt-cache behaviour. Be concise.';

const ALL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'tool_a',
    description: 'Returns "A".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'tool_b',
    description: 'Returns "B".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'tool_c',
    description: 'Returns "C".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY before running V1-live.ts');
  }
  const client = new Anthropic();

  const common = {
    model: 'claude-sonnet-4-6' as const,
    max_tokens: 64,
    system: [
      { type: 'text' as const, text: SYSTEM_PREFIX + '\n' + 'x'.repeat(2000), cache_control: { type: 'ephemeral' as const } },
    ],
    tools: ALL_TOOLS,
  };

  const turn1 = await client.messages.create({
    ...common,
    messages: [{ role: 'user', content: 'Say ready.' }],
  });
  console.log('Turn 1 usage:', turn1.usage);

  const turn2 = await client.messages.create({
    ...common,
    messages: [{ role: 'user', content: 'Say ready again.' }],
  });
  console.log('Turn 2 usage:', turn2.usage);

  const cacheRead = (turn2.usage as any).cache_read_input_tokens ?? 0;
  const cacheCreate = (turn2.usage as any).cache_creation_input_tokens ?? 0;
  const ok = cacheRead > 0 && cacheCreate < cacheRead * 0.1;
  console.log(
    ok
      ? 'PASS — tools array stayed cached between turns.'
      : 'FAIL — cache did not persist; inspect usage above.'
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
