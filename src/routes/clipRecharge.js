const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../utils/auth');
const { createClipCheckout, clipAuthorization, clipCheckoutEnvironment, UUID } = require('../utils/clip');
const { reconcileClipRecharge } = require('../utils/clipSettlement');
const { transparentConfig, chargeTransparentPayment, paymentCustomerFromUser } = require('../utils/clipTransparent');
const { getPromotionCatalog, getUserPromotionSelectionState, getRechargeBonusOffer } = require('../utils/rewards');
const router = express.Router();
const paymentResponse = (payment) => ({ rechargeId: payment.id, checkoutUrl: payment.checkoutUrl,
  amountCents: payment.amountCents, bonusCents: payment.bonusCents, status: payment.status,
  flow: payment.clipFlow, environment: payment.clipEnvironment,
  canPay: payment.clipFlow === 'TRANSPARENT' && payment.status === 'PENDING' && !payment.clipChargeStartedAt && !payment.providerPaymentId });
const sendError = (res, error) => res.status(error.statusCode || 500).json({ error: error.code || 'CLIP_PAYMENT_FAILED',
  message: error.statusCode ? error.message : 'No se pudo preparar el pago. Intenta nuevamente.' });

router.post('/clip/prepare', requireAuth, async (req, res) => {
  try {
    const { environment } = transparentConfig();
    const { userId } = req.auth;
    const { amountCents, requestId } = req.body || {};
    if (!Number.isInteger(amountCents) || amountCents < 1000 || amountCents > 50000 || !UUID.test(requestId || '')) return res.status(400).json({ error: 'Ingresa un monto entre $10 y $500.' });
    const checkoutRequestId = `${userId}:${requestId}`;
    const previous = await prisma.recharge.findUnique({ where: { checkoutRequestId } });
    if (previous) {
      if (previous.amountCents !== amountCents || previous.clipFlow !== 'TRANSPARENT' || previous.clipEnvironment !== environment) return res.status(409).json({ error: 'Esta solicitud corresponde a otro pago.' });
      return res.json(paymentResponse(previous));
    }
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const catalog = await getPromotionCatalog(prisma);
    const selection = await getUserPromotionSelectionState(prisma, userId, new Date(), catalog);
    const bonus = getRechargeBonusOffer(amountCents, selection.selectedPromotionKeys, catalog);
    let payment;
    try {
      payment = await prisma.recharge.create({ data: { userId, provider: 'CLIP', currency: 'MXN', amountCents,
        checkoutRequestId, clipFlow: 'TRANSPARENT', clipEnvironment: environment,
        status: 'PENDING', bonusCents: bonus.bonusCents, bonusPromotionKey: bonus.promotionKey, bonusMetadata: bonus.metadata } });
    } catch (failure) {
      if (failure.code !== 'P2002') throw failure;
      payment = await prisma.recharge.findUnique({ where: { checkoutRequestId } });
      if (!payment || payment.amountCents !== amountCents || payment.clipEnvironment !== environment) throw failure;
    }
    res.set('Cache-Control', 'no-store');
    return res.json(paymentResponse(payment));
  } catch (failure) { return sendError(res, failure); }
});

router.post('/clip/pay/:id', requireAuth, async (req, res) => {
  let payment;
  try {
    payment = await prisma.recharge.findFirst({ where: { id: req.params.id, userId: req.auth.userId, provider: 'CLIP', clipFlow: 'TRANSPARENT' } });
    if (!payment) return res.status(404).json({ error: 'Recarga no encontrada' });
    if (payment.status === 'PENDING' && !payment.providerPaymentId && !payment.clipChargeStartedAt) {
      const customer = await paymentCustomerFromUser(prisma, req.auth.userId, req.body?.customer);
      payment = await chargeTransparentPayment(prisma, 'recharge', payment, req.body?.cardToken, customer);
    }
    const result = await reconcileClipRecharge(prisma, payment);
    return res.json({ ...paymentResponse(payment), ...result, canPay: false });
  } catch (failure) {
    if (payment) {
      const latest = await prisma.recharge.findUnique({ where: { id: payment.id } }).catch(() => payment);
      return res.status(failure.statusCode || 500).json({ ...paymentResponse(latest), error: failure.code || 'CLIP_PAYMENT_FAILED',
        message: failure.statusCode ? failure.message : 'No se pudo confirmar el pago. Verifica su estado.' });
    }
    return sendError(res, failure);
  }
});

router.post('/clip/create-checkout', requireAuth, async (req, res) => {
  let created;
  try {
    clipAuthorization();
    const { userId } = req.auth;
    const { amountCents, requestId } = req.body || {};
    if (!Number.isInteger(amountCents) || amountCents < 1000 || amountCents > 50000 || !UUID.test(requestId || '')) {
      return res.status(400).json({ error: 'Ingresa un monto entre $10 y $500 y una solicitud válida.' });
    }
    const checkoutRequestId = `${userId}:${requestId}`;
    const previous = await prisma.recharge.findUnique({ where: { checkoutRequestId } });
    if (previous) {
      if (previous.amountCents !== amountCents) return res.status(409).json({ error: 'Esta solicitud corresponde a otro monto.' });
      if (!previous.checkoutUrl) return res.status(409).json({ error: 'El pago todavía se está preparando. Intenta nuevamente.' });
      return res.json(paymentResponse(previous));
    }
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const catalog = await getPromotionCatalog(prisma);
    const selection = await getUserPromotionSelectionState(prisma, userId, new Date(), catalog);
    const bonus = getRechargeBonusOffer(amountCents, selection.selectedPromotionKeys, catalog);
    created = await prisma.recharge.create({ data: { userId, provider: 'CLIP', currency: 'MXN', amountCents,
      checkoutRequestId, clipEnvironment: clipCheckoutEnvironment(), status: 'PENDING',
      bonusCents: bonus.bonusCents, bonusPromotionKey: bonus.promotionKey, bonusMetadata: bonus.metadata } });
    const checkout = await createClipCheckout({ id: created.id, amountCents, description: 'Recarga de saldo AGUA/24',
      returnPath: `/balance-recharge?clipRecharge=${encodeURIComponent(created.id)}` });
    const payment = await prisma.recharge.update({ where: { id: created.id }, data: checkout });
    res.set('Cache-Control', 'no-store');
    return res.json(paymentResponse(payment));
  } catch (error) {
    if (created) await prisma.recharge.updateMany({ where: { id: created.id, status: 'PENDING' }, data: { status: 'FAILED' } }).catch(() => {});
    return sendError(res, error);
  }
});

router.get('/clip/status/:id', requireAuth, async (req, res) => {
  try {
    const payment = await prisma.recharge.findFirst({ where: { id: req.params.id, userId: req.auth.userId, provider: 'CLIP' } });
    if (!payment) return res.status(404).json({ error: 'Recarga no encontrada' });
    const result = await reconcileClipRecharge(prisma, payment);
    res.set('Cache-Control', 'no-store');
    return res.json({ ...paymentResponse(payment), ...result });
  } catch (error) { return sendError(res, error); }
});
module.exports = router;
