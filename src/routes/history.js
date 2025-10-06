// src/routes/history.js
const express = require('express');
const router = express.Router();
const { prisma } = require('../db');   // 👈 usa el singleton
const { requireAuth } = require('../utils/auth');

function mapRechargeStatus(s) {
  switch (s) {
    case 'SUCCEEDED': return 'completed';
    case 'FAILED':    return 'failed';
    case 'PENDING':   return 'pending';
    case 'CANCELED':  return 'cancelled';
    default:          return 'completed';
  }
}
function mapDispenseStatus(s) {
  switch (s) {
    case 'COMPLETED': return 'completed';
    case 'STARTED':   return 'pending';
    case 'FAILED':    return 'failed';
    case 'CANCELED':  return 'cancelled';
    default:          return 'completed';
  }
}

router.get('/history', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);

    const rechargesPromise = prisma.recharge.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: limit
    });

    const dispensesPromise = prisma.dispense.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: limit
    });

    let recharges = [], dispenses = [];
    try { recharges = await rechargesPromise; } catch (e) { console.error('Error fetching recharges', e); }
    try { dispenses = await dispensesPromise; } catch (e) { console.error('Error fetching dispenses', e); }

    const items = [
      ...recharges.map(r => ({
        id: r.id,
        type: 'recharge',
        description: 'Recarga de saldo',
        amount: (r.amountCents || 0) / 100,
        currency: (r.currency || 'MXN').toUpperCase(),
        date: r.createdAt,
        status: mapRechargeStatus(r.status),
        paymentMethod: r.provider === 'STRIPE' ? 'Stripe' : r.provider,
        providerPaymentId: r.providerPaymentId || undefined,
      })),
      ...dispenses.map(d => ({
        id: d.id,
        type: 'dispensing',
        description: d.description || 'Dispensado de agua',
        amount: ((d.amountCents ?? d.totalCents) || 0) / 100,
        currency: (d.currency || 'MXN').toUpperCase(),
        date: d.createdAt,
        status: mapDispenseStatus(d.status),
        machineId: d.machineId || undefined,
        machineLocation: d.machineLocation || undefined,
        liters: d.liters ?? undefined,
      })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date))
     .slice(0, limit);

    res.json({ items, hasMore: false, nextCursor: null });
  } catch (e) {
    console.error('GET /api/history error', e);
    res.status(500).json({ error: 'No se pudo obtener el historial' });
  }
});

module.exports = router;
