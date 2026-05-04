/**
 * Langfuse cost audit — queries the last N hours of observations from the
 * tenant's Langfuse project and prints a cost breakdown so we can see where
 * the money is going. No SDK-only methods used; hits the public REST API
 * with basic auth (public key as username, secret key as password) so it
 * works against any Langfuse self-host or cloud project.
 *
 * Run:
 *   cd backend && npx tsx scripts/langfuse-cost-audit.ts            # last 24h
 *   cd backend && npx tsx scripts/langfuse-cost-audit.ts --hours 6  # last 6h
 *   cd backend && npx tsx scripts/langfuse-cost-audit.ts --name tuning  # filter
 *
 * Reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST from env.
 * Writes nothing back — pure read-only.
 */
import 'dotenv/config';

interface Observation {
  id: string;
  traceId: string;
  name: string | null;
  model: string | null;
  startTime: string | null;
  endTime: string | null;
  type: string | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
  metadata?: Record<string, unknown> | null;
}

function parseArgs(): { hours: number; nameFilter: string | null } {
  const args = process.argv.slice(2);
  let hours = 24;
  let nameFilter: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--hours' && args[i + 1]) {
      hours = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === '--name' && args[i + 1]) {
      nameFilter = args[i + 1];
      i += 1;
    }
  }
  return { hours, nameFilter };
}

async function fetchAllObservations(opts: {
  baseUrl: string;
  auth: string;
  fromStartTime: string;
}): Promise<Observation[]> {
  const all: Observation[] = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const url = new URL(`${opts.baseUrl}/api/public/observations`);
    url.searchParams.set('fromStartTime', opts.fromStartTime);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${opts.auth}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Langfuse API ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { data: Observation[]; meta?: { totalPages?: number } };
    all.push(...(body.data ?? []));
    const totalPages = body.meta?.totalPages ?? 1;
    if (page >= totalPages || (body.data?.length ?? 0) < limit) break;
    page += 1;
  }
  return all;
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function sumCosts(rows: Observation[]): number {
  return rows.reduce(
    (s, o) =>
      s +
      Object.values(o.costDetails ?? {}).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0),
    0,
  );
}

