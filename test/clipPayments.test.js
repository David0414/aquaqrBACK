const test = require('node:test');
const assert = require('node:assert/strict');
const { createClipCheckout, clipAuthorization, verifiedClipStatus } = require('../src/utils/clip');
const { settleClipRecharge } = require('../src/utils/clipSettlement');
const { PREMIUM_PLANS, premiumSegment, previousMexicoMonth, addCalendarMonth, settleMachinePremium } = require('../src/utils/machinePremium');
process.env.CLIP_AUTH_TOKEN = 'fixture-token';
process.env.APP_PUBLIC_URL = 'https://app.example.test';
process.env.API_PUBLIC_URL = 'https://api.example.test';
const providerPaymentId = '11111111-2222-4333-8444-555555555555';
const proof = (payment, status = 'CHECKOUT_COMPLETED') => ({ payment_request_id: payment.providerPaymentId,
  metadata: { external_reference: payment.id }, amount: payment.amountCents / 100, currency: 'MXN', status });

function database(payment, table = 'recharge') {
  let state = { recharge: [], machinePremiumPayment: [], wallet: [], ledgerEntry: [], rewardCredit: [], machine: [{ id: 'AQ-001' }] };
  state[table].push(structuredClone(payment));
  const client = {};
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => value && typeof value === 'object'
    ? 'gt' in value ? row[key] > value.gt : row[key] === value : row[key] === value);
  for (const key of Object.keys(state)) client[key] = {
    findUnique: async ({ where }) => structuredClone(state[key].find((row) => matches(row, where)) || null),
    findFirst: async ({ where, orderBy }) => structuredClone(state[key].filter((row) => matches(row, where)).sort((a, b) => orderBy?.endsAt ? b.endsAt - a.endsAt : 0)[0] || null),
    updateMany: async ({ where, data }) => { const rows = state[key].filter((row) => matches(row, where));
      rows.forEach((row) => Object.entries(data).forEach(([field, value]) => { row[field] = typeof value === 'object' && value?.increment !== undefined ? Number(row[field] || 0) + value.increment : value; })); return { count: rows.length }; },
    update: async ({ where, data }) => { await client[key].updateMany({ where, data }); return client[key].findUnique({ where }); },
    create: async ({ data }) => { const row = { id: `${key}_${state[key].length}`, ...data }; state[key].push(row); return structuredClone(row); },
    upsert: async ({ where, create, update }) => { const row = state[key].find((r) => matches(r, where));
      if (!row) return client[key].create({ data: create }); await client[key].updateMany({ where, data: update }); return client[key].findUnique({ where }); },
  };
  let previous = Promise.resolve();
  client.$transaction = async (run) => {
    const wait = previous; let done; previous = new Promise((resolve) => { done = resolve; }); await wait;
    const snapshot = structuredClone(state);
    try { return await run(client); } catch (error) { state = snapshot; throw error; } finally { done(); }
  };
  client.$queryRaw = async () => [];
  return { client, state: () => state };
}

test('Clip checkout uses server credentials, exact cents, bound reference and authenticated return paths', async () => {
  let body;
  const result = await createClipCheckout({ id: 'payment_1', amountCents: 10055, description: 'Saldo', returnPath: '/balance-recharge?clipRecharge=payment_1',
    fetcher: async (url, options) => { assert.equal(url, 'https://api.payclip.com/v2/checkout'); assert.equal(options.headers.Authorization, 'Basic fixture-token');
      body = JSON.parse(options.body); return { ok: true, json: async () => ({ payment_request_id: providerPaymentId, payment_request_url: `https://pago.clip.mx/${providerPaymentId}` }) }; } });
  assert.equal(body.amount, 100.55);
  assert.deepEqual(body.metadata, { external_reference: 'payment_1' });
  assert.equal(body.redirection_url.success, 'https://app.example.test/balance-recharge?clipRecharge=payment_1');
  assert.equal(body.webhook_url, 'https://api.example.test/api/payments/clip/webhook');
  assert.equal(result.providerPaymentId, providerPaymentId);
  const token = process.env.CLIP_AUTH_TOKEN; delete process.env.CLIP_AUTH_TOKEN;
  assert.throws(clipAuthorization, /no están configurados/); process.env.CLIP_AUTH_TOKEN = token;
});

