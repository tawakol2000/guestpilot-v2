/**
 * Sprint 060-D Phase 5 — structured-output card extractor.
 *
 * Replaces the `ask_manager` and `emit_audit` tools. The agent now emits
 * card payloads as `<data-*>...</data-*>` blocks inside its assistant text.
 * The SSE bridge feeds streaming text deltas through this extractor; the
 * extractor strips the blocks from the visible-text stream and surfaces
 * them as `data-question-choices` / `data-audit-report` SSE parts.
 *
 * State machine: a single buffered `pending` string + an optional `active`
 * block accumulator. Because text arrives as chunked deltas, the extractor
 * holds back any trailing prefix that could complete an opening tag (e.g.
 * a chunk ending in `<da` is held until the next chunk resolves it). Once
 * an opening tag is seen, all bytes are routed into the JSON buffer until
 * the matching closing tag arrives, at which point the JSON is parsed and
 * emitted as a data-part. Mismatched closing tags / parse errors surface
 * as `errors` on the output; callers decide what to do (today the bridge
 * logs and drops the malformed block — the model can re-emit on retry).
 */
import { DATA_PART_TYPES } from './data-parts';

const TAG_TO_PART_TYPE: Record<string, string> = {
  'data-question-choices': DATA_PART_TYPES.question_choices,
  'data-audit-report': DATA_PART_TYPES.audit_report,
};

const KNOWN_TAGS = Object.keys(TAG_TO_PART_TYPE);

export interface ExtractorState {
  /** Buffered text not yet committed to safeText (may contain a partial tag). */
  pending: string;
  /** When inside a `<data-*>` block, accumulator for its JSON body. */
  active: { tag: string; partType: string; jsonBuf: string } | null;
}

export interface ExtractorOutput {
  /** Visible text safe to forward to the user. */
  safeText: string;
  /** Complete `<data-*>` blocks ready to be emitted as SSE data-parts. */
  emittedDataParts: Array<{ partType: string; data: unknown }>;
  /** Non-fatal warnings (e.g. unparseable JSON inside a block). */
  errors: string[];
}

export function makeExtractorState(): ExtractorState {
  return { pending: '', active: null };
}

export function feedExtractor(state: ExtractorState, chunk: string): ExtractorOutput {
  const out: ExtractorOutput = { safeText: '', emittedDataParts: [], errors: [] };
  state.pending += chunk;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (state.active) {
      const closeTag = `</${state.active.tag}>`;
      const closeIdx = state.pending.indexOf(closeTag);
      if (closeIdx >= 0) {
        const jsonText = state.active.jsonBuf + state.pending.slice(0, closeIdx);
        const partType = state.active.partType;
        try {
          const parsed = JSON.parse(jsonText.trim());
          out.emittedDataParts.push({ partType, data: parsed });
        } catch (err) {
          out.errors.push(
            `failed to parse ${state.active.tag} payload: ${(err as Error).message}`,
          );
        }
        state.pending = state.pending.slice(closeIdx + closeTag.length);
        state.active = null;
        continue; // remaining text may contain another block
      }
      // No closing tag yet. Hold back trailing chars that could be the
      // start of a closing tag; commit the rest to jsonBuf.
      const tailHold = closingTagPartialLength(state.pending, closeTag);
      const safeJson = state.pending.slice(0, state.pending.length - tailHold);
      state.active.jsonBuf += safeJson;
      state.pending = state.pending.slice(safeJson.length);
      return out;
    }

    // Look for the earliest opening tag.
    let earliestIdx = -1;
    let earliestTag: string | null = null;
    for (const tag of KNOWN_TAGS) {
      const openTag = `<${tag}>`;
      const idx = state.pending.indexOf(openTag);
      if (idx >= 0 && (earliestIdx === -1 || idx < earliestIdx)) {
        earliestIdx = idx;
        earliestTag = tag;
      }
    }
    if (earliestIdx >= 0 && earliestTag) {
      const openTag = `<${earliestTag}>`;
      out.safeText += state.pending.slice(0, earliestIdx);
      state.pending = state.pending.slice(earliestIdx + openTag.length);
      state.active = {
        tag: earliestTag,
        partType: TAG_TO_PART_TYPE[earliestTag],
        jsonBuf: '',
      };
      continue;
    }
    // No opening tag found. Hold back any trailing partial-tag prefix.
    const heldBack = openingTagPartialLength(state.pending);
    const safe = state.pending.slice(0, state.pending.length - heldBack);
    out.safeText += safe;
    state.pending = state.pending.slice(safe.length);
    return out;
  }
}

