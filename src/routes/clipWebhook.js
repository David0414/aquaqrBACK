const express = require('express');
const { prisma } = require('../db');
const { UUID } = require('../utils/clip');
const { reconcileClipRecharge } = require('../utils/clipSettlement');
const { reconcileMachinePremium } = require('../utils/machinePremium');
const router = express.Router();
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
