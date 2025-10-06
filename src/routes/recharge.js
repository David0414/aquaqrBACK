// src/routes/recharge.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const { requireAuth } = require('../utils/auth');

/* -----------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------*/

/** Crea/actualiza el usuario (PK = Clerk ID) y asegura wallet existente. */
async function ensureUserAndWallet({ userId, email, name }) {
  await prisma.user.upsert({
    where: { id: userId },
    update: { email, name },
    create: { id: userId, email, name },
  });

  await prisma.wallet.upsert({
    where: { userId },
    update: {},
    create: { userId, balanceCents: 0 },
  });
}

/** Mapea estatus de Prisma -> etiqueta de UI */
function mapStatusToUi(status) {
  switch (status) {
    case 'SUCCEEDED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'PENDING':
      return 'pending';
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'completed';
  }
}

/* -----------------------------------------------------------------------------
 * POST /api/recharge/create-intent
 * Body: { amountCents: number }
 * Respuesta: { clientSecret }
 * ---------------------------------------------------------------------------*/
router.post('/create-intent', requireAuth, async (req, res) => {
  try {
    const { amountCents } = req.body;

    // Validaciones
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amountCents inválido' });
    }
    if (amountCents < 10 * 100) {
      return res.status(400).json({ error: 'Monto mínimo $10.00' });
    }
    if (amountCents > 500 * 100) {
      return res.status(400).json({ error: 'Monto máximo $500.00' });
    }

    const stripeCurrency = (process.env.CURRENCY || 'mxn').toLowerCase(); // Stripe usa lowercase
    const dbCurrency = stripeCurrency.toUpperCase();                      // En DB guardamos uppercase

    // Info del usuario autenticado (puesta por requireAuth)
    const { userId, email, name } = req.auth;

    // Asegura existencia de usuario y wallet
    await ensureUserAndWallet({ userId, email, name });

    // 1) Creamos la recarga en estado PENDING
    const recharge = await prisma.recharge.create({
      data: {
        userId,
        provider: 'STRIPE',
        amountCents,
        bonusCents: 0, // si das bono según monto, cámbialo aquí
        currency: dbCurrency,
        status: 'PENDING',
      },
    });

    // 2) Creamos el PaymentIntent y pasamos metadata para el webhook
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: stripeCurrency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        rechargeId: recharge.id,
        userId, // tu PK de User
      },
      receipt_email: email || undefined,
      description: 'AquaQR wallet top-up',
    });

    // 3) Guardamos el intent.id para reconciliar por ambos lados si hace falta
    await prisma.recharge.update({
      where: { id: recharge.id },
      data: { providerPaymentId: intent.id },
    });

    return res.json({ clientSecret: intent.client_secret, rechargeId: recharge.id });
  } catch (err) {
    console.error('POST /api/recharge/create-intent error', err);
    return res.status(500).json({ error: 'No se pudo crear el intento de pago' });
  }
});

/* -----------------------------------------------------------------------------
 * GET /api/recharge/history?limit=20&cursor=<rechargeId>
 * Devuelve la lista paginada de recargas del usuario actual
 * ---------------------------------------------------------------------------*/
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
    const cursor = req.query.cursor || null;

    const rows = await prisma.recharge.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1, // pedimos una más para saber si hay más páginas
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const items = page.map((r) => ({
      id: r.id,
      type: 'recharge',
      description: 'Recarga de saldo',
      amount: (r.amountCents || 0) / 100, // número en unidades para la UI
      currency: (r.currency || 'MXN').toUpperCase(),
      date: r.createdAt,
      status: mapStatusToUi(r.status),
      paymentMethod: r.provider === 'STRIPE' ? 'Stripe' : r.provider,
      providerPaymentId: r.providerPaymentId || undefined,
    }));

    return res.json({
      items,
      nextCursor: hasMore ? rows[limit].id : null,
      hasMore,
    });
  } catch (e) {
    console.error('GET /api/recharge/history error', e);
    return res.status(500).json({ error: 'No se pudo obtener el historial' });
  }
});

