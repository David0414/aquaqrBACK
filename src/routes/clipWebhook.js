const express = require('express');
const { prisma } = require('../db');
const { UUID } = require('../utils/clip');
const { reconcileClipRecharge } = require('../utils/clipSettlement');
const { reconcileMachinePremium } = require('../utils/machinePremium');
const { requireAuthOrMonitorAdmin } = require('../utils/monitorAdmin');
const { transparentConfig, assertEnvironment, paymentRequest, verifiedTransparentStatus } = require('../utils/clipTransparent');
const router = express.Router();
router.get('/config', requireAuthOrMonitorAdmin, (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Clip documents this API key as the SDK's public key. Never return Basic tokens or the secret key.
    return res.json(transparentConfig());
  } catch (failure) { return res.status(failure.statusCode || 500).json({ error: failure.code, message: failure.message }); }
});

router.post('/transparent/webhook', async (req, res) => {
  const localId = String(req.query.payment || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(localId)) return res.status(400).json({ error: 'Notificación inválida' });
  try {
    let model = 'recharge';
    let payment = await prisma.recharge.findFirst({ where: { id: localId, provider: 'CLIP', clipFlow: 'TRANSPARENT' } });
    if (!payment) { model = 'machinePremiumPayment'; payment = await prisma.machinePremiumPayment.findFirst({ where: { id: localId, clipFlow: 'TRANSPARENT' } }); }
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    assertEnvironment(payment);
    if (!payment.providerPaymentId) {
      if (!payment.clipChargeStartedAt) return res.status(409).json({ error: 'Pago todavía no iniciado' });
      const candidates = [...new Set([req.body?.payment_id, req.body?.transaction_id, req.body?.id, req.body?.data?.id])].filter((id) => UUID.test(id || ''));
      let proof;
      for (const candidate of candidates) {
        try { const remote = await paymentRequest('GET', candidate); verifiedTransparentStatus(payment, remote); proof = remote; break; } catch { /* Event IDs are never accepted as proof of a charge. */ }
      }
      if (!proof) return res.status(503).json({ error: 'No se pudo identificar y verificar el pago' });
      await prisma[model].updateMany({ where: { id: payment.id, providerPaymentId: null }, data: { providerPaymentId: proof.id } });
      payment = await prisma[model].findUnique({ where: { id: payment.id } });
    }
    if (model === 'recharge') await reconcileClipRecharge(prisma, payment);
    else await reconcileMachinePremium(prisma, payment);
    return res.json({ received: true });
  } catch { return res.status(503).json({ error: 'No se pudo verificar el pago con Clip. Reintenta la notificación.' }); }
});
router.post('/webhook', async (req, res) => {
  const id = req.body?.id || req.body?.payment_request_id;
  if (!UUID.test(id || '')) return res.status(400).json({ error: 'Notificación inválida' });
  try {
    const recharge = await prisma.recharge.findFirst({ where: { provider: 'CLIP', providerPaymentId: id } });
    if (recharge) await reconcileClipRecharge(prisma, recharge);
    else {
      const premium = await prisma.machinePremiumPayment.findUnique({ where: { providerPaymentId: id } });
      if (!premium) return res.status(503).json({ error: 'Pago todavía no registrado. Reintenta la notificación.' });
      await reconcileMachinePremium(prisma, premium);
    }
    return res.json({ received: true });
  } catch { return res.status(503).json({ error: 'No se pudo verificar el pago con Clip. Reintenta la notificación.' }); }
});
module.exports = router;
