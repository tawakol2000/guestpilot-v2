/**
 * Feature 047 PR 3 — markdown section extractor.
 *
 * Pure function (no I/O). Splits a markdown body into named sections by
 * `##` and `###` heading lines. Falls back to a single-section list (with
 * the artifact title as the section name) when no headings are found.
 *
 * Used by studio_get_artifact's `mode:'index'` and `section:'<name>'`
 * branches to enable section-level drill-down on system prompts and SOPs.
 *
 * Heuristic per research.md R1:
 *   - Heading boundaries: lines matching ^##\s+ or ^###\s+
 *   - Section name: heading text (stripped of `##`/`###` + whitespace)
 *   - Section body: lines from the heading through the line before the
 *     next heading (or to EOF for the last section)
 *   - Section summary: first non-empty paragraph after the heading,
 *     capped at 80 chars with `…` appended if truncated
 *   - Section tokens: Math.ceil(body.length / 3.6) (matches measure-prompt.ts)
 *   - Section hashId: HMAC-SHA256(tenantId|artifactId|name|body[:200])[:16]
 *     so the agent can pass section identity back without forging.
 */
import { createHmac } from 'node:crypto';

const HEADING_RE = /^(##{1,2})\s+(.*?)\s*$/gm;
const TOKEN_DIVISOR = 3.6;
const SUMMARY_MAX_CHARS = 80;

export interface Section {
  name: string;
  summary: string;
  body: string;
  tokens: number;
  hashId: string;
}

export interface SectionSignContext {
  tenantId: string;
  artifactId: string;
  secret: string;
}

function approxTokens(s: string): number {
  return Math.ceil(s.length / TOKEN_DIVISOR);
}

function firstParagraphSummary(body: string): string {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(```|>|---)/.test(trimmed)) continue;
    if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
    return trimmed.slice(0, SUMMARY_MAX_CHARS - 1) + '…';
  }
  return '';
}

function hashSection(
  ctx: SectionSignContext,
  name: string,
  body: string,
): string {
  const mac = createHmac('sha256', ctx.secret);
  mac.update(`${ctx.tenantId}|${ctx.artifactId}|${name}|${body.slice(0, 200)}`);
  return mac.digest('hex').slice(0, 16);
}

export function extractSections(
  body: string,
  fallbackTitle: string,
  signCtx: SectionSignContext,
): Section[] {
  if (!body || body.length === 0) return [];

  const headings: { idx: number; level: number; name: string; lineEnd: number }[] = [];
  HEADING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_RE.exec(body)) !== null) {
    const lineEnd = body.indexOf('\n', match.index);
    headings.push({
      idx: match.index,
      level: match[1].length,
      name: match[2].trim(),
      lineEnd: lineEnd >= 0 ? lineEnd : body.length,
    });
  }

  if (headings.length === 0) {
    const trimmed = body.trim();
    return [
      {
        name: fallbackTitle,
        summary: firstParagraphSummary(body),
        body: trimmed,
        tokens: approxTokens(trimmed),
        hashId: hashSection(signCtx, fallbackTitle, trimmed),
      },
    ];
  }

  const sections: Section[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    const next = headings[i + 1];
    const sectionEnd = next ? next.idx : body.length;
    const bodyStart = h.lineEnd + 1;
    const bodyText = body.slice(bodyStart, sectionEnd).replace(/\s+$/g, '');
    sections.push({
      name: h.name,
      summary: firstParagraphSummary(bodyText),
      body: bodyText,
      tokens: approxTokens(bodyText),
      hashId: hashSection(signCtx, h.name, bodyText),
    });
  }
  return sections;
}
