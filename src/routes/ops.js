// src/routes/ops.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { prisma } = require('../db'); // 👈 usa el singleton

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

function requireOpsAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_OPS_TOKEN || token !== process.env.ADMIN_OPS_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

async function creditIfPending({ userId, rechargeId, providerPaymentId, amountCents, currency }) {
  return prisma.$transaction(async (tx) => {
    const upd = await tx.recharge.updateMany({
      where: { id: rechargeId, status: 'PENDING' },
      data: { status: 'SUCCEEDED' },
    });
    if (upd.count === 0) return { credited: false, reason: 'not-pending' };

    const exists = await tx.ledgerEntry.findFirst({
      where: { externalId: providerPaymentId, userId },
      select: { id: true },
    });
    if (exists) return { credited: false, reason: 'ledger-exists' };

    await tx.wallet.upsert({
      where: { userId },
      update: { balanceCents: { increment: amountCents } },
      create: { userId, balanceCents: amountCents },
    });

    await tx.ledgerEntry.create({
      data: {
        userId,
        type: 'CREDIT',
        amountCents,
        currency: (currency || 'MXN').toUpperCase(),
        description: 'Recarga por Stripe (reconciliación)',
        source: 'stripe',
        externalId: providerPaymentId,
        status: 'POSTED',
      },
    });

    return { credited: true };
  });
}

router.get('/reconcile/recharges', requireOpsAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

    const pendings = await prisma.recharge.findMany({
      where: { status: 'PENDING', providerPaymentId: { not: null } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    const results = [];
    for (const r of pendings) {
      try {
        const pi = await stripe.paymentIntents.retrieve(r.providerPaymentId);
        const status = pi.status;

        if (status === 'succeeded') {
          const amountCents = pi.amount_received ?? pi.amount ?? r.amountCents ?? 0;
          const currency = (pi.currency || r.currency || 'MXN').toUpperCase();
          const out = await creditIfPending({
            userId: r.userId,
            rechargeId: r.id,
            providerPaymentId: r.providerPaymentId,
            amountCents,
            currency,
          });
          results.push({ rechargeId: r.id, providerPaymentId: r.providerPaymentId, action: 'credited', detail: out });
        } else if (status === 'canceled') {
          await prisma.recharge.updateMany({
            where: { id: r.id, status: 'PENDING' },
            data: { status: 'CANCELED' },
          });
          results.push({ rechargeId: r.id, action: 'marked-canceled' });
        } else if (status === 'requires_payment_method' || status === 'requires_confirmation') {
          await prisma.recharge.updateMany({
            where: { id: r.id, status: 'PENDING' },
            data: { status: 'FAILED' },
          });
          results.push({ rechargeId: r.id, action: 'marked-failed', stripeStatus: status });
        } else {
          results.push({ rechargeId: r.id, action: 'left-pending', stripeStatus: status });
        }
      } catch (err) {
        results.push({ rechargeId: r.id, error: err.message });
      }
    }

    return res.json({ checked: pendings.length, results });
  } catch (e) {
    console.error('Reconcile error', e);
    return res.status(500).json({ error: 'reconcile-failed' });
  }
});

module.exports = router;
