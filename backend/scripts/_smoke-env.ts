/**
 * Sprint-06 fix: env bootstrap for route/integration smoke scripts.
 *
 * tsx hoists static imports above top-level statements, which silently
 * defeated the `process.env.JWT_SECRET ||= '…'` preambles the smoke
 * scripts used to ship. Consequence: auth middleware's eager
 * `if (!process.env.JWT_SECRET) process.exit(1)` fired during the
 * dependency graph load, before the preamble could run.
 *
 * Fix: put env defaults inside a module whose import runs first. Module
 * bodies execute to completion (including side-effects) before the next
 * static import resolves, so by the time auth.ts is loaded the stubs are
 * in place. Real `.env` values still take precedence because `||=`
 * preserves any pre-existing value.
 */
import 'dotenv/config';

process.env.JWT_SECRET ||= 'test-only-stub-secret-for-smoke-scripts';
process.env.OPENAI_API_KEY ||= 'test-only-stub-openai-key';
