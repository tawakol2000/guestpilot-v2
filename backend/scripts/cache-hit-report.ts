/**
 * Cache hit-rate dashboard over an arbitrary window.
 *
 * Reads AiApiLog rows and aggregates by (agent, model). Reports
 * input/cached/output/reasoning tokens, hit rate %, cost, and avg
 * latency. Falls back to parsing ragContext.cachedInputTokens for
 * legacy rows written before the cachedInputTokens column landed.
 *
 * Usage:
 *   npx tsx scripts/cache-hit-report.ts                # last 24h
 *   npx tsx scripts/cache-hit-report.ts 168            # last 7d (hours)
 *   npx tsx scripts/cache-hit-report.ts 24 <tenantId>  # tenant-scoped
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const hours = Number(process.argv[2] ?? 24);
  const tenantId = process.argv[3];
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error('Usage: tsx scripts/cache-hit-report.ts [hours=24] [tenantId]');
    process.exit(1);
  }
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await prisma.aiApiLog.findMany({
    where: {
      createdAt: { gte: since },
      ...(tenantId ? { tenantId } : {}),
    },
    select: {
      agentName: true,
      model: true,
      inputTokens: true,
      cachedInputTokens: true,
      reasoningTokens: true,
      outputTokens: true,
      costUsd: true,
      durationMs: true,
      ragContext: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Window: last ${hours}h${tenantId ? ` (tenant=${tenantId})` : ''}`);
  console.log(`Rows: ${rows.length}`);
  console.log('');

  type Bucket = {
    n: number;
    input: number;
    cached: number;
    output: number;
    reasoning: number;
    cost: number;
    durations: number[];
  };
  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    // First-class columns are authoritative. Fall back to ragContext
    // for legacy rows where cachedInputTokens column was 0 but
    // ragContext.cachedInputTokens was set.
    const rag: any = r.ragContext ?? {};
    const cached =
      r.cachedInputTokens > 0
        ? r.cachedInputTokens
        : typeof rag.cachedInputTokens === 'number'
          ? rag.cachedInputTokens
          : 0;
    const reasoning =
      r.reasoningTokens > 0
        ? r.reasoningTokens
        : typeof rag.reasoningTokens === 'number'
          ? rag.reasoningTokens
          : 0;
    const key = `${r.agentName || '(none)'} | ${r.model}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        n: 0,
        input: 0,
        cached: 0,
        output: 0,
        reasoning: 0,
        cost: 0,
        durations: [],
      });
    }
    const b = buckets.get(key)!;
    b.n++;
    b.input += r.inputTokens;
    b.cached += cached;
    b.output += r.outputTokens;
    b.reasoning += reasoning;
    b.cost += r.costUsd;
    b.durations.push(r.durationMs);
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].input - a[1].input);

  console.log(
    'agent | model'.padEnd(50) +
      'n   '.padStart(5) +
      'input'.padStart(11) +
      'cached'.padStart(11) +
      'hit%'.padStart(7) +
      'output'.padStart(10) +
      'reason'.padStart(10) +
      'cost'.padStart(10) +
      'avg_ms'.padStart(8),
  );
  console.log('-'.repeat(122));
  let totalInput = 0;
  let totalCached = 0;
  let totalCost = 0;
  for (const [key, b] of sorted) {
    const hit = b.input > 0 ? (100 * b.cached) / b.input : 0;
    const avgMs = b.durations.length > 0 ? b.durations.reduce((s, v) => s + v, 0) / b.durations.length : 0;
    console.log(
      key.slice(0, 49).padEnd(50) +
        String(b.n).padStart(5) +
        b.input.toLocaleString().padStart(11) +
        b.cached.toLocaleString().padStart(11) +
        `${hit.toFixed(1)}%`.padStart(7) +
        b.output.toLocaleString().padStart(10) +
        b.reasoning.toLocaleString().padStart(10) +
        `$${b.cost.toFixed(3)}`.padStart(10) +
        `${avgMs.toFixed(0)}ms`.padStart(8),
    );
    totalInput += b.input;
    totalCached += b.cached;
    totalCost += b.cost;
  }
  console.log('-'.repeat(122));
  const totalHit = totalInput > 0 ? (100 * totalCached) / totalInput : 0;
  console.log(
    `TOTAL ${rows.length} calls | input ${totalInput.toLocaleString()} | cached ${totalCached.toLocaleString()} | hit ${totalHit.toFixed(1)}% | cost $${totalCost.toFixed(2)}`,
  );
}

main()
  .catch((err) => {
    console.error('cache-hit-report failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
