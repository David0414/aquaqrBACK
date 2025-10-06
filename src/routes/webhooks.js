// src/routes/webhooks.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ---------- Utilidades de idempotencia ----------
async function alreadyHandled(eventId) {
  const existing = await prisma.webhookEvent.findUnique({ where: { eventId } });
  return !!existing;
}
async function markHandled(provider, eventId) {
  await prisma.webhookEvent.create({ data: { provider, eventId } });
}

// ---------- Acreditación de saldo ----------
async function creditWalletAndCloseRecharge({ userId, amountCents, currency, providerPaymentId }) {
  await prisma.$transaction(async (tx) => {
    await tx.wallet.upsert({
      where: { userId },
      update: { balanceCents: { increment: amountCents } },
      create: { userId, balanceCents: amountCents },
    });

    await tx.recharge.updateMany({
      where: { providerPaymentId, userId },
      data: { status: 'SUCCEEDED' },
    });

    await tx.ledgerEntry.create({
      data: {
        userId,
        type: 'CREDIT',
        amountCents,
        currency,
        description: 'Recarga por Stripe',
        source: 'stripe',
        externalId: providerPaymentId,
        status: 'POSTED',
      },
    });
  });
}

// ---------- Webhook (OJO: el RAW body se aplica en server.js) ----------
router.post('/stripe', async (req, res) => {
  console.log('[Webhook] hit /webhooks/stripe');
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
    console.log('[Webhook] event', event.type, event.id);
  } catch (err) {
    console.error('❌ Firma inválida del webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (await alreadyHandled(event.id)) {
      console.log('[Webhook] duplicate', event.id);
      return res.status(200).send('[ok] duplicate');
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const providerPaymentId = pi.id;
      const amountCents = pi.amount_received ?? pi.amount ?? 0;
      const currency = (pi.currency || 'mxn').toUpperCase();

      // 1) de la metadata (lo ponemos al crear el intent)
      let userId = pi.metadata?.userId;

      // 2) fallback: por la fila Recharge
      if (!userId) {
        const rec = await prisma.recharge.findUnique({
          where: { providerPaymentId },
          select: { userId: true },
        });
        userId = rec?.userId;
      }

      console.log('[Webhook] will credit', { userId, amountCents, providerPaymentId });

      if (userId) {
        await creditWalletAndCloseRecharge({
          userId,
          amountCents,
          currency,
          providerPaymentId,
        });
      } else {
        console.warn('⚠️  No se pudo resolver userId para', providerPaymentId);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      await prisma.recharge.updateMany({
        where: { providerPaymentId: pi.id },
        data: { status: 'FAILED' },
      });
    }

    await markHandled('STRIPE', event.id);
    return res.json({ received: true });
  } catch (e) {
    console.error('❌ Error procesando webhook:', e);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
