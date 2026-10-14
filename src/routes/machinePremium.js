const express = require('express');
const { prisma } = require('../db');
const { requireManagedMachine, requireAdministrator } = require('../utils/managementAccess');
const { createClipCheckout, UUID, clipAuthorization } = require('../utils/clip');
const { premiumQuote, activeMachinePremium, reconcileMachinePremium, PREMIUM_PLANS } = require('../utils/machinePremium');
const { machineSales } = require('../utils/machineSales');
const { transparentConfig, chargeTransparentPayment } = require('../utils/clipTransparent');
const router = express.Router();
const paymentResponse = (payment) => ({ paymentId: payment.id, amountCents: payment.amountCents, status: payment.status,
  environment: payment.clipEnvironment, flow: payment.clipFlow, checkoutUrl: payment.checkoutUrl,
  canPay: payment.clipFlow === 'TRANSPARENT' && payment.status === 'PENDING' && !payment.providerPaymentId && !payment.clipChargeStartedAt });
function fail(res, error) {
  return res.status(error.statusCode || 500).json({ error: error.code || 'PREMIUM_UNAVAILABLE',
    message: error.statusCode ? error.message : 'No se pudo consultar Premium. Intenta nuevamente o contacta al administrador.' });
}

router.get('/premium/plans', requireAdministrator, async (_req, res) => {
  try {
    const items = await prisma.machinePremiumPlan.findMany({ orderBy: { sortOrder: 'asc' } });
    res.set('Cache-Control', 'no-store');
    return res.json({ items });
  } catch (error) { return fail(res, error); }
});

router.get('/machines/:id/premium', requireManagedMachine(), async (req, res) => {
  try {
    const machineId = req.managedMachine.id;
    const [quote, active] = await Promise.all([premiumQuote(prisma, machineId), activeMachinePremium(prisma, machineId)]);
    res.set('Cache-Control', 'no-store');
    return res.json({ quote, active: Boolean(active), endsAt: active?.endsAt || null, administrativeAccess: req.management.role === 'ADMIN' });
  } catch (error) { return fail(res, error); }
});

router.get('/machines/:id/statistics', requireManagedMachine(), async (req, res) => {
  try {
    const machineId = req.managedMachine.id;
    if (req.management.role !== 'ADMIN' && !await activeMachinePremium(prisma, machineId)) {
      return res.status(403).json({ error: 'PREMIUM_REQUIRED', message: 'Activa Premium para consultar las estadísticas de esta máquina.' });
    }
    const sales = await machineSales(prisma, [machineId], new Date(Date.now() - 30 * 86400000));
    res.set('Cache-Control', 'no-store');
    return res.json({ machineId, sales });
  } catch (error) { return fail(res, error); }
});

router.post('/machines/:id/premium/checkout', requireManagedMachine(), async (req, res) => {
  let created;
  try {
    if (req.management.role !== 'PARTNER') return res.status(400).json({ error: 'El administrador ya tiene acceso a las estadísticas.' });
    clipAuthorization();
    const { requestId, expectedPriceCents } = req.body || {};
    if (!UUID.test(requestId || '')) return res.status(400).json({ error: 'Solicitud de pago inválida' });
    const machineId = req.managedMachine.id, userId = req.management.userId;
    const key = `${userId}:${requestId}`;
    const previous = await prisma.machinePremiumPayment.findUnique({ where: { requestId: key } });
    if (previous) {
      if (previous.machineId !== machineId || previous.amountCents !== expectedPriceCents) return res.status(409).json({ error: 'Esta solicitud corresponde a otra compra.' });
      if (!previous.checkoutUrl) return res.status(409).json({ error: 'El pago se está preparando. Intenta nuevamente.' });
      return res.json({ paymentId: previous.id, checkoutUrl: previous.checkoutUrl, status: previous.status });
    }
    const quote = await premiumQuote(prisma, machineId);
    if (expectedPriceCents !== quote.amountCents) return res.status(409).json({ error: 'PRICE_CHANGED', message: 'El precio cambió. Revisa el importe antes de pagar.' });
    created = await prisma.machinePremiumPayment.create({ data: { machineId, userId, requestId: key,
      amountCents: quote.amountCents, segment: quote.segment, volumeGarrafones: quote.volumeGarrafones,
      volumeFrom: quote.volumeFrom, volumeTo: quote.volumeTo } });
    const checkout = await createClipCheckout({ id: created.id, amountCents: quote.amountCents,
      description: `Premium mensual de ${machineId} — ${quote.segment}`,
      returnPath: `/partner-panel?premiumPayment=${encodeURIComponent(created.id)}&machineId=${encodeURIComponent(machineId)}` });
    await prisma.machinePremiumPayment.update({ where: { id: created.id }, data: checkout });
    return res.json({ paymentId: created.id, ...checkout });
  } catch (error) {
    if (created) await prisma.machinePremiumPayment.updateMany({ where: { id: created.id, status: 'PENDING' }, data: { status: 'FAILED' } }).catch(() => {});
    return fail(res, error);
  }
});

