const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipQuote, membershipCoverage } = require('../src/utils/memberships');
const { purchaseMembership } = require('../src/utils/membershipPurchase');
const { chargeDispenseTx } = require('../src/utils/dispenseCharge');
const { requireMachineCoins, requireCoinSession } = require('../src/utils/machineCoins');
const { buildMachineSettings } = require('../src/utils/machineSettings');
const { getUserPromotionSelectionState, saveUserPromotionSelections, settleMonthlyRewards } = require('../src/utils/rewards');

const plan = { key: 'premium_membership_1', kind: 'membership', isActive: true,
  config: { garrafones: 5, costPerGarrafonCents: 1900, monthlyPriceCents: 9500 } };
const request = { machineId: 'AGUA-01', hardwareId: '01', expectedPriceCents: 9500, purchaseId: 'purchase_fixture_0001' };
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
  if (key === 'OR') return value.some((clause) => matches(row, clause));
  if (key === 'AND') return value.every((clause) => matches(row, clause));
  if (value === null) return row[key] == null;
  if (typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) => {
    if (op === 'gt') return row[key] > expected;
    if (op === 'gte') return row[key] >= expected;
    if (op === 'lte') return row[key] <= expected;
    if (op === 'in') return expected.includes(row[key]);
    throw Error(`Unsupported fixture operator ${op}`);
  });
  return row[key] === value;
});

function fixture(balanceCents = 20000, bonusBalanceCents = 1000) {
  let state = { machine: [{ id: 'AGUA-01', hardwareId: '01', isActive: true, coinsEnabled: false, pricePerGarrafonCents: 3500 }],
    wallet: [{ userId: 'customer', balanceCents, bonusBalanceCents }], userMembership: [], userPromotionSelection: [],
    ledgerEntry: [], dispense: [], machineLock: [], rewardCredit: [] };
  const client = {};
  for (const table of Object.keys(state)) client[table] = {
    findUnique: async ({ where }) => structuredClone(state[table].find((row) => matches(row, where)) || null),
    findFirst: async ({ where }) => structuredClone(state[table].find((row) => matches(row, where)) || null),
    findMany: async ({ where }) => structuredClone(state[table].filter((row) => matches(row, where))),
    create: async ({ data }) => {
      const row = { id: `${table}-${state[table].length}`, ...data };
      state[table].push(row); return structuredClone(row);
    },
    updateMany: async ({ where, data }) => {
      const rows = state[table].filter((row) => matches(row, where));
      for (const row of rows) for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'decrement' in value) row[key] -= value.decrement;
        else if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment;
        else row[key] = value;
      }
      return { count: rows.length };
    },
    update: async ({ where, data }) => { await client[table].updateMany({ where, data }); return client[table].findUnique({ where }); },
    deleteMany: async ({ where }) => { state[table] = state[table].filter((row) => !matches(row, where)); },
    createMany: async ({ data }) => { for (const item of data) await client[table].create({ data: item }); },
  };
  client.$transaction = async (run) => {
    const snapshot = structuredClone(state);
    try { return await run(client); } catch (error) { state = snapshot; throw error; }
  };
  const debit = async (tx, userId, cents) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (wallet.balanceCents + wallet.bonusBalanceCents < cents) throw Object.assign(Error('INSUFFICIENT_FUNDS'), { code: 'INSUFFICIENT_FUNDS' });
    const bonusDebitedCents = Math.min(wallet.bonusBalanceCents, cents), realDebitedCents = cents - bonusDebitedCents;
    const updatedWallet = await tx.wallet.update({ where: { userId }, data: {
      balanceCents: { decrement: realDebitedCents }, bonusBalanceCents: { decrement: bonusDebitedCents } } });
    return { updatedWallet, bonusDebitedCents, realDebitedCents };
  };
  const dispense = async (liters = 20, machineId = 'AGUA-01') => client.dispense.create({ data: {
    userId: 'customer', machineId, liters, pricePerLiterCents: 175, totalCents: liters * 175, currency: 'MXN', createdAt: new Date(),
    membershipCoveredLiters: 0, membershipCoveredCents: 0 } });
  return { client, state: () => state, dispense, charge: (record) => client.$transaction((tx) => chargeDispenseTx(tx, record, debit)) };
}

