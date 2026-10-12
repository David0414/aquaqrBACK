const test = require('node:test');
const assert = require('node:assert/strict');
const { transparentConfig, paymentRequest, chargeTransparentPayment, verifiedTransparentStatus, paymentAction } = require('../src/utils/clipTransparent');
const { settleClipRecharge, reconcileClipRecharge } = require('../src/utils/clipSettlement');
const { settleMachinePremium, PREMIUM_PLANS, activeMachinePremium } = require('../src/utils/machinePremium');
const { DEFAULT_PROMOTIONS, monthKey } = require('../src/utils/rewards');

process.env.CLIP_API_KEY = 'test_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
process.env.CLIP_SECRET_KEY = 'must-not-be-exposed';
process.env.CLIP_AUTH_TOKEN = 'legacy-basic-token-must-not-be-used';
process.env.API_PUBLIC_URL = 'https://api.example.test';
const providerId = '11111111-2222-4333-8444-555555555555';
const token = '22222222-2222-4333-8444-555555555555';
const customer = { email: 'buyer@example.test', phone: '5555555555' };
const invoice = (overrides = {}) => ({ id: 'recharge_1', userId: 'customer', provider: 'CLIP', status: 'PENDING', amountCents: 10000,
  bonusCents: 250, bonusPromotionKey: 'topup_bonus', bonusMetadata: {}, clipFlow: 'TRANSPARENT', clipEnvironment: 'sandbox',
  clipChargeStartedAt: null, providerPaymentId: null, ...overrides });
const proof = (payment, status = 'approved') => ({ id: payment.providerPaymentId || providerId, amount: payment.amountCents / 100,
  currency: 'MXN', external_reference: payment.id, tip_amount: 0, amount_refunded: 0, status });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function database() {
  let rows = { recharge: [], machinePremiumPayment: [], wallet: [], ledgerEntry: [], rewardCredit: [],
    user: [{ id: 'customer', role: 'CUSTOMER' }, { id: 'partner', role: 'PARTNER' }, { id: 'other', role: 'PARTNER' }],
    machine: [{ id: 'AQ-001', partnerId: 'partner' }, { id: 'AQ-002', partnerId: 'other' }] };
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((item) => matches(row, item));
    if (value && typeof value === 'object') {
      if ('gt' in value) return row[key] > value.gt;
      if ('in' in value) return value.in.includes(row[key]);
    }
    return value === null ? row[key] == null : row[key] === value;
  });
  const db = {};
  for (const table of Object.keys(rows)) db[table] = {
    findUnique: async ({ where }) => structuredClone(rows[table].find((row) => matches(row, where)) || null),
    findFirst: async ({ where, orderBy }) => structuredClone(rows[table].filter((row) => matches(row, where)).sort((a, b) => orderBy?.endsAt ? b.endsAt - a.endsAt : 0)[0] || null),
    updateMany: async ({ where, data }) => { const selected = rows[table].filter((row) => matches(row, where));
      selected.forEach((row) => Object.entries(data).forEach(([key, value]) => { row[key] = value?.increment !== undefined ? Number(row[key] || 0) + value.increment : value; }));
      return { count: selected.length }; },
    update: async ({ where, data }) => { await db[table].updateMany({ where, data }); return db[table].findUnique({ where }); },
    create: async ({ data }) => { const row = { id: `${table}_${rows[table].length}`, status: 'PENDING', providerPaymentId: null,
      clipChargeStartedAt: null, createdAt: new Date(), ...data }; rows[table].push(row); return structuredClone(row); },
    upsert: async ({ where, create, update }) => { const existing = await db[table].findUnique({ where });
      return existing ? db[table].update({ where, data: update }) : db[table].create({ data: create }); },
  };
  db.appPromotion = { upsert: async ({ create }) => create, findMany: async () => DEFAULT_PROMOTIONS, updateMany: async () => ({ count: 0 }) };
  db.userPromotionSelection = { findMany: async () => [{ promotionKey: 'topup_bonus', monthKey: monthKey(new Date()), expiresAt: new Date(Date.now() + 86400000) }] };
  db.userMembership = { findMany: async () => [] };
  db.machinePremiumPlan = { findMany: async () => PREMIUM_PLANS };
  db.dispense = { aggregate: async () => ({ _sum: { liters: 1000 } }) };
  db.$queryRaw = async () => [];
  let previous = Promise.resolve();
  db.$transaction = async (callback) => {
    const wait = previous; let done; previous = new Promise((resolve) => { done = resolve; }); await wait;
    const snapshot = structuredClone(rows);
    try { return await callback(db); } catch (failure) { rows = snapshot; throw failure; } finally { done(); }
  };
  return { db, rows: () => rows };
}

