/**
 * Sprint 09 follow-up — standalone literal-string search/replace used by the
 * sprint-10 workstream-A edit-format resolver. Kept in its own module (no
 * side-effect imports) so the unit tests can import without booting auth
 * middleware, Prisma client, or the Agent SDK.
 *
 * Rejects ambiguous (multi-match) or missing oldText, and handles
 * back-reference-safe substitution. `String.prototype.replace(str, str)`
 * would (a) silently replace only the first match, and (b) interpret '$1',
 * '$&', '$$' etc. in newText as back-references — corrupting any SOP/FAQ
 * text that contains a literal '$' character (prices like "$100",
 * placeholders like "$USERNAME").
 */

export type SearchReplaceResult =
  | { kind: 'ok'; result: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number };

export function performSearchReplace(
  current: string,
  oldText: string,
  newText: string
): SearchReplaceResult {
  if (!oldText) return { kind: 'not_found' };
  const first = current.indexOf(oldText);
  if (first < 0) return { kind: 'not_found' };
  const second = current.indexOf(oldText, first + oldText.length);
  if (second >= 0) {
    let count = 2;
    let idx = second;
    while (count < 10) {
      idx = current.indexOf(oldText, idx + oldText.length);
      if (idx < 0) break;
      count++;
    }
    return { kind: 'ambiguous', count };
  }
  // Literal concat — no back-reference parsing, no CRLF reinterpretation.
  return {
    kind: 'ok',
    result: current.slice(0, first) + newText + current.slice(first + oldText.length),
  };
}