test('membership prices follow each machine price and quote the entire package', () => {
  const standard = membershipQuote(plan, 3500), otherMachine = membershipQuote(plan, 7000);
  assert.equal(standard.purchasePriceCents, 9500);
  assert.equal(standard.litersTotal, 100);
  assert.equal(standard.savingsCents, 8000);
  assert.equal(standard.durationDays, null);
  assert.equal(otherMachine.purchasePriceCents, 19000);
  assert.throws(() => membershipQuote(plan, -100));
});

test('a paid membership deducts the package price once, including promotional balance, without monthly expiry', async () => {
  const f = fixture();
  const paid = await purchaseMembership(f.client, 'customer', plan, request);
  assert.equal(paid.wallet.balanceCents, 11500);
  assert.equal(paid.wallet.bonusBalanceCents, 0);
  assert.equal(paid.membership.litersRemaining, 100);
  assert.equal(paid.membership.expiresAt, null);
  assert.equal(paid.membership.machineId, 'AGUA-01');
  assert.equal(f.state().ledgerEntry.length, 1);
  const replay = await purchaseMembership(f.client, 'customer', plan, request);
  assert.equal(replay.replay, true);
  assert.equal(f.state().ledgerEntry.length, 1);
  assert.equal(f.state().wallet[0].balanceCents, 11500);
});

test('rejects an altered replay, changed machine price, unknown QR, insufficient funds and a second active package', async () => {
  const f = fixture();
  await assert.rejects(purchaseMembership(f.client, 'customer', plan, { ...request, machineId: 'MISSING' }), /Escanea/);
  await assert.rejects(purchaseMembership(f.client, 'customer', plan, { ...request, hardwareId: '02' }), /hardware/);
  await assert.rejects(purchaseMembership(f.client, 'customer', plan, { ...request, expectedPriceCents: 9400 }), { code: 'PRICE_CHANGED' });
  assert.equal(f.state().ledgerEntry.length, 0);
  await assert.rejects(purchaseMembership(fixture(100, 0).client, 'customer', plan, request), { code: 'INSUFFICIENT_FUNDS', neededCents: 9400 });
  await purchaseMembership(f.client, 'customer', plan, request);
  await assert.rejects(purchaseMembership(f.client, 'customer', { ...plan, key: 'other' }, request), /otra compra/);
  await assert.rejects(purchaseMembership(f.client, 'customer', plan, { ...request, purchaseId: 'purchase_fixture_0002' }), { code: 'MEMBERSHIP_ALREADY_ACTIVE' });
  assert.equal(f.state().wallet[0].balanceCents, 11500);
});

test('retries serialization conflicts while retaining the same purchase identity', async () => {
  const f = fixture();
  const transaction = f.client.$transaction;
  let attempts = 0;
  f.client.$transaction = async (...args) => {
    if (++attempts === 1) throw Object.assign(Error('conflict'), { code: 'P2034' });
    return transaction(...args);
  };
  await purchaseMembership(f.client, 'customer', plan, request);
  assert.equal(attempts, 2);
  assert.equal(f.state().userMembership.length, 1);
  assert.equal(f.state().ledgerEntry.length, 1);
});

test('failed activation rolls back the debit, package and ledger together', async () => {
  const f = fixture();
  f.client.userPromotionSelection.createMany = async () => { throw Error('fixture unavailable'); };
  await assert.rejects(purchaseMembership(f.client, 'customer', plan, request));
  assert.equal(f.state().wallet[0].balanceCents, 20000);
  assert.equal(f.state().wallet[0].bonusBalanceCents, 1000);
  assert.equal(f.state().userMembership.length, 0);
  assert.equal(f.state().ledgerEntry.length, 0);
});

test('an unpaid selection counts as zero active memberships', async () => {
  const f = fixture();
  f.state().userPromotionSelection.push({ userId: 'customer', promotionKey: plan.key, expiresAt: null });
  const unpaid = await getUserPromotionSelectionState(f.client, 'customer', new Date(), [plan]);
  assert.deepEqual(unpaid.activePromotionKeys, []);
  assert.equal(unpaid.complete, false);
  await purchaseMembership(f.client, 'customer', plan, request);
  const paid = await getUserPromotionSelectionState(f.client, 'customer', new Date(), [plan]);
  assert.equal(paid.complete, true);
  assert.deepEqual(paid.activePromotionKeys, [plan.key]);
});

test('memberships carry over between months while ordinary promotions retain their monthly selection', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  f.state().userPromotionSelection[0].monthKey = '2026-09';
  f.state().userPromotionSelection.push({ userId: 'customer', monthKey: '2026-09', promotionKey: 'monthly_cashback', expiresAt: null });
  const state = await getUserPromotionSelectionState(f.client, 'customer', new Date('2026-10-06'),
    [plan, { key: 'monthly_cashback', kind: 'cashback', isActive: true }]);
  assert.deepEqual(state.activePromotionKeys, [plan.key]);
  assert.equal(state.complete, true);
});

