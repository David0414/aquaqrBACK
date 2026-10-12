const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PROMOTIONS, getPromotionCatalog } = require('../src/utils/rewards');

function fixture() {
  const rows = new Map(); let seeds = 0, cleanups = 0, fail = false;
  const client = { appPromotion: {
    upsert: async ({ where, create }) => { seeds++; await Promise.resolve();
      if (!rows.has(where.key)) rows.set(where.key, structuredClone(create)); return rows.get(where.key); },
    updateMany: async () => { cleanups++; if (fail) { fail = false; throw Error('Temporary database failure'); } },
    findMany: async () => [...rows.values()].map((row) => structuredClone(row)),
  } };
  return { client, rows, counts: () => ({ seeds, cleanups }), failNext: () => { fail = true; } };
}

test('concurrent summary requests initialize the catalog once and preserve fresh administrator settings', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 12 }, () => getPromotionCatalog(f.client)));
  assert.deepEqual(f.counts(), { seeds: DEFAULT_PROMOTIONS.length, cleanups: 1 });
  f.rows.get('topup_bonus').config = { tiers: [{ amountCents: 10000, bonusPercent: 8 }] };
  f.rows.get('monthly_cashback').isActive = false;
  const next = await getPromotionCatalog(f.client);
  assert.equal(next.find((p) => p.key === 'topup_bonus').config.tiers[0].bonusPercent, 8);
  assert.equal(next.find((p) => p.key === 'monthly_cashback').isActive, false);
  assert.equal(f.counts().seeds, DEFAULT_PROMOTIONS.length);
});

test('a failed catalog initialization can be retried without requiring a server restart', async () => {
  const f = fixture(); f.failNext();
  await assert.rejects(getPromotionCatalog(f.client), /Temporary database failure/);
  assert.equal((await getPromotionCatalog(f.client)).length, DEFAULT_PROMOTIONS.length);
  assert.equal(f.counts().cleanups, 2);
});
