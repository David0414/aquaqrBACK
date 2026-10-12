const express = require('express');
const { prisma } = require('../db');
const { requireManagedMachine, requireAdministrator } = require('../utils/managementAccess');
const { createClipCheckout, UUID, clipAuthorization } = require('../utils/clip');
const { premiumQuote, activeMachinePremium, reconcileMachinePremium, PREMIUM_PLANS } = require('../utils/machinePremium');
const { machineSales } = require('../utils/machineSales');
const router = express.Router();
function fail(res, error) {
  return res.status(error.statusCode || 500).json({ error: error.code || 'PREMIUM_UNAVAILABLE',
    message: error.statusCode ? error.message : 'No se pudo consultar Premium. Intenta nuevamente o contacta al administrador.' });
}

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

router.get('/machines/:id/premium/payments/:paymentId', requireManagedMachine(), async (req, res) => {
  try {
    const payment = await prisma.machinePremiumPayment.findFirst({ where: { id: req.params.paymentId, machineId: req.managedMachine.id,
      ...(req.management.role === 'ADMIN' ? {} : { userId: req.management.userId }) } });
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    const result = await reconcileMachinePremium(prisma, payment);
    return res.json({ paymentId: payment.id, checkoutUrl: payment.checkoutUrl, ...result });
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