function sumUsage(rows: Observation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of rows) {
    for (const [k, v] of Object.entries(o.usageDetails ?? {})) {
      if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

async function main() {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    console.error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing in env. Aborting.');
    process.exit(1);
  }
  const baseUrl = LANGFUSE_HOST || 'https://cloud.langfuse.com';
  const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');

  const { hours, nameFilter } = parseArgs();
  const fromStartTime = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  console.log(`\nFetching observations since ${fromStartTime} (last ${hours}h)…`);

  const all = await fetchAllObservations({ baseUrl, auth, fromStartTime });
  console.log(`Fetched ${all.length} observations.`);

  // 2026-05-04 — show ALL spans first, then split into "with token data"
  // vs "without". Spans without token data are typically tool/memory spans
  // that wrap a non-LLM operation; they help count round-trips but don't
  // contribute to cost.
  const withUsage = all.filter((o) => o.usageDetails && Object.keys(o.usageDetails).length > 0);
  const withoutUsage = all.filter(
    (o) => !o.usageDetails || Object.keys(o.usageDetails).length === 0,
  );
  console.log(
    `  ${withUsage.length} have token usage (LLM calls)  |  ${withoutUsage.length} are non-LLM spans`,
  );

  // ─── Span name breakdown across ALL spans (helps see what's instrumented)
  const allByName = new Map<string, number>();
  for (const o of all) {
    const name = o.name ?? '<unnamed>';
    allByName.set(name, (allByName.get(name) ?? 0) + 1);
  }
  const allByNameRows = [...allByName.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n─── ALL SPAN NAMES (count, includes non-LLM) ─────────────────');
  for (const [name, count] of allByNameRows.slice(0, 25)) {
    const hasUsage = all.some(
      (o) =>
        (o.name ?? '<unnamed>') === name &&
        o.usageDetails &&
        Object.keys(o.usageDetails).length > 0,
    );
    console.log(`  ×${String(count).padStart(4)}  ${hasUsage ? '[LLM]' : '[span]'}  ${name}`);
  }

  let scoped = withUsage;
  if (nameFilter) {
    scoped = scoped.filter((o) => (o.name ?? '').toLowerCase().includes(nameFilter.toLowerCase()));
    console.log(`After --name "${nameFilter}" filter: ${scoped.length} observations.`);
  }

  // ─── Top-line ────────────────────────────────────────────────────────────
  const totalCost = sumCosts(scoped);
  const totalUsage = sumUsage(scoped);
  console.log('\n─── TOTAL ────────────────────────────────────────────────────');
  console.log(`Cost:   ${fmtUSD(totalCost)}`);
  console.log(`Tokens: ${Object.entries(totalUsage)
    .map(([k, v]) => `${k}=${fmtTokens(v)}`)
    .join('  ')}`);
  console.log(`Calls:  ${scoped.length}`);

  // ─── By name (operation/tool) ────────────────────────────────────────────
  const byName = new Map<string, Observation[]>();
  for (const o of scoped) {
    const name = o.name ?? '<unnamed>';
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(o);
  }
  const byNameRows = [...byName.entries()]
    .map(([name, rows]) => ({
      name,
      count: rows.length,
      cost: sumCosts(rows),
      usage: sumUsage(rows),
    }))
    .sort((a, b) => b.cost - a.cost);
  console.log('\n─── BY OPERATION / TOOL (sorted by cost) ─────────────────────');
  for (const r of byNameRows.slice(0, 20)) {
    const cacheRead = r.usage.cache_read_input_tokens ?? r.usage.cached_input ?? 0;
    const input = r.usage.input ?? r.usage.input_tokens ?? 0;
    const output = r.usage.output ?? r.usage.output_tokens ?? 0;
    const cacheWrite =
      (r.usage.cache_creation_input_tokens ?? 0) +
      (r.usage.input_cache_write ?? 0);
    console.log(
      `  ${fmtUSD(r.cost).padStart(9)}  ×${String(r.count).padStart(4)}  ` +
        `in=${fmtTokens(input).padStart(6)}  ` +
        `cR=${fmtTokens(cacheRead).padStart(6)}  ` +
        `cW=${fmtTokens(cacheWrite).padStart(6)}  ` +
        `out=${fmtTokens(output).padStart(6)}  ${r.name}`,
    );
  }

  // ─── By trace (conversation turn) ────────────────────────────────────────
  const byTrace = new Map<string, Observation[]>();
  for (const o of scoped) {
    if (!o.traceId) continue;
    if (!byTrace.has(o.traceId)) byTrace.set(o.traceId, []);
    byTrace.get(o.traceId)!.push(o);
  }
  const byTraceRows = [...byTrace.entries()]
    .map(([traceId, rows]) => ({
      traceId,
      rounds: rows.length,
      cost: sumCosts(rows),
      usage: sumUsage(rows),
    }))
    .sort((a, b) => b.cost - a.cost);
  console.log('\n─── TOP TRACES BY COST (each = one user turn) ────────────────');
  for (const r of byTraceRows.slice(0, 15)) {
    const cacheRead = r.usage.cache_read_input_tokens ?? 0;
    const input = r.usage.input ?? 0;
    const output = r.usage.output ?? 0;
    console.log(
      `  ${fmtUSD(r.cost).padStart(9)}  ×${String(r.rounds).padStart(3)}rounds  ` +
        `in=${fmtTokens(input).padStart(6)}  ` +
        `cR=${fmtTokens(cacheRead).padStart(6)}  ` +
        `out=${fmtTokens(output).padStart(6)}  ${r.traceId.slice(0, 16)}…`,
    );
  }

  // ─── Round-trip distribution (uses metadata.roundIndex from feature 047 PR 1) ─
  // Pre-feature-047 traces only have one rolled-up generation, so rounds=1.
  // Post-feature-047 traces have one generation per messages.create round.
  const roundCounts = byTraceRows.map((r) => r.rounds).sort((a, b) => a - b);
  if (roundCounts.length > 0) {
    const median = roundCounts[Math.floor(roundCounts.length / 2)];
    const p90 = roundCounts[Math.floor(roundCounts.length * 0.9)] ?? roundCounts[roundCounts.length - 1];
    const max = roundCounts[roundCounts.length - 1];
    const avg = roundCounts.reduce((a, b) => a + b, 0) / roundCounts.length;
    console.log('\n─── ROUND-TRIPS PER TRACE ────────────────────────────────────');
    console.log(
      `  traces=${roundCounts.length}  avg=${avg.toFixed(1)}  ` +
        `median=${median}  p90=${p90}  max=${max}`,
    );

    // Feature 047 PR 1 — surface per-round metric distribution when
    // roundIndex metadata is present. This is the post-instrumentation
    // signal that lets us track p90 per-round input tokens.
    const observationsWithRoundIndex = scoped.filter(
      (o) =>
        typeof (o.metadata as Record<string, unknown> | null)?.['roundIndex'] === 'number',
    );
    if (observationsWithRoundIndex.length > 0) {
      const perRoundInputs = observationsWithRoundIndex
        .map((o) => {
          const u = o.usageDetails ?? {};
          return (
            (u.input ?? u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0)
          );
        })
        .sort((a, b) => a - b);
      const pmedian = perRoundInputs[Math.floor(perRoundInputs.length / 2)];
      const pp90 =
        perRoundInputs[Math.floor(perRoundInputs.length * 0.9)] ??
        perRoundInputs[perRoundInputs.length - 1];
      const pmax = perRoundInputs[perRoundInputs.length - 1];
      console.log(
        `  per-round input tokens: median=${fmtTokens(pmedian)}  p90=${fmtTokens(pp90)}  max=${fmtTokens(pmax)}  (n=${perRoundInputs.length} rounds)`,
      );
    }
  }

  // ─── Cache hit ratio ─────────────────────────────────────────────────────
  const totalInput = totalUsage.input ?? totalUsage.input_tokens ?? 0;
  const totalCacheRead = totalUsage.cache_read_input_tokens ?? 0;
  const totalCacheWrite =
    (totalUsage.cache_creation_input_tokens ?? 0) + (totalUsage.input_cache_write ?? 0);
  const allInput = totalInput + totalCacheRead + totalCacheWrite;
  if (allInput > 0) {
    const pctRead = (100 * totalCacheRead) / allInput;
    const pctFresh = (100 * totalInput) / allInput;
    const pctWrite = (100 * totalCacheWrite) / allInput;
    console.log('\n─── CACHE HIT RATIO ──────────────────────────────────────────');
    console.log(
      `  fresh=${pctFresh.toFixed(1)}%  cache_read=${pctRead.toFixed(1)}%  ` +
        `cache_write=${pctWrite.toFixed(1)}%  (of all input tokens)`,
    );
  }

  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
