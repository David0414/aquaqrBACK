const test = require('node:test');
const assert = require('node:assert/strict');
const { getRechargeHistoryItems } = require('../src/utils/rechargeHistory');

function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((clause) => matches(row, clause));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('lt' in value) return row[key] < value.lt;
      if ('in' in value) return value.in.includes(row[key]);
    }
    if (value instanceof Date) return +row[key] === +value;
    return row[key] === value;
  });
}

function model(rows) {
  return {
    findFirst: async ({ where }) => rows.find((row) => matches(row, where)) || null,
    findMany: async ({ where, take }) => rows.filter((row) => matches(row, where))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, take),
  };
}

function fixture() {
  const date = new Date('2026-10-05T10:00:00Z');
  const card = { id: 'b', userId: 'user-1', createdAt: date, provider: 'STRIPE',
    amountCents: 5000, bonusCents: 1000, currency: 'mxn', status: 'PENDING', providerPaymentId: 'pi-1' };
  const coin = { id: 'c', userId: 'user-1', createdAt: date, type: 'CREDIT',
    amountCents: 1000, currency: 'MXN', status: 'POSTED', source: 'telemetry-coin' };
  const olderCoin = { ...coin, id: 'a', createdAt: new Date('2026-10-04T10:00:00Z'), amountCents: 500 };
  const excluded = [
    { ...coin, id: 'other-user', userId: 'user-2' },
    { ...coin, id: 'reversed', status: 'REVERSED' },
    { ...coin, id: 'debit', type: 'DEBIT' },
    { ...coin, id: 'reward', source: 'reward' },
    { ...coin, id: 'stripe-credit', source: 'stripe', externalId: 'pi-1' },
  ];
  return { recharge: model([card]), ledgerEntry: model([coin, olderCoin, ...excluded]) };
}

test('shows existing coin credits alongside card recharges, without unrelated ledger entries', async () => {
  const items = await getRechargeHistoryItems(fixture(), 'user-1', { limit: 10 });
  assert.deepEqual(items.map((item) => item.id), ['c', 'b', 'a']);
  assert.equal(items[0].type, 'recharge');
  assert.equal(items[0].paymentMethod, 'Monedas');
  assert.equal(items[0].status, 'completed');
  assert.equal(items[0].amount, 10);
  assert.equal(items[0].totalReceivedAmount, 10);
  assert.equal(items[1].status, 'completed'); // Already posted, even if the provider row is pending.
  assert.equal(items[1].bonusAmount, 10);
  assert.equal(items[1].totalReceivedAmount, 60);
});

test('paginates across coins and cards, including equal timestamps, without skipping or repeating rows', async () => {
  const client = fixture();
  let cursor = null;
  const ids = [];
  for (let page = 0; page < 4; page++) {
    const items = await getRechargeHistoryItems(client, 'user-1', { limit: 1, cursor });
    if (!items.length) break;
    ids.push(items[0].id);
    cursor = items[0].id;
  }
  assert.deepEqual(ids, ['c', 'b', 'a']);
});

test('does not accept another user’s cursor', async () => {
  assert.deepEqual(await getRechargeHistoryItems(fixture(), 'user-1', { limit: 10, cursor: 'other-user' }), []);
});