test('SDK configuration recognizes sandbox keys, never exposes the secret, and Payments uses Bearer authentication', async () => {
  assert.deepEqual(transparentConfig(), { apiKey: process.env.CLIP_API_KEY, environment: 'sandbox' });
  assert.ok(!JSON.stringify(transparentConfig()).includes(process.env.CLIP_SECRET_KEY));
  await paymentRequest('GET', providerId, null, async (url, options) => {
    assert.equal(url, `https://api.payclip.com/payments/${providerId}`);
    assert.equal(options.headers.Authorization, `Bearer ${process.env.CLIP_API_KEY}`);
    assert.ok(!JSON.stringify(options).includes(process.env.CLIP_SECRET_KEY)); return response({});
  });
});

test('simultaneous card submissions charge once with the server invoice, reference, customer and one-use token', async () => {
  const f = database(), payment = invoice(); f.rows().recharge.push(payment);
  let charges = 0;
  const fetcher = async (url, options) => {
    charges++; assert.equal(url, 'https://api.payclip.com/payments');
    const body = JSON.parse(options.body);
    assert.equal(body.amount, 100); assert.equal(body.external_reference, payment.id);
    assert.deepEqual(body.payment_method, { token }); assert.deepEqual(body.customer, customer);
    assert.equal(body.capture_method, 'automatic'); assert.equal(body.installments, 1); assert.equal(body.tip_amount, 0);
    assert.equal(body.webhook_url, 'https://api.example.test/api/payments/clip/transparent/webhook?payment=recharge_1');
    await new Promise((resolve) => setTimeout(resolve, 10)); return response(proof(payment));
  };
  await Promise.all(Array.from({ length: 8 }, () => chargeTransparentPayment(f.db, 'recharge', structuredClone(payment), token, customer, fetcher)));
  assert.equal(charges, 1); assert.equal(f.rows().recharge[0].providerPaymentId, providerId);
  assert.equal(f.rows().wallet.length, 0);
});

test('an uncertain network result locks the attempt and a retry never sends another charge', async () => {
  const f = database(), payment = invoice(); f.rows().recharge.push(payment);
  let calls = 0;
  const failed = async () => { calls++; throw Error('timeout after charge may have reached Clip'); };
  await assert.rejects(chargeTransparentPayment(f.db, 'recharge', payment, token, customer, failed), { code: 'PAYMENT_UNCONFIRMED' });
  await chargeTransparentPayment(f.db, 'recharge', payment, token, customer, failed);
  assert.equal(calls, 1); assert.equal(f.rows().recharge[0].status, 'PENDING');
  assert.ok(f.rows().recharge[0].clipChargeStartedAt); assert.equal(f.rows().wallet.length, 0);
});

