/**
 * Langfuse trace inspector — pull ONE recent trace for the tuning-agent and
 * print its full span tree with sizes and timing, so we can see exactly what
 * the agent fetched, in what order, and how big each return was.
 *
 * Run:
 *   cd backend && npx tsx scripts/langfuse-trace-detail.ts                  # latest tuning-agent trace
 *   cd backend && npx tsx scripts/langfuse-trace-detail.ts --traceId <id>   # specific trace
 *   cd backend && npx tsx scripts/langfuse-trace-detail.ts --hours 4        # latest in last 4h
 *
 * Reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST from env.
 */
import 'dotenv/config';

interface Observation {
  id: string;
  traceId: string;
  parentObservationId?: string | null;
  name: string | null;
  type: string | null;
  startTime: string | null;
  endTime: string | null;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown> | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
}

interface Trace {
  id: string;
  name: string | null;
  timestamp?: string | null;
  metadata?: Record<string, unknown> | null;
  observations?: Observation[];
}

function parseArgs(): { hours: number; traceId: string | null } {
  const args = process.argv.slice(2);
  let hours = 24;
  let traceId: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--hours' && args[i + 1]) {
      hours = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === '--traceId' && args[i + 1]) {
      traceId = args[i + 1];
      i += 1;
    }
  }
  return { hours, traceId };
}

async function fetchJson<T>(url: string | URL, auth: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Langfuse ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / 3.6);
}

function payloadSize(v: unknown): { chars: number; tokens: number } {
  if (v == null) return { chars: 0, tokens: 0 };
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return { chars: s.length, tokens: approxTokens(s) };
}

function fmtMs(startISO: string | null, endISO: string | null): string {
  if (!startISO || !endISO) return '   --';
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  if (ms < 1000) return `${ms.toString().padStart(4)}ms`;
  return `${(ms / 1000).toFixed(2).padStart(5)}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

async function main() {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    console.error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing in env. Aborting.');
    process.exit(1);
  }
  const baseUrl = LANGFUSE_HOST || 'https://cloud.langfuse.com';
  const auth = Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');
  const { hours, traceId: targetTraceId } = parseArgs();

  let traceId = targetTraceId;

  // Find the most recent tuning-agent trace if no id provided
  if (!traceId) {
    const fromTimestamp = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const url = new URL(`${baseUrl}/api/public/traces`);
    url.searchParams.set('fromTimestamp', fromTimestamp);
    url.searchParams.set('limit', '50');
    url.searchParams.set('orderBy', 'timestamp.desc');
    const body = await fetchJson<{ data: Trace[] }>(url, auth);
    const tuning = (body.data ?? []).find(
      (t) => (t.name ?? '').toLowerCase().includes('tuning'),
    );
    if (!tuning) {
      console.error(
        `No traces with "tuning" in name in the last ${hours}h. Found ${body.data?.length ?? 0} other traces.`,
      );
      console.error('Recent trace names:');
      for (const t of (body.data ?? []).slice(0, 10)) {
        console.error(`  - ${t.name} (${t.id.slice(0, 12)}…)`);
      }
      process.exit(1);
    }
    traceId = tuning.id;
    console.log(`Latest tuning trace: ${tuning.name}  ${traceId}\n`);
  }

  // Fetch the trace with its full observations tree
  const traceUrl = `${baseUrl}/api/public/traces/${traceId}`;
  const trace = await fetchJson<Trace>(traceUrl, auth);

  console.log('═'.repeat(80));
  console.log(`TRACE  ${trace.id}`);
  console.log(`  name:     ${trace.name ?? '<unnamed>'}`);
  console.log(`  started:  ${trace.timestamp ?? '?'}`);
  if (trace.metadata) {
    console.log(`  metadata: ${JSON.stringify(trace.metadata)}`);
  }
  console.log('═'.repeat(80));

  const obs = trace.observations ?? [];
  obs.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return ta - tb;
  });

  if (obs.length === 0) {
    console.log('(no observations attached)');
    return;
  }

  // Print chronological list
  console.log(
    '\n' +
      ' #  '.padEnd(4) +
      'duration  type        '.padEnd(22) +
      'in     out    '.padEnd(15) +
      'name',
  );
  console.log('─'.repeat(80));
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  for (let i = 0; i < obs.length; i += 1) {
    const o = obs[i];
    const dur = fmtMs(o.startTime, o.endTime);
    const type = (o.type ?? 'span').toLowerCase();
    const inSz = payloadSize(o.input);
    const outSz = payloadSize(o.output);
    const u = o.usageDetails ?? {};
    const usageIn =
      (u.input ?? u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    const usageOut = u.output ?? u.output_tokens ?? 0;
    if (usageIn > 0 || usageOut > 0) {
      totalIn += usageIn;
      totalOut += usageOut;
      totalCacheRead += u.cache_read_input_tokens ?? 0;
      totalCacheWrite += u.cache_creation_input_tokens ?? 0;
    }
    const sizes =
      usageIn > 0
        ? `${fmtTokens(usageIn).padStart(6)} ${fmtTokens(usageOut).padStart(5)}T`
        : `${fmtTokens(inSz.tokens).padStart(6)} ${fmtTokens(outSz.tokens).padStart(5)} `;
    console.log(
      `${String(i + 1).padStart(2)}. ` +
        dur.padEnd(9) +
        ' ' +
        type.padEnd(11) +
        ' ' +
        sizes +
        '  ' +
        (o.name ?? '<unnamed>'),
    );
  }
  console.log('─'.repeat(80));
  console.log(
    `LLM totals: input(fresh+cache)=${fmtTokens(totalIn)}  output=${fmtTokens(totalOut)}  ` +
      `cache_read=${fmtTokens(totalCacheRead)}  cache_write=${fmtTokens(totalCacheWrite)}`,
  );

  // ─── Tool-call breakdown with output sizes ───
  console.log('\n─── TOOL CALL DETAIL (tool spans only) ───');
  const toolSpans = obs.filter(
    (o) =>
      (o.name ?? '').includes('build-tune-agent.') ||
      (o.name ?? '').startsWith('tool:') ||
      (o.name ?? '').includes('tuning-agent.') &&
        !((o.name ?? '').includes('hook.') || (o.name ?? '').includes('.query')),
  );
  for (const t of toolSpans) {
    const outSz = payloadSize(t.output);
    const inSz = payloadSize(t.input);
    console.log(
      `  ${(t.name ?? '').padEnd(50)}  in=${String(inSz.chars).padStart(5)}c/${String(inSz.tokens).padStart(4)}t  out=${String(outSz.chars).padStart(6)}c/${String(outSz.tokens).padStart(5)}t  ${fmtMs(t.startTime, t.endTime)}`,
    );
  }

  // ─── Big tool returns (output > 1000 chars) ───
  const big = obs
    .filter((o) => payloadSize(o.output).chars > 1000)
    .sort((a, b) => payloadSize(b.output).chars - payloadSize(a.output).chars);
  if (big.length > 0) {
    console.log('\n─── LARGEST TOOL RETURNS ───');
    for (const o of big.slice(0, 8)) {
      const sz = payloadSize(o.output);
      console.log(`  ${fmtTokens(sz.tokens).padStart(6)}T  ${o.name}`);
    }
  }

  // ─── Console-friendly excerpt of one large return for inspection ───
  if (big.length > 0) {
    const first = big[0];
    const sample = JSON.stringify(first.output ?? '').slice(0, 400);
    console.log(`\nSample of largest return (${first.name}):\n  ${sample}…`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