test('only verified successful Clip payments are credited; forged amounts, references and currencies are rejected', () => {
  const payment = { id: 'recharge_1', amountCents: 10000, providerPaymentId };
  assert.equal(verifiedClipStatus(payment, proof(payment, 'CHECKOUT_PENDING')), 'PENDING');
  for (const change of [{ amount: 500 }, { currency: 'USD' }, { payment_request_id: 'different' }, { metadata: { external_reference: 'somebody_else' } }]) {
    assert.throws(() => verifiedClipStatus(payment, { ...proof(payment), ...change }), /validar/);
  }
  assert.equal(verifiedClipStatus(payment, { ...proof(payment), metadata: JSON.stringify(proof(payment).metadata) }), 'SUCCEEDED');
});

test('concurrent callback and return reconciliation credit real and promotional balance once', async () => {
  const payment = { id: 'recharge_1', userId: 'customer', provider: 'CLIP', status: 'PENDING', amountCents: 10000,
    bonusCents: 250, bonusPromotionKey: 'topup_bonus', bonusMetadata: {}, providerPaymentId };
  const f = database(payment);
  await Promise.all([settleClipRecharge(f.client, payment, proof(payment)), settleClipRecharge(f.client, payment, proof(payment))]);
  assert.equal(f.state().wallet[0].balanceCents, 10000);
  assert.equal(f.state().wallet[0].bonusBalanceCents, 250);
  assert.equal(f.state().recharge[0].status, 'SUCCEEDED');
  assert.equal(f.state().rewardCredit.length, 1);
  assert.equal(f.state().ledgerEntry.length, 1);
});

test('failed settlement rolls back the status and balance; cancelled payments never credit money', async () => {
  const payment = { id: 'recharge_1', userId: 'customer', provider: 'CLIP', status: 'PENDING', amountCents: 10000, bonusCents: 0, providerPaymentId };
  const f = database(payment); f.client.ledgerEntry.create = async () => { throw Error('temporary database failure'); };
  await assert.rejects(settleClipRecharge(f.client, payment, proof(payment)));
  assert.equal(f.state().recharge[0].status, 'PENDING'); assert.equal(f.state().wallet.length, 0);
  await settleClipRecharge(f.client, payment, proof(payment, 'CHECKOUT_CANCELLED'));
  assert.equal(f.state().recharge[0].status, 'CANCELED'); assert.equal(f.state().wallet.length, 0);
});

test('every spreadsheet tier boundary and partial garrafon select the correct machine price', () => {
  for (const [volume, price] of [[0, 27100], [100, 27100], [100.25, 33000], [150, 33000], [151, 44900], [250, 44900], [251, 56900],
    [350, 56900], [351, 74800], [500, 74800], [501, 86700], [600, 86700], [601, 98600], [10000, 98600]]) assert.equal(premiumSegment(volume).monthlyPriceCents, price);
  assert.equal(PREMIUM_PLANS.length, 7);
  assert.throws(() => premiumSegment(-1));
  const bounds = previousMexicoMonth(new Date('2026-10-01T03:00:00Z'));
  assert.equal(bounds.from.toISOString(), '2026-08-01T06:00:00.000Z');
  assert.equal(bounds.to.toISOString(), '2026-09-01T06:00:00.000Z');
  assert.equal(addCalendarMonth(new Date('2027-01-31T14:20:00Z')).toISOString(), '2027-02-28T14:20:00.000Z');
});

test('verified Premium invoices extend only their own machine and do not credit a customer wallet', async () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const payment = { id: 'premium_1', machineId: 'AQ-001', userId: 'partner', status: 'PENDING', amountCents: 27100, providerPaymentId };
  const f = database(payment, 'machinePremiumPayment');
  await Promise.all([settleMachinePremium(f.client, payment, proof(payment), now), settleMachinePremium(f.client, payment, proof(payment), now)]);
  assert.equal(f.state().machinePremiumPayment[0].endsAt.toISOString(), '2026-11-12T12:00:00.000Z');
  const next = { ...payment, id: 'premium_2', providerPaymentId: '22222222-2222-4333-8444-555555555555' };
  f.state().machinePremiumPayment.push(next);
  await settleMachinePremium(f.client, next, proof(next), now);
  assert.equal(f.state().machinePremiumPayment[1].startsAt.toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(f.state().machinePremiumPayment[1].endsAt.toISOString(), '2026-12-12T12:00:00.000Z');
  assert.equal(f.state().wallet.length, 0);
});

