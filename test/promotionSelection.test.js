const test = require('node:test');
const assert = require('node:assert/strict');
const { saveUserPromotionSelections, getUserPromotionSelectionState } = require('../src/utils/rewards');

const promotions = [
  { key: 'topup_bonus', kind: 'topup', isActive: true },
  { key: 'monthly_cashback', kind: 'cashback', isActive: true },
];
const now = new Date('2026-10-05T12:00:00Z');

test('rejects two benefits before changing any saved selection', async () => {
  const client = { $transaction: () => assert.fail('Invalid selections must not be saved') };
  await assert.rejects(saveUserPromotionSelections(client, 'user-1', ['topup_bonus', 'monthly_cashback'], now, promotions), /Elige una promocion/);
});

test('saves one promotion and replaces the previous selection', async () => {
  const calls = [];
  const client = {
    $transaction: async (run) => run({ userPromotionSelection: {
      deleteMany: async (args) => calls.push(['delete', args]),
      createMany: async (args) => calls.push(['create', args]),
    } }),
  };
  const result = await saveUserPromotionSelections(client, 'user-1', ['topup_bonus'], now, promotions);
  assert.equal(result.requiredCount, 1);
  assert.deepEqual(result.promotionKeys, ['topup_bonus']);
  assert.equal(calls[0][0], 'delete');
  assert.equal(calls[0][1].where.userId, 'user-1');
  assert.equal(calls[1][1].data.length, 1);
  assert.equal(result.expiresAt - now, 30 * 24 * 60 * 60 * 1000);
});

test('reports one available slot and asks existing two-benefit selections to be updated', async () => {
  for (const keys of [[], ['topup_bonus'], ['topup_bonus', 'monthly_cashback']]) {
    const client = { userPromotionSelection: { findMany: async () => keys.map((promotionKey) => ({ promotionKey })) } };
    const state = await getUserPromotionSelectionState(client, 'user-1', now, promotions);
    assert.equal(state.requiredCount, 1);
    assert.equal(state.complete, keys.length === 1);
  }
});