router.post('/machines/:id/premium/prepare', requireManagedMachine(), async (req, res) => {
  try {
    if (req.management.role !== 'PARTNER') return res.status(400).json({ error: 'El administrador ya tiene acceso a las estadísticas.' });
    const { environment } = transparentConfig();
    const { requestId, expectedPriceCents } = req.body || {};
    if (!UUID.test(requestId || '')) return res.status(400).json({ error: 'Solicitud de pago inválida' });
    const machineId = req.managedMachine.id, userId = req.management.userId;
    const key = `${userId}:${requestId}`;
    const previous = await prisma.machinePremiumPayment.findUnique({ where: { requestId: key } });
    if (previous) {
      if (previous.machineId !== machineId || previous.amountCents !== expectedPriceCents || previous.clipFlow !== 'TRANSPARENT' || previous.clipEnvironment !== environment) return res.status(409).json({ error: 'Esta solicitud corresponde a otra compra.' });
      return res.json(paymentResponse(previous));
    }
    const quote = await premiumQuote(prisma, machineId);
    if (expectedPriceCents !== quote.amountCents) return res.status(409).json({ error: 'PRICE_CHANGED', message: 'El precio cambió. Revisa el importe antes de pagar.' });
    let payment;
    try {
      payment = await prisma.machinePremiumPayment.create({ data: { machineId, userId, requestId: key,
        amountCents: quote.amountCents, segment: quote.segment, volumeGarrafones: quote.volumeGarrafones,
        volumeFrom: quote.volumeFrom, volumeTo: quote.volumeTo, clipFlow: 'TRANSPARENT', clipEnvironment: environment } });
    } catch (failure) {
      if (failure.code !== 'P2002') throw failure;
      payment = await prisma.machinePremiumPayment.findUnique({ where: { requestId: key } });
      if (!payment || payment.machineId !== machineId || payment.amountCents !== expectedPriceCents || payment.clipEnvironment !== environment) throw failure;
    }
    return res.json(paymentResponse(payment));
  } catch (failure) { return fail(res, failure); }
});

router.post('/machines/:id/premium/payments/:paymentId/pay', requireManagedMachine(), async (req, res) => {
  let payment;
  try {
    if (req.management.role !== 'PARTNER') return res.status(403).json({ error: 'Este pago es para socios.' });
    payment = await prisma.machinePremiumPayment.findFirst({ where: { id: req.params.paymentId, machineId: req.managedMachine.id,
      userId: req.management.userId, clipFlow: 'TRANSPARENT' } });
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    if (payment.status === 'PENDING' && !payment.providerPaymentId && !payment.clipChargeStartedAt) {
      payment = await chargeTransparentPayment(prisma, 'machinePremiumPayment', payment, req.body?.cardToken, req.body?.customer);
    }
    const result = await reconcileMachinePremium(prisma, payment);
    return res.json({ ...paymentResponse(payment), ...result, canPay: false });
  } catch (failure) {
    if (payment) {
      const latest = await prisma.machinePremiumPayment.findUnique({ where: { id: payment.id } }).catch(() => payment);
      return res.status(failure.statusCode || 500).json({ ...paymentResponse(latest), error: failure.code || 'CLIP_PAYMENT_FAILED',
        message: failure.statusCode ? failure.message : 'No se pudo confirmar el pago. Verifica su estado.' });
    }
    return fail(res, failure);
  }
});

router.get('/machines/:id/premium/payments/:paymentId', requireManagedMachine(), async (req, res) => {
  try {
    const payment = await prisma.machinePremiumPayment.findFirst({ where: { id: req.params.paymentId, machineId: req.managedMachine.id,
      ...(req.management.role === 'ADMIN' ? {} : { userId: req.management.userId }) } });
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    const result = await reconcileMachinePremium(prisma, payment);
    res.set('Cache-Control', 'no-store');
    return res.json({ ...paymentResponse(payment), ...result });
  } catch (error) { return fail(res, error); }
});

router.put('/premium/plans', requireAdministrator, async (req, res) => {
  try {
    const prices = req.body?.prices;
    if (!Array.isArray(prices) || prices.length !== PREMIUM_PLANS.length || PREMIUM_PLANS.some((plan) => {
      const price = prices.find((p) => p.key === plan.key)?.monthlyPriceCents;
      return !Number.isSafeInteger(price) || price < 100 || price > 10000000;
    }) || new Set(prices.map((p) => p.key)).size !== prices.length) return res.status(400).json({ error: 'Indica un precio válido para cada rango de volumen.' });
    await prisma.$transaction(prices.map((p) => prisma.machinePremiumPlan.update({ where: { key: p.key }, data: { monthlyPriceCents: p.monthlyPriceCents } })));
    return res.json({ ok: true });
  } catch (error) { return fail(res, error); }
});
module.exports = router;
