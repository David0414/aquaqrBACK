const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../utils/auth');
const { createClipCheckout, clipAuthorization, UUID } = require('../utils/clip');
const { reconcileClipRecharge } = require('../utils/clipSettlement');
const { getPromotionCatalog, getUserPromotionSelectionState, getRechargeBonusOffer } = require('../utils/rewards');
const router = express.Router();
const paymentResponse = (payment) => ({ rechargeId: payment.id, checkoutUrl: payment.checkoutUrl,
  amountCents: payment.amountCents, bonusCents: payment.bonusCents, status: payment.status });
const sendError = (res, error) => res.status(error.statusCode || 500).json({ error: error.code || 'CLIP_PAYMENT_FAILED',
  message: error.statusCode ? error.message : 'No se pudo preparar el pago. Intenta nuevamente.' });

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
      checkoutRequestId, status: 'PENDING', bonusCents: bonus.bonusCents, bonusPromotionKey: bonus.promotionKey, bonusMetadata: bonus.metadata } });
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