test('real Clip routes bind a checkout to its owner, reuse retries and distrust a forged webhook success', async () => {
  const express = require('express');
  const f = database({ id: 'unrelated', userId: 'other', provider: 'CLIP', status: 'PENDING' });
  f.client.user = { upsert: async ({ create }) => create };
  const rewards = require('../src/utils/rewards');
  f.client.appPromotion = { upsert: async ({ create }) => create, findMany: async () => rewards.DEFAULT_PROMOTIONS, updateMany: async () => ({ count: 0 }) };
  f.client.userPromotionSelection = { findMany: async () => [{ promotionKey: 'topup_bonus', monthKey: rewards.monthKey(new Date()), expiresAt: new Date(Date.now() + 86400000) }] };
  f.client.userMembership = { findMany: async () => [] };
  const dbPath = require.resolve('../src/db'), authPath = require.resolve('../src/utils/auth');
  const oldDb = require.cache[dbPath], oldAuth = require.cache[authPath], originalFetch = global.fetch;
  require.cache[dbPath] = { exports: { prisma: f.client } };
  require.cache[authPath] = { exports: { requireAuth: (req, res, next) => {
    const id = req.headers.authorization?.replace('Bearer ', '');
    if (!['customer', 'other'].includes(id)) return res.status(401).json({ error: 'Unauthorized' });
    req.auth = { userId: id }; next();
  } } };
  let createdLinks = 0, remoteStatus = 'CHECKOUT_PENDING', externalReference;
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.payclip.com/')) throw new Error('Unexpected external request');
    if (options.method === 'POST') {
      createdLinks++; externalReference = JSON.parse(options.body).metadata.external_reference;
      return { ok: true, json: async () => ({ payment_request_id: providerPaymentId, payment_request_url: `https://pago.clip.mx/${providerPaymentId}` }) };
    }
    return { ok: true, json: async () => ({ payment_request_id: providerPaymentId, metadata: { external_reference: externalReference }, amount: 100, currency: 'MXN', status: remoteStatus }) };
  };
  const app = express(); app.use(express.json()); app.use('/recharge', require('../src/routes/clipRecharge')); app.use('/clip', require('../src/routes/clipWebhook'));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, user = 'customer') => {
    const response = await originalFetch(base + path, { method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const body = { amountCents: 10000, requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    assert.equal((await request('/recharge/clip/create-checkout', 'POST', { ...body, amountCents: 999 })).status, 400);
    const created = await request('/recharge/clip/create-checkout', 'POST', body);
    assert.equal(created.status, 200); assert.equal(created.data.bonusCents, 250);
    assert.equal((await request('/recharge/clip/create-checkout', 'POST', body)).data.rechargeId, created.data.rechargeId);
    assert.equal(createdLinks, 1);
    assert.equal((await request('/recharge/clip/create-checkout', 'POST', { ...body, amountCents: 20000 })).status, 409);
    assert.equal((await request(`/recharge/clip/status/${created.data.rechargeId}`, 'GET', null, 'other')).status, 404);
    assert.equal((await request('/clip/webhook', 'POST', { id: providerPaymentId, resource_status: 'COMPLETED' })).status, 200);
    assert.equal(f.state().wallet.length, 0);
    remoteStatus = 'CHECKOUT_COMPLETED';
    const [verified, callback] = await Promise.all([request(`/recharge/clip/status/${created.data.rechargeId}`), request('/clip/webhook', 'POST', { id: providerPaymentId })]);
    assert.equal(verified.data.status, 'SUCCEEDED'); assert.equal(callback.status, 200);
    assert.equal(f.state().wallet[0].balanceCents, 10000); assert.equal(f.state().wallet[0].bonusBalanceCents, 250);
  } finally {
    global.fetch = originalFetch; require.cache[dbPath] = oldDb;
    if (oldAuth) require.cache[authPath] = oldAuth; else delete require.cache[authPath];
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
