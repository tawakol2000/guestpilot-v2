/**
 * Sprint-06 fix: env bootstrap for integration specs.
 *
 * Must be imported FIRST in any integration test whose graph reaches
 * `src/middleware/auth.ts` (which eagerly `process.exit(1)`s when
 * `JWT_SECRET` is unset). tsx hoists static imports above top-level
 * statements, so an inline `process.env.JWT_SECRET ||= …` preamble is
 * dead code — the transitive auth import resolves first. Module bodies
 * run to completion before the next static import resolves, so putting
 * the env defaults inside a module we import first sidesteps the hoist.
 */
import 'dotenv/config';

process.env.JWT_SECRET ||= 'test-only-stub-secret-for-integration-specs';
process.env.OPENAI_API_KEY ||= 'test-only-stub-openai-key';
