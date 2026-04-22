/**
 * Regression tests for `artifactBelongsToTenant` (compose-span tenant-scope).
 *
 * Before 2026-04-22:
 *   - `system_prompt` required `artifactId === tenantId || artifactId.startsWith(tenantId)`
 *     — but `write_system_prompt` writes the variant enum
 *     ('coordinator' | 'screening') as the artifactId, not the tenant id.
 *     Legacy tenants with a TenantAiConfig row but no BuildArtifactHistory
 *     row therefore 404'd on every compose-span against a system prompt.
 *   - `tool` and `property_override` had NO fallback — they hit the switch
 *     default and always returned false without a history row.
 *
 * After: both fallbacks are correct. These tests lock the contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artifactBelongsToTenant } from '../compose-span';

type HistoryRow = { tenantId: string; artifactId: string };
type SopRow = { id: string; tenantId: string };
type FaqRow = { id: string; tenantId: string };
type ToolRow = { id: string; tenantId: string };
type OverrideRow = { id: string; tenantId: string }; // tenantId on parent SopDefinition
type AiConfigRow = { tenantId: string };

function makeFakePrisma(seed: {
  history?: HistoryRow[];
  sops?: SopRow[];
  faqs?: FaqRow[];
  tools?: ToolRow[];
  overrides?: OverrideRow[];
  tenantAiConfigs?: AiConfigRow[];
}) {
  return {
    buildArtifactHistory: {
      findFirst: async ({ where }: any) => {
        const h = seed.history ?? [];
        return (
          h.find(
            (r) => r.tenantId === where.tenantId && r.artifactId === where.artifactId,
          ) ?? null
        );
      },
    },
    sopDefinition: {
      findFirst: async ({ where }: any) => {
        const rows = seed.sops ?? [];
        return rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null;
      },
    },
    faqEntry: {
      findFirst: async ({ where }: any) => {
        const rows = seed.faqs ?? [];
        return rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null;
      },
    },
    toolDefinition: {
      findFirst: async ({ where }: any) => {
        const rows = seed.tools ?? [];
        return rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null;
      },
    },
    sopPropertyOverride: {
      findFirst: async ({ where }: any) => {
        const rows = seed.overrides ?? [];
        // The real query nests `sopDefinition: { tenantId }`. Our fake
        // flattens tenantId onto each row and matches against the nested
        // shape.
        const expectedTenantId = where?.sopDefinition?.tenantId;
        return (
          rows.find((r) => r.id === where.id && r.tenantId === expectedTenantId) ?? null
        );
      },
    },
    tenantAiConfig: {
      findFirst: async ({ where }: any) => {
        const rows = seed.tenantAiConfigs ?? [];
        return rows.find((r) => r.tenantId === where.tenantId) ?? null;
      },
    },
  } as any;
}

// ─── Happy path via BuildArtifactHistory ─────────────────────────────────

test('history hit short-circuits → returns true', async () => {
  const prisma = makeFakePrisma({
    history: [{ tenantId: 't1', artifactId: 'sop_123' }],
  });
  assert.equal(await artifactBelongsToTenant(prisma, 't1', 'sop_123', 'sop'), true);
});

test('history miss + wrong tenant on underlying table → false', async () => {
  const prisma = makeFakePrisma({
    sops: [{ id: 'sop_xyz', tenantId: 't2' }],
  });
  assert.equal(await artifactBelongsToTenant(prisma, 't1', 'sop_xyz', 'sop'), false);
});

// ─── Fallback: sop / faq ────────────────────────────────────────────────

test('sop: fallback resolves when artifact exists but has no history row', async () => {
  const prisma = makeFakePrisma({
    sops: [{ id: 'sop_nohist', tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'sop_nohist', 'sop'),
    true,
  );
});

test('faq: fallback resolves for legacy faq without history row', async () => {
  const prisma = makeFakePrisma({
    faqs: [{ id: 'faq_legacy', tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'faq_legacy', 'faq'),
    true,
  );
});

// ─── Bugfix regression: system_prompt ────────────────────────────────────

test('system_prompt: accepts "coordinator" variant when TenantAiConfig exists', async () => {
  // Regression for the 2026-04-22 bug: previously this returned false
  // because 'coordinator' does not startsWith(tenantId).
  const prisma = makeFakePrisma({
    tenantAiConfigs: [{ tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'coordinator', 'system_prompt'),
    true,
  );
});

test('system_prompt: accepts "screening" variant when TenantAiConfig exists', async () => {
  const prisma = makeFakePrisma({
    tenantAiConfigs: [{ tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'screening', 'system_prompt'),
    true,
  );
});

test('system_prompt: rejects non-variant artifactId even when config exists', async () => {
  // "config", "default", or any other string must not be accepted — the
  // fallback only trusts the two known variants. Prevents a caller from
  // supplying a bogus artifactId and passing the scope check.
  const prisma = makeFakePrisma({
    tenantAiConfigs: [{ tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'config', 'system_prompt'),
    false,
  );
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 't1', 'system_prompt'),
    false,
    'tenantId-as-artifactId no longer passes (old buggy behaviour)',
  );
});

test('system_prompt: rejects variant when no TenantAiConfig row exists', async () => {
  const prisma = makeFakePrisma({ tenantAiConfigs: [] });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'coordinator', 'system_prompt'),
    false,
  );
});

// ─── Bugfix regression: tool ─────────────────────────────────────────────

test('tool: fallback resolves when tool exists with matching tenant', async () => {
  // Regression: previously this returned false because the switch
  // default returned false for 'tool'.
  const prisma = makeFakePrisma({
    tools: [{ id: 'tool_webhook_a', tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'tool_webhook_a', 'tool'),
    true,
  );
});

test('tool: cross-tenant tool → false', async () => {
  const prisma = makeFakePrisma({
    tools: [{ id: 'tool_x', tenantId: 't2' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'tool_x', 'tool'),
    false,
  );
});

// ─── Bugfix regression: property_override ───────────────────────────────

test('property_override: fallback scopes via parent SopDefinition.tenantId', async () => {
  const prisma = makeFakePrisma({
    overrides: [{ id: 'ovr_greenwich', tenantId: 't1' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'ovr_greenwich', 'property_override'),
    true,
  );
});

test('property_override: cross-tenant override → false', async () => {
  const prisma = makeFakePrisma({
    overrides: [{ id: 'ovr_x', tenantId: 't2' }],
  });
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'ovr_x', 'property_override'),
    false,
  );
});

// ─── Unknown type ───────────────────────────────────────────────────────

test('unknown artifactType → false (safe default)', async () => {
  const prisma = makeFakePrisma({});
  assert.equal(
    await artifactBelongsToTenant(prisma, 't1', 'whatever', 'magic_type'),
    false,
  );
});
