/**
 * studio_get_canonical_template — sprint 060-D phase 8.
 *
 * Run: JWT_SECRET=test npx tsx --test src/build-tune-agent/tools/__tests__/get-canonical-template.test.ts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-canonical';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGetCanonicalTemplateTool } from '../get-canonical-template';

interface Captured { name: string; handler: (a: any) => Promise<{ content: any[] }> }
const captured: Captured[] = [];
const fakeFactory = (name: string, _d: any, _s: any, handler: any) => {
  captured.push({ name, handler });
  return { name, handler };
};

test('studio_get_canonical_template (no slot): returns full template + slot inventory', async () => {
  captured.length = 0;
  const ctx = () => ({} as any);
  buildGetCanonicalTemplateTool(fakeFactory as any, ctx);
  const out = JSON.parse((await captured[0].handler({})).content[0].text);
  assert.equal(out.loadBearingSlots.length, 6);
  assert.equal(out.nonLoadBearingSlots.length, 14);
  assert.ok(out.template.includes('{{property_identity}}'));
  assert.ok(out.templateVersion.startsWith('seed-v1-'));
});

test('studio_get_canonical_template (slot=property_identity): returns single-slot guidance', async () => {
  captured.length = 0;
  const ctx = () => ({} as any);
  buildGetCanonicalTemplateTool(fakeFactory as any, ctx);
  const out = JSON.parse((await captured[0].handler({ slot: 'property_identity' })).content[0].text);
  assert.equal(out.slot, 'property_identity');
  assert.equal(out.loadBearing, true);
  assert.equal(out.placeholder, '{{property_identity}}');
  assert.ok(out.guidance.length > 0);
});

test('studio_get_canonical_template (slot=pet_policy): non-load-bearing flagged correctly', async () => {
  captured.length = 0;
  const ctx = () => ({} as any);
  buildGetCanonicalTemplateTool(fakeFactory as any, ctx);
  const out = JSON.parse((await captured[0].handler({ slot: 'pet_policy' })).content[0].text);
  assert.equal(out.loadBearing, false);
});