test('an approved POST credits immediately from verified provider proof, without a second provider request', async () => {
  const f = database(), payment = invoice(); f.rows().recharge.push(payment);
  let calls = 0;
  const saved = await chargeTransparentPayment(f.db, 'recharge', payment, token, customer, async (url, options) => {
    calls++; assert.equal(options.method, 'POST'); return response(proof(payment));
  });
  const originalFetch = global.fetch;
  global.fetch = async () => assert.fail('The approved charge already supplied the verified proof');
  try {
    const result = await reconcileClipRecharge(f.db, saved);
    assert.equal(result.status, 'SUCCEEDED'); assert.equal(result.wallet.balanceCents, 10000);
    assert.equal(result.wallet.bonusBalanceCents, 250); assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test('a pending POST does not credit and a later status check fetches fresh provider proof', async () => {
  const f = database(), payment = invoice(); f.rows().recharge.push(payment);
  const saved = await chargeTransparentPayment(f.db, 'recharge', payment, token, customer,
    async () => response(proof(payment, 'pending')));
  assert.equal((await reconcileClipRecharge(f.db, saved)).status, 'PENDING');
  assert.equal(f.rows().wallet.length, 0);
  const originalFetch = global.fetch; let reads = 0;
  global.fetch = async (url, options) => { reads++; assert.equal(options.method, 'GET'); return response(proof(saved)); };
  try {
    assert.equal((await reconcileClipRecharge(f.db, saved)).status, 'SUCCEEDED');
    assert.equal(reads, 1); assert.equal(f.rows().wallet[0].balanceCents, 10000);
  } finally { global.fetch = originalFetch; }
});

test('invalid customer information and a changed sandbox environment never initiate a charge', async () => {
  const f = database(), payment = invoice(); f.rows().recharge.push(payment);
  let calls = 0; const fetcher = async () => { calls++; return response(proof(payment)); };
  await assert.rejects(chargeTransparentPayment(f.db, 'recharge', payment, token, { email: 'invalid', phone: '123' }, fetcher), { code: 'INVALID_CUSTOMER' });
  await assert.rejects(chargeTransparentPayment(f.db, 'recharge', { ...payment, clipEnvironment: 'production' }, token, customer, fetcher), { code: 'CLIP_ENVIRONMENT_CHANGED' });
  assert.equal(calls, 0); assert.equal(f.rows().recharge[0].clipChargeStartedAt, null);
});

test('forged transaction bindings, refunds and pending or merely authorized payments cannot credit a wallet', () => {
  const payment = invoice({ providerPaymentId: providerId });
  for (const change of [{ id: token }, { amount: 1 }, { external_reference: 'other' }, { currency: 'USD' }, { tip_amount: 10 }]) {
    assert.throws(() => verifiedTransparentStatus(payment, { ...proof(payment), ...change }), { code: 'PAYMENT_MISMATCH' });
  }
  assert.equal(verifiedTransparentStatus(payment, proof(payment, 'pending')), 'PENDING');
  assert.equal(verifiedTransparentStatus(payment, proof(payment, 'authorized')), 'PENDING');
  assert.equal(verifiedTransparentStatus(payment, proof(payment, 'rejected')), 'FAILED');
  assert.equal(verifiedTransparentStatus(payment, { ...proof(payment), amount_refunded: 1 }), 'FAILED');
  assert.equal(paymentAction({ pending_action: { type: 'open_modal', url: 'javascript:alert(1)' } }), null);
});

test('confirmed transparent recargas credit wallet and quoted bonus once; Premium activates only its machine and environment', async () => {
  const f = database(), payment = invoice({ providerPaymentId: providerId }); f.rows().recharge.push(payment);
  const challenge = { ...proof(payment, 'pending'), pending_action: { type: 'open_modal', url: 'https://bank.example.test/3ds' } };
  assert.equal((await settleClipRecharge(f.db, payment, challenge)).pendingAction.url, challenge.pending_action.url);
  assert.equal(f.rows().wallet.length, 0);
  await Promise.all([settleClipRecharge(f.db, payment, proof(payment)), settleClipRecharge(f.db, payment, proof(payment))]);
  assert.equal(f.rows().wallet[0].balanceCents, 10000); assert.equal(f.rows().wallet[0].bonusBalanceCents, 250);
  assert.equal(f.rows().ledgerEntry.length, 1); assert.equal(f.rows().rewardCredit.length, 1);
  const premium = invoice({ id: 'premium_1', machineId: 'AQ-001', userId: 'partner', amountCents: 27100, providerPaymentId: token });
  f.rows().machinePremiumPayment.push(premium);
  await settleMachinePremium(f.db, premium, proof(premium));
  assert.ok(await activeMachinePremium(f.db, 'AQ-001'));
  const apiKey = process.env.CLIP_API_KEY;
  process.env.CLIP_API_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  try { assert.equal(await activeMachinePremium(f.db, 'AQ-001'), null); } finally { process.env.CLIP_API_KEY = apiKey; }
  assert.equal(f.rows().wallet[0].balanceCents, 10000);
});

test('real HTTP routes enforce ownership, process sandbox payments and verify webhook recovery without trusting its claimed status', async () => {
  const express = require('express'), f = database();
  const dbPath = require.resolve('../src/db'), authPath = require.resolve('../src/utils/auth');
  const originalDb = require.cache[dbPath], originalAuth = require.cache[authPath], originalFetch = global.fetch;
  require.cache[dbPath] = { exports: { prisma: f.db } };
  require.cache[authPath] = { exports: { requireAuth: (req, res, next) => {
    const userId = req.headers.authorization?.replace('Bearer ', '');
    if (!f.rows().user.some((user) => user.id === userId)) return res.status(401).json({ error: 'Unauthorized' });
    req.auth = { userId }; next();
  } } };
  const remote = new Map(); let charges = 0;
  global.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.payclip.com/payments'));
    if (options.method === 'POST') {
      charges++; const body = JSON.parse(options.body);
      const id = charges === 1 ? providerId : token;
      const value = { id, external_reference: body.external_reference, amount: body.amount, currency: 'MXN', status: 'approved' };
      remote.set(id, value); return response(value);
    }
    const value = remote.get(String(url).split('/').pop()); return response(value || {}, value ? 200 : 404);
  };
  const app = express(); app.use(express.json());
  app.use('/recharge', require('../src/routes/clipRecharge'));
  app.use('/monitor', require('../src/routes/machinePremium'));
  app.use('/clip', require('../src/routes/clipWebhook'));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, user = 'customer') => {
    const result = await originalFetch(base + path, { method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json() };
  };
  try {
    assert.equal((await request('/clip/config', 'GET', null, 'missing')).status, 401);
    assert.deepEqual((await request('/clip/config')).data, transparentConfig());
    const body = { amountCents: 10000, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const prepared = await request('/recharge/clip/prepare', 'POST', body);
    assert.equal(prepared.status, 200); assert.equal(prepared.data.environment, 'sandbox'); assert.equal(prepared.data.bonusCents, 250);
    assert.equal((await request('/recharge/clip/prepare', 'POST', body)).data.rechargeId, prepared.data.rechargeId);
    assert.equal((await request('/recharge/clip/prepare', 'POST', { ...body, amountCents: 20000 })).status, 409);
    const payPath = `/recharge/clip/pay/${prepared.data.rechargeId}`;
    assert.equal((await request(payPath, 'POST', { cardToken: token, customer }, 'other')).status, 404);
    const result = await request(payPath, 'POST', { cardToken: token, customer, amountCents: 1 });
    assert.equal(result.status, 200); assert.equal(result.data.status, 'SUCCEEDED');
    await request(payPath, 'POST', { cardToken: token, customer }); assert.equal(charges, 1);
    assert.equal(f.rows().wallet[0].balanceCents, 10000);
    const basePremium = '/monitor/machines/AQ-001/premium';
    const premiumBody = { requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff', expectedPriceCents: 27100 };
    assert.equal((await request(basePremium + '/prepare', 'POST', premiumBody, 'other')).status, 404);
    const premium = await request(basePremium + '/prepare', 'POST', premiumBody, 'partner');
    assert.equal(premium.status, 200);
    assert.equal((await request(basePremium + '/prepare', 'POST', { ...premiumBody, expectedPriceCents: 100 }, 'partner')).status, 409);
    const premiumPay = basePremium + `/payments/${premium.data.paymentId}/pay`;
    assert.equal((await request(premiumPay, 'POST', { cardToken: token, customer }, 'other')).status, 404);
    assert.equal((await request(premiumPay, 'POST', { cardToken: token, customer }, 'partner')).data.status, 'SUCCEEDED');
    assert.equal(charges, 2); assert.equal(f.rows().wallet[0].balanceCents, 10000);
    const uncertain = invoice({ id: 'uncertain_1', clipChargeStartedAt: new Date(), bonusCents: 0 }); f.rows().recharge.push(uncertain);
    const recoveredId = '33333333-2222-4333-8444-555555555555';
    remote.set(recoveredId, { ...proof(uncertain, 'pending'), id: recoveredId });
    const hook = `/clip/transparent/webhook?payment=${uncertain.id}`;
    assert.equal((await request(hook, 'POST', { id: providerId, status: 'approved' })).status, 503);
    assert.equal((await request(hook, 'POST', { id: recoveredId, status: 'approved' })).status, 200);
    assert.equal(f.rows().wallet[0].balanceCents, 10000);
    remote.get(recoveredId).status = 'approved';
    await request(hook, 'POST', { id: recoveredId });
    assert.equal(f.rows().wallet[0].balanceCents, 20000);
  } finally {
    global.fetch = originalFetch; require.cache[dbPath] = originalDb; require.cache[authPath] = originalAuth;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