/* -----------------------------------------------------------------------------
 * RECONCILIACIÓN: sana recargas PENDING si el webhook falló
 * ---------------------------------------------------------------------------*/

/** Acredita saldo + marca la recarga como SUCCEEDED (idempotente dentro de la TX). */
async function creditWalletAndCloseRechargeTX(tx, { userId, amountCents, currency, providerPaymentId }) {
  await tx.wallet.upsert({
    where: { userId },
    update: { balanceCents: { increment: amountCents } },
    create: { userId, balanceCents: amountCents },
  });

  await tx.recharge.updateMany({
    where: { providerPaymentId, userId, status: { not: 'SUCCEEDED' } },
    data: { status: 'SUCCEEDED' },
  });

  // asiento contable
  await tx.ledgerEntry.create({
    data: {
      userId,
      type: 'CREDIT',
      amountCents,
      currency,
      description: 'Recarga por Stripe (reconciliada)',
      source: 'stripe-recheck',
      externalId: providerPaymentId,
      status: 'POSTED',
    },
  });
}

/** Consulta Stripe y reconcilia una recarga concreta. */
async function reconcileOneRecharge(recharge) {
  if (!recharge?.providerPaymentId) {
    return { status: recharge.status || 'PENDING' };
  }

  const pi = await stripe.paymentIntents.retrieve(recharge.providerPaymentId);

  if (pi.status === 'succeeded') {
    await prisma.$transaction(async (tx) => {
      const rec = await tx.recharge.findUnique({ where: { id: recharge.id } });
      if (rec?.status === 'SUCCEEDED') return; // ya estaba listo

      const amountCents = pi.amount_received ?? pi.amount ?? 0;
      const currency = (pi.currency || 'mxn').toUpperCase();

      await creditWalletAndCloseRechargeTX(tx, {
        userId: recharge.userId,
        amountCents,
        currency,
        providerPaymentId: recharge.providerPaymentId,
      });
    });

    return { status: 'SUCCEEDED' };
  }

  // reflejar cancelados/fallidos
  if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
    await prisma.recharge.update({
      where: { id: recharge.id },
      data: { status: 'FAILED' },
    });
    return { status: 'FAILED' };
  }

  // aún pendiente
  return { status: 'PENDING' };
}

/**
 * GET /api/recharge/status/:id
 * Devuelve el estado actual de una recarga del usuario.
 */
router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const recharge = await prisma.recharge.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true, status: true, providerPaymentId: true, createdAt: true },
    });
    if (!recharge) return res.status(404).json({ error: 'Recarga no encontrada' });
    res.json({ id: recharge.id, status: recharge.status, providerPaymentId: recharge.providerPaymentId });
  } catch (e) {
    console.error('GET /recharge/status error', e);
    res.status(500).json({ error: 'No se pudo consultar el estado' });
  }
});

/**
 * POST /api/recharge/recheck/:id
 * Fuerza revalidar contra Stripe una recarga en PENDING y la reconcilia si procede.
 */
router.post('/recheck/:id', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const recharge = await prisma.recharge.findFirst({
      where: { id: req.params.id, userId },
    });
    if (!recharge) return res.status(404).json({ error: 'Recarga no encontrada' });

    const result = await reconcileOneRecharge(recharge);
    return res.json({ id: recharge.id, status: result.status });
  } catch (e) {
    console.error('POST /recharge/recheck error', e);
    res.status(500).json({ error: 'No se pudo revalidar con Stripe' });
  }
});

/**
 * POST /api/recharge/reconcile-pending
 * Revisa todas las recargas PENDING del usuario y las sana.
 * (puedes llamarla al entrar a la app, o desde un cron del servidor)
 */
router.post('/reconcile-pending', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const pendings = await prisma.recharge.findMany({
      where: { userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const results = [];
    for (const r of pendings) {
      const out = await reconcileOneRecharge(r);
      results.push({ id: r.id, status: out.status });
    }

    res.json({ reviewed: results.length, results });
  } catch (e) {
    console.error('POST /recharge/reconcile-pending error', e);
    res.status(500).json({ error: 'No se pudo reconciliar' });
  }
});

module.exports = router;
