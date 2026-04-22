/**
 * URL safety helpers — block SSRF to internal/private/metadata endpoints.
 *
 * Created 2026-04-23 in response to a security scan that flagged the
 * custom-tool webhook caller (`webhook-tool.service.ts#callWebhook`)
 * as a working SSRF surface: any tenant could create a custom tool
 * with `webhookUrl: https://169.254.169.254/...` (cloud metadata) or
 * `https://10.x.x.x/...` (private network) and the AI pipeline would
 * fetch it on every relevant turn, returning the response body to the
 * tenant via the AI message / preview / trace.
 *
 * Two layers of defence:
 *   1. WRITE-time: Zod refine on `webhookUrl` calls
 *      `isPublicHttpsUrl(url).ok` to reject internal targets up-front.
 *   2. SEND-time: callWebhook calls `assertPublicHttpsUrl(url)` again
 *      before each fetch, defeating DNS rebinding (where the hostname
 *      resolves to a public IP at validation time but a private one
 *      at fetch time).
 *
 * The send-time check resolves the hostname via `dns.lookup` so we
 * see the IP the request will actually hit, not whatever the input
 * string claims.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

const PRIVATE_IPV4_RANGES: Array<[number, number, number, number]> = [
  // [octet1, mask1, octet2, mask2] — only need first 2 octets to prefix-match.
  // 0.0.0.0/8 — "this network"
  [0, 0xff, 0, 0],
  // 10.0.0.0/8
  [10, 0xff, 0, 0],
  // 100.64.0.0/10 — CGNAT
  [100, 0xff, 64, 0xc0],
  // 127.0.0.0/8 — loopback
  [127, 0xff, 0, 0],
  // 169.254.0.0/16 — link-local + AWS IMDS
  [169, 0xff, 254, 0xff],
  // 172.16.0.0/12 — private
  [172, 0xff, 16, 0xf0],
  // 192.0.0.0/24 + 192.0.2.0/24 + 192.88.99.0/24 + 192.168.0.0/16
  [192, 0xff, 0, 0xff],
  [192, 0xff, 168, 0xff],
  // 198.18.0.0/15 — benchmark
  [198, 0xff, 18, 0xfe],
  // 224.0.0.0/4 — multicast
  [224, 0xf0, 0, 0],
  // 240.0.0.0/4 — reserved
  [240, 0xf0, 0, 0],
];

/**
 * Returns true when an IPv4 string is within a blocked range
 * (loopback, link-local, RFC1918, CGNAT, multicast, reserved, etc.).
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  for (const [oa, ma, ob, mb] of PRIVATE_IPV4_RANGES) {
    if ((a & ma) === (oa & ma) && (b & mb) === (ob & mb)) return true;
  }
  return false;
}

/**
 * Returns true when an IPv6 string is link-local, loopback, or
 * unique-local (private). Conservative: any IPv6 address triggers
 * additional scrutiny because v6 NAT/private ranges differ.
 */
function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 loopback
  if (lower === '::1') return true;
  // ::/128 unspecified
  if (lower === '::') return true;
  // fc00::/7 unique-local (fc00.. through fdff..)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10 link-local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // ff00::/8 multicast
  if (lower.startsWith('ff')) return true;
  // ::ffff:a.b.c.d — IPv4-mapped — extract and re-check.
  // Also handles the compressed form (::ffff:7f00:1) that Node's URL
  // parser normalises to: parse the last two hextets as a 32-bit
  // integer and convert to dotted-quad.
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length);
    if (isIP(tail) === 4) return isBlockedIPv4(tail);
    // Compressed form like 7f00:1 → 7f00:0001 → 127.0.0.1
    const parts = tail.split(':');
    if (parts.length === 2) {
      const high = parseInt(parts[0], 16);
      const low = parseInt(parts[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low) && high <= 0xffff && low <= 0xffff) {
        const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        return isBlockedIPv4(v4);
      }
    }
  }
  return false;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.googleapis.com',
]);

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
  resolvedAddress?: string;
}

