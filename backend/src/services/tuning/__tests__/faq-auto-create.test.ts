/**
 * Unit tests for resolveFaqAutoCreateFields — the shared precedence resolver
 * used by the HTTP accept endpoint and the agent's suggestion_action tool
 * to auto-create a FAQ when a suggestion has no faqEntryId.
 *
 * Critical invariant: both surfaces must compute the same finalQuestion
 * from the same suggestion so the dedup key collides and the manager
 * doesn't end up with duplicate FAQ entries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFaqAutoCreateFields } from '../faq-auto-create';

function mockPrisma(options: {
  ownedPropertyIds?: string[];
  sourceMessage?: { conversationId: string; sentAt: Date } | null;
  priorGuestMessage?: { content: string } | null;
  conversationPropertyId?: string | null;
}) {
  return {
    property: {
      findFirst: async ({ where }: any) => {
        if ((options.ownedPropertyIds ?? []).includes(where.id)) {
          return { id: where.id };
        }
        return null;
      },
    },
    message: {
      findFirst: async ({ where, orderBy }: any) => {
        // source-message lookup (by id + tenantId, no role filter)
        if (!where.role) {
          return options.sourceMessage ?? null;
        }
        // prior-guest lookup (by role GUEST, orderBy sentAt desc)
        if (where.role === 'GUEST' && orderBy?.sentAt === 'desc') {
          return options.priorGuestMessage ?? null;
        }
        return null;
      },
    },
    conversation: {
      findFirst: async () => {
        if (options.conversationPropertyId === undefined) return null;
        return { propertyId: options.conversationPropertyId };
      },
    },
  } as any;
}

test('override editedQuestion wins (highest precedence)', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: { editedQuestion: '  What is the wifi password?  ' },
    suggestion: {
      sourceMessageId: null,
      beforeText: 'something else',
      faqQuestion: 'yet another',
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(resolved.finalQuestion, 'What is the wifi password?');
  assert.equal(resolved.sourceHint, 'override');
});

test('persisted faqQuestion used when no override', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: {},
    suggestion: {
      sourceMessageId: null,
      beforeText: 'ignored-beforeText',
      faqQuestion: 'persisted question',
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(resolved.finalQuestion, 'persisted question');
  assert.equal(resolved.sourceHint, 'persistedQuestion');
});

test('beforeText used when no override or persisted question', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: {},
    suggestion: {
      sourceMessageId: null,
      beforeText: 'fallback beforeText',
      faqQuestion: null,
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(resolved.finalQuestion, 'fallback beforeText');
  assert.equal(resolved.sourceHint, 'beforeText');
});

test('inferred guest message used when all persisted fields empty', async () => {
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({
      sourceMessage: { conversationId: 'c1', sentAt: new Date('2026-01-01') },
      priorGuestMessage: { content: 'Where do I put the trash?' },
    }),
    't1',
    {
      overrides: {},
      suggestion: {
        sourceMessageId: 'm1',
        beforeText: null,
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalQuestion, 'Where do I put the trash?');
  assert.equal(resolved.sourceHint, 'inferred');
});

test('placeholder when nothing resolves', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: {},
    suggestion: {
      sourceMessageId: null,
      beforeText: null,
      faqQuestion: null,
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.match(resolved.finalQuestion, /please edit/);
  assert.equal(resolved.sourceHint, 'placeholder');
});

test('whitespace-only override is ignored, falls through', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: { editedQuestion: '   \n\t  ' },
    suggestion: {
      sourceMessageId: null,
      beforeText: null,
      faqQuestion: 'persisted fallback',
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(resolved.finalQuestion, 'persisted fallback');
});

test('PROPERTY scope with owned propertyId is kept', async () => {
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({ ownedPropertyIds: ['p1'] }),
    't1',
    {
      overrides: { faqScope: 'PROPERTY', faqPropertyId: 'p1' },
      suggestion: {
        sourceMessageId: null,
        beforeText: 'Q',
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalScope, 'PROPERTY');
  assert.equal(resolved.finalPropertyId, 'p1');
});

test('PROPERTY scope with cross-tenant propertyId coerces to GLOBAL', async () => {
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({ ownedPropertyIds: ['p-owned'] }),
    't1',
    {
      overrides: { faqScope: 'PROPERTY', faqPropertyId: 'p-foreign' },
      suggestion: {
        sourceMessageId: null,
        beforeText: 'Q',
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalScope, 'GLOBAL');
  assert.equal(resolved.finalPropertyId, null);
});

test('PROPERTY scope with missing propertyId coerces to GLOBAL', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: { faqScope: 'PROPERTY' },
    suggestion: {
      sourceMessageId: null,
      beforeText: 'Q',
      faqQuestion: null,
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(resolved.finalScope, 'GLOBAL');
  assert.equal(resolved.finalPropertyId, null);
});

// Scope inference tests (Round-3 follow-up).
test('PROPERTY inferred from source conversation when no scope is specified', async () => {
  // Guest asked at a specific property → new FAQ should default to
  // PROPERTY scoped to that property, not GLOBAL.
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({
      ownedPropertyIds: ['p1'],
      sourceMessage: { conversationId: 'c1', sentAt: new Date('2026-01-01') },
      conversationPropertyId: 'p1',
    }),
    't1',
    {
      overrides: {},
      suggestion: {
        sourceMessageId: 'm1',
        beforeText: 'some question',
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalScope, 'PROPERTY');
  assert.equal(resolved.finalPropertyId, 'p1');
  assert.equal(resolved.scopeSource, 'inferredFromConversation');
});

test('GLOBAL defaulted when source conversation has no property', async () => {
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({
      sourceMessage: { conversationId: 'c1', sentAt: new Date('2026-01-01') },
      conversationPropertyId: null,
    }),
    't1',
    {
      overrides: {},
      suggestion: {
        sourceMessageId: 'm1',
        beforeText: 'Q',
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalScope, 'GLOBAL');
  assert.equal(resolved.finalPropertyId, null);
  assert.equal(resolved.scopeSource, 'defaulted');
});

test('GLOBAL defaulted when no source message at all', async () => {
  const resolved = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: {},
    suggestion: {
      sourceMessageId: null,
      beforeText: 'Q',
      faqQuestion: null,
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(resolved.finalScope, 'GLOBAL');
  assert.equal(resolved.scopeSource, 'defaulted');
});

test('explicit GLOBAL override beats inferred PROPERTY', async () => {
  // Manager explicitly wants GLOBAL even though conversation has a property.
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({
      sourceMessage: { conversationId: 'c1', sentAt: new Date('2026-01-01') },
      conversationPropertyId: 'p1',
    }),
    't1',
    {
      overrides: { faqScope: 'GLOBAL' },
      suggestion: {
        sourceMessageId: 'm1',
        beforeText: 'Q',
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalScope, 'GLOBAL');
  assert.equal(resolved.finalPropertyId, null);
  assert.equal(resolved.scopeSource, 'override');
});

test('persisted PROPERTY scope beats inferred', async () => {
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({
      ownedPropertyIds: ['p-persisted'],
      sourceMessage: { conversationId: 'c1', sentAt: new Date('2026-01-01') },
      conversationPropertyId: 'p-inferred',
    }),
    't1',
    {
      overrides: {},
      suggestion: {
        sourceMessageId: 'm1',
        beforeText: 'Q',
        faqQuestion: null,
        faqCategory: null,
        faqScope: 'PROPERTY',
        faqPropertyId: 'p-persisted',
      },
    }
  );
  assert.equal(resolved.finalScope, 'PROPERTY');
  assert.equal(resolved.finalPropertyId, 'p-persisted');
  assert.equal(resolved.scopeSource, 'persisted');
});

test('inferred PROPERTY falls back to GLOBAL when property is foreign', async () => {
  // Conversation's propertyId exists but isn't owned by this tenant (data
  // integrity violation) — don't persist a PROPERTY FAQ to an alien
  // property; coerce to GLOBAL.
  const resolved = await resolveFaqAutoCreateFields(
    mockPrisma({
      ownedPropertyIds: [], // tenant owns no properties
      sourceMessage: { conversationId: 'c1', sentAt: new Date('2026-01-01') },
      conversationPropertyId: 'p-foreign',
    }),
    't1',
    {
      overrides: {},
      suggestion: {
        sourceMessageId: 'm1',
        beforeText: 'Q',
        faqQuestion: null,
        faqCategory: null,
        faqScope: null,
        faqPropertyId: null,
      },
    }
  );
  assert.equal(resolved.finalScope, 'GLOBAL');
  assert.equal(resolved.finalPropertyId, null);
  assert.equal(resolved.scopeSource, 'defaulted');
});

test('category override wins, otherwise persisted, otherwise default', async () => {
  const overridden = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: { faqCategory: 'wifi-technology' },
    suggestion: {
      sourceMessageId: null,
      beforeText: 'Q',
      faqQuestion: null,
      faqCategory: 'house-rules',
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(overridden.finalCategory, 'wifi-technology');

  const persisted = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: {},
    suggestion: {
      sourceMessageId: null,
      beforeText: 'Q',
      faqQuestion: null,
      faqCategory: 'house-rules',
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(persisted.finalCategory, 'house-rules');

  const defaulted = await resolveFaqAutoCreateFields(mockPrisma({}), 't1', {
    overrides: {},
    suggestion: {
      sourceMessageId: null,
      beforeText: 'Q',
      faqQuestion: null,
      faqCategory: null,
      faqScope: null,
      faqPropertyId: null,
    },
  });
  assert.equal(defaulted.finalCategory, 'property-neighborhood');
});