test('disabling future sales of a plan preserves access to its already paid liters', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  const state = await getUserPromotionSelectionState(f.client, 'customer', new Date(), [{ ...plan, isActive: false }]);
  assert.deepEqual(state.activePromotionKeys, [plan.key]);
  assert.equal((await membershipCoverage(f.client, 'customer', 20, 'AGUA-01')).coveredLiters, 20);
});

test('five included garrafones are consumed without additional charges; the sixth uses the normal price and another package can be bought immediately', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  for (let i = 0; i < 5; i++) {
    const record = await f.dispense();
    const charged = await f.charge(record);
    assert.equal(charged.chargedCents, 0);
    assert.equal(charged.membershipCoveredLiters, 20);
    const again = await f.charge(record);
    assert.equal(again.alreadyCharged, true);
    assert.equal(f.state().userMembership[0].litersRemaining, 100 - (i + 1) * 20);
  }
  assert.equal(f.state().userMembership[0].status, 'USED');
  assert.equal((await f.charge(await f.dispense())).chargedCents, 3500);
  assert.equal(f.state().wallet[0].balanceCents, 8000);
  // A new deposit permits immediate repurchase, without waiting for a new month.
  f.state().wallet[0].balanceCents += 2000;
  const second = await purchaseMembership(f.client, 'customer', plan, { ...request, purchaseId: 'purchase_fixture_0002' });
  assert.equal(second.membership.litersRemaining, 100);
  assert.equal(f.state().userMembership.length, 2);
});

test('partial coverage consumes only remaining liters and charges only the difference', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  f.state().userMembership[0].litersRemaining = 5;
  const charged = await f.charge(await f.dispense());
  assert.equal(charged.membershipCoveredLiters, 5);
  assert.equal(charged.chargedCents, 2625);
  assert.equal(f.state().userMembership[0].status, 'USED');
});

test('insufficient funds for partial coverage roll back consumed liters and the ledger marker', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  f.state().userMembership[0].litersRemaining = 5;
  f.state().wallet[0].balanceCents = 0;
  const record = await f.dispense();
  await assert.rejects(f.charge(record), { code: 'INSUFFICIENT_FUNDS' });
  assert.equal(f.state().userMembership[0].litersRemaining, 5);
  assert.equal(f.state().userMembership[0].status, 'ACTIVE');
  assert.equal(f.state().ledgerEntry.length, 1);
});

test('membership consumption is limited to its machine and cannot be retroactively applied', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  assert.equal((await membershipCoverage(f.client, 'customer', 20, 'OTHER')).coveredLiters, 0);
  assert.equal((await membershipCoverage(f.client, 'customer', 20, null)).coveredLiters, 0);
  assert.equal((await f.charge(await f.dispense(20, 'OTHER'))).chargedCents, 3500);
  const previous = await f.dispense();
  f.state().dispense.find((row) => row.id === previous.id).createdAt = new Date('2026-01-01');
  assert.equal((await f.charge(previous)).membershipCoveredLiters, 0);
  assert.equal(f.state().userMembership[0].litersRemaining, 100);
});

test('a concurrent change to remaining liters cannot consume them twice', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  f.client.userMembership.updateMany = async () => ({ count: 0 });
  await assert.rejects(f.charge(await f.dispense()), { statusCode: 409 });
  assert.equal(f.state().userMembership[0].litersRemaining, 100);
});

test('an active paid package cannot be replaced by a monthly promotion', async () => {
  const f = fixture();
  await purchaseMembership(f.client, 'customer', plan, request);
  await assert.rejects(saveUserPromotionSelections(f.client, 'customer', ['monthly_cashback'], new Date(),
    [plan, { key: 'monthly_cashback', kind: 'cashback', isActive: true }]), /Usa los litros/);
  assert.equal(f.state().userPromotionSelection[0].promotionKey, plan.key);
});

