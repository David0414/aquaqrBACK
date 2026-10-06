// src/routes/history.js
const express = require('express');
const router = express.Router();
const { prisma } = require('../db');   // 👈 usa el singleton
const { requireAuth } = require('../utils/auth');
const { getRechargeHistoryItems } = require('../utils/rechargeHistory');
const { membershipHistoryItem } = require('../utils/membershipHistory');
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
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '100', 10) || 100, 200));

    const rechargesPromise = getRechargeHistoryItems(prisma, userId, { limit });

    const dispensesPromise = prisma.dispense.findMany({
      where: { userId },
      orderBy: { id: 'desc' },
      take: limit
    });

    const membershipsPromise = prisma.userMembership.findMany({ where: { userId }, orderBy: { startsAt: 'desc' }, take: limit });
    const [recharges, dispenses, memberships] = await Promise.all([rechargesPromise, dispensesPromise, membershipsPromise]);

    const items = [
      ...recharges,
      ...memberships.map(membershipHistoryItem),
      ...dispenses.map(d => ({
        id: d.id,
        type: 'dispensing',
        description: d.description || 'Dispensado de agua',
        amount: Math.max(0, Number(d.amountCents ?? d.totalCents ?? 0) - Number(d.membershipCoveredCents || 0)) / 100,
        membershipCoveredLiters: Number(d.membershipCoveredLiters || 0),
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