/**
 * Synchronous, no-DNS check on the URL STRING. Runs at write-time
 * (Zod refine on webhookUrl) to reject obviously-bad inputs up front.
 *
 * Catches:
 *   - non-https schemes
 *   - IP-literal hostnames inside private/loopback/link-local ranges
 *   - blocked hostname strings (localhost, metadata.google.internal, ...)
 *
 * Does NOT catch DNS rebinding — for that, callers must also run
 * `assertPublicHttpsUrl()` at send-time.
 */
export function isPublicHttpsUrl(rawUrl: string): UrlSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'URL must use https:// scheme' };
  }
  // URL.hostname for IPv6 literals returns the address WITH brackets
  // (e.g. "[::1]"). Strip them so isIP() can recognise the address.
  const rawHost = parsed.hostname.toLowerCase();
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  if (!hostname) return { ok: false, reason: 'URL has no hostname' };
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `Hostname "${hostname}" is blocked (private/metadata)` };
  }
  // .local mDNS suffix
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { ok: false, reason: `Hostname suffix on "${hostname}" is private` };
  }
  // IP-literal hostname → check the IP directly
  const ipKind = isIP(hostname);
  if (ipKind === 4 && isBlockedIPv4(hostname)) {
    return { ok: false, reason: `IP ${hostname} is private/loopback/link-local` };
  }
  if (ipKind === 6 && isBlockedIPv6(hostname)) {
    return { ok: false, reason: `IPv6 ${hostname} is private/loopback/link-local` };
  }
  return { ok: true };
}

/**
 * Async send-time check. Resolves the hostname via DNS and rejects if
 * ANY resolved address is in a blocked range (defeats DNS rebinding,
 * where the hostname resolved to a public IP at write-time but to a
 * private one at fetch-time).
 *
 * Throws on rejection (caller wraps in try/catch). Returns the
 * resolved address on success.
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<string> {
  const sync = isPublicHttpsUrl(rawUrl);
  if (!sync.ok) {
    const e: Error & { code?: string } = new Error(`URL_BLOCKED: ${sync.reason}`);
    e.code = 'URL_BLOCKED';
    throw e;
  }
  const parsed = new URL(rawUrl);
  // Strip IPv6 brackets (URL.hostname returns "[::1]" but isIP wants "::1").
  const rawHost = parsed.hostname;
  const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;
  // Skip DNS lookup if the hostname is already an IP literal (we
  // already checked it above).
  if (isIP(hostname) !== 0) return hostname;
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err: any) {
    const e: Error & { code?: string } = new Error(
      `URL_DNS_FAILED: ${hostname} (${err?.code ?? err?.message ?? 'unknown'})`,
    );
    e.code = 'URL_DNS_FAILED';
    throw e;
  }
  if (addrs.length === 0) {
    const e: Error & { code?: string } = new Error(`URL_DNS_EMPTY: ${hostname}`);
    e.code = 'URL_DNS_EMPTY';
    throw e;
  }
  for (const { address, family } of addrs) {
    if (family === 4 && isBlockedIPv4(address)) {
      const e: Error & { code?: string } = new Error(
        `URL_BLOCKED_RESOLVED: ${hostname} → ${address} (private/loopback)`,
      );
      e.code = 'URL_BLOCKED_RESOLVED';
      throw e;
    }
    if (family === 6 && isBlockedIPv6(address)) {
      const e: Error & { code?: string } = new Error(
        `URL_BLOCKED_RESOLVED: ${hostname} → ${address} (private/loopback ipv6)`,
      );
      e.code = 'URL_BLOCKED_RESOLVED';
      throw e;
    }
  }
  // Return the first resolved address (axios will resolve again
  // anyway; this is mainly for logging).
  return addrs[0].address;
}