test('cashback and consumption rewards settle by month and remain idempotent', async () => {
  const f = fixture(0, 0);
  f.state().userPromotionSelection.push({ userId: 'customer', monthKey: '2026-09', promotionKey: 'monthly_cashback' });
  const bounds = [];
  f.client.dispense.aggregate = async ({ where }) => {
    bounds.push([where.createdAt.gte.toISOString(), where.createdAt.lt.toISOString()]);
    return { _sum: { liters: 100, totalCents: 17500 }, _count: { id: 5 } };
  };
  const promotions = [{ key: 'monthly_cashback', isActive: true, config: { tiers: [{ maxGarrafones: null, cashbackPerGarrafonCents: 100 }] } },
    { key: 'monthly_consumption_points', isActive: true, config: { pointsPerLiter: 1, tiers: [{ minPoints: 0, bonusCents: 500 }] } }];
  // Use the catalog's actual points key to preserve monthly reward behavior.
  const { PROMOTION_KEYS } = require('../src/utils/rewards');
  promotions[1].key = PROMOTION_KEYS.POINTS;
  const outcome = await settleMonthlyRewards(f.client, 'customer', new Date('2026-10-06'), promotions);
  assert.equal(outcome.settledMonth, '2026-09');
  assert.deepEqual(bounds[0], ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  assert.equal(f.state().rewardCredit.length, 2);
  const balance = f.state().wallet[0].bonusBalanceCents;
  await settleMonthlyRewards(f.client, 'customer', new Date('2026-10-06'), promotions);
  assert.equal(f.state().wallet[0].bonusBalanceCents, balance);
  assert.equal(f.state().rewardCredit.length, 2);
});

test('coins are disabled by default, enabled only by admin and require the customer own active machine session', async () => {
  const f = fixture();
  await assert.rejects(requireMachineCoins('AGUA-01', '01', f.client), { code: 'COINS_DISABLED' });
  assert.throws(() => buildMachineSettings({ coinsEnabled: true }, f.state().machine[0], { role: 'PARTNER' }), { statusCode: 403 });
  const setting = buildMachineSettings({ coinsEnabled: true }, f.state().machine[0], { role: 'ADMIN' });
  Object.assign(f.state().machine[0], setting);
  const machine = await requireMachineCoins('AGUA-01', '01', f.client);
  assert.equal(machine.coinsEnabled, true);
  await assert.rejects(requireMachineCoins('AGUA-01', '02', f.client), { code: 'COINS_DISABLED' });
  await assert.rejects(requireMachineCoins('UNKNOWN-01', null, f.client), { code: 'COINS_DISABLED' });
  await assert.rejects(requireCoinSession('customer', machine, f.client), { code: 'COIN_SESSION_REQUIRED' });
  f.state().machineLock.push({ machineId: machine.id, hardwareId: '01', userId: 'other', expiresAt: new Date(Date.now() + 60000) });
  await assert.rejects(requireCoinSession('customer', machine, f.client), { code: 'COIN_SESSION_REQUIRED' });
  f.state().machineLock[0].userId = 'customer';
  assert.equal((await requireCoinSession('customer', machine, f.client)).userId, 'customer');
  f.state().machineLock[0].expiresAt = new Date(0);
  await assert.rejects(requireCoinSession('customer', machine, f.client), { code: 'COIN_SESSION_REQUIRED' });
});

test('machine income includes package purchases without counting included water twice and scopes both totals to the partner machines', async () => {
  const { machineSales } = require('../src/utils/machineSales');
  const calls = [];
  const client = {
    dispense: { aggregate: async (args) => { calls.push(args); return { _sum: { liters: 120, totalCents: 21000, membershipCoveredCents: 17500 }, _count: { _all: 6 } }; } },
    userMembership: { aggregate: async (args) => { calls.push(args); return { _sum: { pricePaidCents: 9500 }, _count: { _all: 1 } }; } },
  };
  const since = new Date('2026-09-06');
  const sales = await machineSales(client, ['AGUA-01'], since);
  assert.equal(sales.revenueCents, 13000);
  assert.equal(sales.transactions, 6);
  assert.equal(sales.membershipPurchases, 1);
  for (const call of calls) assert.deepEqual(call.where.machineId, { in: ['AGUA-01'] });
  assert.equal(calls[1].where.startsAt.gte, since);
});

test('membership purchase history shows the paid amount separately from included water', () => {
  const { membershipHistoryItem } = require('../src/utils/membershipHistory');
  const purchase = membershipHistoryItem({ id: 'paid-1', garrafonesTotal: 5, litersTotal: 100,
    pricePaidCents: 9500, startsAt: new Date(), machineId: 'AGUA-01', litersRemaining: 80 });
  assert.equal(purchase.type, 'membership');
  assert.equal(purchase.amount, 95);
  assert.equal(purchase.machineId, 'AGUA-01');
  assert.equal(purchase.status, 'completed');
});