/**
 * Flush any buffered text at end of a text block / end of stream.
 * If still inside an unclosed block, the buffered JSON is dropped and a
 * warning surfaces; the model can re-emit on retry.
 */
export function flushExtractor(state: ExtractorState): ExtractorOutput {
  const out: ExtractorOutput = { safeText: '', emittedDataParts: [], errors: [] };
  if (state.active) {
    out.errors.push(`stream ended with unclosed ${state.active.tag} block`);
    state.active = null;
  }
  out.safeText = state.pending;
  state.pending = '';
  return out;
}

/**
 * Number of trailing chars in `pending` that match a prefix of any known
 * opening tag (e.g. `<` or `<da` could complete to `<data-...>`).
 */
function openingTagPartialLength(pending: string): number {
  const lastLT = pending.lastIndexOf('<');
  if (lastLT < 0) return 0;
  const candidate = pending.slice(lastLT);
  for (const tag of KNOWN_TAGS) {
    const openTag = `<${tag}>`;
    if (openTag.startsWith(candidate) && openTag !== candidate) {
      return candidate.length;
    }
  }
  return 0;
}

/** Trailing chars that could be a prefix of `closeTag`. */
function closingTagPartialLength(pending: string, closeTag: string): number {
  const maxCheck = Math.min(closeTag.length - 1, pending.length);
  for (let n = maxCheck; n > 0; n -= 1) {
    if (closeTag.startsWith(pending.slice(pending.length - n))) {
      return n;
    }
  }
  return 0;
}

/**
 * Wrap a UIMessageChunk writer so streaming `text-delta` chunks are
 * routed through the extractor. Complete `<data-*>` blocks are stripped
 * from visible text and emitted via `emitDataPart`; the visible remainder
 * flows through with the same chunk id. On `text-end`, any held-back
 * trailing partial tag is flushed as a final delta.
 */
export function wrapWriterWithExtractor(
  rawWrite: (chunk: any) => void,
  emitDataPart: (part: { type: string; id?: string; data: unknown; transient?: boolean }) => void,
  state: ExtractorState,
): (chunk: any) => void {
  const ids = new Set<string>();
  const emitParts = (parts: ExtractorOutput['emittedDataParts']) => {
    for (const part of parts) {
      const id = `${part.partType}:${Date.now().toString(36)}:${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      emitDataPart({ type: part.partType, id, data: part.data });
    }
  };
  return (chunk: any) => {
    if (chunk?.type === 'text-delta' && typeof chunk.delta === 'string' && chunk.id) {
      ids.add(chunk.id);
      const out = feedExtractor(state, chunk.delta);
      emitParts(out.emittedDataParts);
      for (const err of out.errors) {
        console.warn('[StructuredOutputExtractor]', err);
      }
      if (out.safeText) {
        rawWrite({ ...chunk, delta: out.safeText });
      }
      return;
    }
    if (chunk?.type === 'text-end') {
      const flush = flushExtractor(state);
      for (const err of flush.errors) {
        console.warn('[StructuredOutputExtractor]', err);
      }
      emitParts(flush.emittedDataParts);
      if (flush.safeText && chunk.id && ids.has(chunk.id)) {
        rawWrite({ type: 'text-delta', id: chunk.id, delta: flush.safeText });
      }
      rawWrite(chunk);
      return;
    }
    rawWrite(chunk);
  };
}
