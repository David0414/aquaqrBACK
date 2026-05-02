// src/routes/recharge.js
const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { prisma } = require('../db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const { requireAuth } = require('../utils/auth');
const {
  getPromotionCatalog,
  getPromotionByKey,
  getTopUpBonusCents,
  PROMOTION_KEYS,
  applyRewardCreditTx,
} = require('../utils/rewards');

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
    create: { userId, balanceCents: 0, bonusBalanceCents: 0 },
  });
}

function normalizeMachineId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z_-]/g, '') || 'UNKNOWN';
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

async function settleRechargeSuccessTx(tx, recharge, actualAmountCents, currency, description = 'Recarga por Stripe') {
  await tx.wallet.upsert({
    where: { userId: recharge.userId },
    update: { balanceCents: { increment: actualAmountCents } },
    create: { userId: recharge.userId, balanceCents: actualAmountCents, bonusBalanceCents: 0 },
  });

  await tx.recharge.updateMany({
    where: {
      providerPaymentId: recharge.providerPaymentId,
      userId: recharge.userId,
      status: { not: 'SUCCEEDED' },
    },
    data: {
      status: 'SUCCEEDED',
      bonusCents: recharge.bonusCents || 0,
    },
  });

  await tx.ledgerEntry.create({
    data: {
      userId: recharge.userId,
      type: 'CREDIT',
      amountCents: actualAmountCents,
      currency,
      description,
      source: 'stripe',
      externalId: recharge.providerPaymentId,
      status: 'POSTED',
    },
  });

  if ((recharge.bonusCents || 0) > 0) {
    await applyRewardCreditTx(tx, {
      userId: recharge.userId,
      promotionKey: PROMOTION_KEYS.TOPUP,
      externalId: `reward:topup:${recharge.providerPaymentId}`,
      amountCents: recharge.bonusCents,
      description: `Bonificacion por recarga de $${(actualAmountCents / 100).toFixed(2)}`,
      metadata: {
        rechargeId: recharge.id,
        providerPaymentId: recharge.providerPaymentId,
        amountCents: actualAmountCents,
      },
    });
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
    const promotions = await getPromotionCatalog(prisma);
    const topupPromotion = getPromotionByKey(promotions, PROMOTION_KEYS.TOPUP);
    const bonusCents = getTopUpBonusCents(amountCents, topupPromotion);

    // 1) Creamos la recarga en estado PENDING
    const recharge = await prisma.recharge.create({
      data: {
        userId,
        provider: 'STRIPE',
        amountCents,
        bonusCents,
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

    return res.json({
      clientSecret: intent.client_secret,
      rechargeId: recharge.id,
      bonusCents,
      totalReceiveCents: amountCents + bonusCents,
    });
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
      description: (r.bonusCents || 0) > 0 ? 'Recarga de saldo con bonificacion' : 'Recarga de saldo',
      amount: (r.amountCents || 0) / 100, // número en unidades para la UI
      bonusAmount: (r.bonusCents || 0) / 100,
      totalReceivedAmount: ((r.amountCents || 0) + (r.bonusCents || 0)) / 100,
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
  const recharge = await tx.recharge.findFirst({
    where: { providerPaymentId, userId },
  });
  if (!recharge) return;

  await settleRechargeSuccessTx(
    tx,
    recharge,
    amountCents,
    currency,
    'Recarga por Stripe (reconciliada)'
  );
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

/**
 * POST /api/recharge/telemetry-credit
 * Body: { machineId: string, insertedAmount: number, accumulatedAmount?: number, pulseCount?: number, rawFrame?: string }
 * Acredita saldo por telemetria de monedas sin tocar la logica Stripe.
 * Si la maquina reporta dinero acumulado, se acredita el delta contra la ultima lectura.
 */
router.post('/telemetry-credit', requireAuth, async (req, res) => {
  try {
    const { userId, email, name } = req.auth;
    const machineId = normalizeMachineId(req.body?.machineId);
    const insertedAmount = Number.parseInt(req.body?.insertedAmount, 10);
    const accumulatedAmount = Number.parseInt(req.body?.accumulatedAmount, 10);
    const pulseCount = Number.parseInt(req.body?.pulseCount, 10);
    const rawFrame = typeof req.body?.rawFrame === 'string' ? req.body.rawFrame.trim().slice(0, 255) : null;
    const hasInsertedAmount = Number.isFinite(insertedAmount) && insertedAmount >= 0;
    const hasAccumulatedAmount = Number.isFinite(accumulatedAmount) && accumulatedAmount >= 0;

    if (!hasInsertedAmount && !hasAccumulatedAmount) {
      return res.status(400).json({ error: 'insertedAmount/acumulatedAmount invalidos' });
    }

    await ensureUserAndWallet({ userId, email, name });

    const result = await prisma.$transaction(async (tx) => {
      const checkpoint = await tx.telemetryCreditCheckpoint.upsert({
        where: { userId_machineId: { userId, machineId } },
        update: {},
        create: {
          userId,
          machineId,
          lastPulseCount: 0,
          lastAmountCents: 0,
          lastFrame: rawFrame,
        },
      });

      const accumulatedCents = hasAccumulatedAmount
        ? accumulatedAmount * 100
        : checkpoint.lastAmountCents;
      const insertedCents = hasInsertedAmount && insertedAmount > 0 ? insertedAmount * 100 : 0;

      if (rawFrame && checkpoint.lastFrame === rawFrame) {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        return {
          creditedCents: 0,
          creditedPesos: 0,
          balanceCents: Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0),
          insertedAmount: hasInsertedAmount ? insertedAmount : 0,
          accumulatedAmount: accumulatedCents / 100,
          pulseCount,
          machineId,
          duplicateFrame: true,
          resetDetected: false,
        };
      }

      if (accumulatedCents < checkpoint.lastAmountCents) {
        await tx.telemetryCreditCheckpoint.update({
          where: { id: checkpoint.id },
          data: {
            lastPulseCount: Number.isFinite(pulseCount) && pulseCount >= 0 ? pulseCount : 0,
            lastAmountCents: accumulatedCents,
            lastFrame: rawFrame,
          },
        });

        const wallet = await tx.wallet.findUnique({ where: { userId } });
        return {
          creditedCents: 0,
          creditedPesos: 0,
          balanceCents: Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0),
          insertedAmount: hasInsertedAmount ? insertedAmount : 0,
          accumulatedAmount: hasAccumulatedAmount ? accumulatedAmount : accumulatedCents / 100,
          previousAccumulatedAmount: checkpoint.lastAmountCents / 100,
          pulseCount,
          previousPulseCount: checkpoint.lastPulseCount ?? 0,
          machineId,
          resetDetected: true,
        };
      }

      const creditedCents = hasAccumulatedAmount
        ? Math.max(0, accumulatedCents - checkpoint.lastAmountCents)
        : insertedCents;
      if (creditedCents <= 0) {
        await tx.telemetryCreditCheckpoint.update({
          where: { id: checkpoint.id },
          data: {
            lastPulseCount: Number.isFinite(pulseCount) && pulseCount >= 0 ? pulseCount : checkpoint.lastPulseCount,
            lastAmountCents: accumulatedCents,
            lastFrame: rawFrame,
          },
        });

        const wallet = await tx.wallet.findUnique({ where: { userId } });
        return {
          creditedCents: 0,
          creditedPesos: 0,
          balanceCents: Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0),
          insertedAmount: hasInsertedAmount ? insertedAmount : 0,
          accumulatedAmount: hasAccumulatedAmount ? accumulatedAmount : accumulatedCents / 100,
          previousAccumulatedAmount: checkpoint.lastAmountCents / 100,
          pulseCount,
          previousPulseCount: checkpoint.lastPulseCount ?? 0,
          machineId,
          resetDetected: false,
        };
      }

      const wallet = await tx.wallet.upsert({
        where: { userId },
        update: { balanceCents: { increment: creditedCents } },
        create: { userId, balanceCents: creditedCents, bonusBalanceCents: 0 },
      });

      await tx.telemetryCreditCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          lastPulseCount: Number.isFinite(pulseCount) && pulseCount >= 0 ? pulseCount : checkpoint.lastPulseCount,
          lastAmountCents: accumulatedCents,
          lastFrame: rawFrame,
        },
      });

      const creditedPesos = creditedCents / 100;
      await tx.ledgerEntry.create({
        data: {
          userId,
          type: 'CREDIT',
          amountCents: creditedCents,
          currency: 'MXN',
          description: `Recarga por telemetria de moneda ($${creditedPesos} acreditados)`,
          source: 'telemetry-coin',
          externalId: `telemetry:${userId}:${machineId}:${rawFrame || `${checkpoint.lastAmountCents}:${insertedCents}`}`,
          status: 'POSTED',
        },
      });

      return {
        creditedCents,
        creditedPesos,
        balanceCents: Number(wallet.balanceCents || 0) + Number(wallet.bonusBalanceCents || 0),
        insertedAmount: hasInsertedAmount ? insertedAmount : 0,
        accumulatedAmount: hasAccumulatedAmount ? accumulatedAmount : accumulatedCents / 100,
        previousAccumulatedAmount: checkpoint.lastAmountCents / 100,
        pulseCount,
        previousPulseCount: checkpoint.lastPulseCount ?? 0,
        machineId,
        resetDetected: false,
      };
    });

    return res.json(result);
  } catch (e) {
    console.error('POST /api/recharge/telemetry-credit error', e);
    return res.status(500).json({ error: 'No se pudo acreditar la recarga por telemetria' });
  }
});

module.exports = router;
