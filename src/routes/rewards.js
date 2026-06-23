const express = require('express');
const router = express.Router();
const { prisma } = require('../db');
const { requireAuth } = require('../utils/auth');
const {
  ensureWelcomeReward,
  settleMonthlyRewards,
  getPromotionCatalog,
  getCurrentMonthRewardPreview,
  getUserRewardTotals,
  getRewardCredits,
  getUserPromotionSelectionState,
  saveUserPromotionSelections,
  isMonthlySelectablePromotion,
  getPromotionByKey,
  applyRewardCreditTx,
  PROMOTION_SELECTION_DAYS,
} = require('../utils/rewards');

function moneyFromCents(amountCents) {
  return Number((Number(amountCents || 0) / 100).toFixed(2));
}

function totalAvailableBalanceCents(wallet) {
  return Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0);
}

function normalizeMachineId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z_-]/g, '');
}

function normalizeHardwareId(value) {
  const clean = String(value || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  return clean ? clean.padStart(2, '0').slice(-2) : null;
}

function defaultPricePerGarrafonCents() {
  return Number.parseInt(process.env.PRICE_PER_GARRAFON_CENTS || '3500', 10) || 3500;
}

async function getMachinePricePerGarrafonCents(machineIdValue, hardwareIdValue) {
  const machineId = normalizeMachineId(machineIdValue);
  const hardwareId = normalizeHardwareId(hardwareIdValue);
  let machine = null;

  if (machineId) {
    machine = await prisma.machine.findUnique({ where: { id: machineId } }).catch(() => null);
  }

  if (!machine && hardwareId) {
    machine = await prisma.machine.findFirst({ where: { hardwareId } }).catch(() => null);
  }

  return Number(machine?.pricePerGarrafonCents || defaultPricePerGarrafonCents());
}

async function debitWalletBalanceTx(tx, userId, amountCents) {
  const wallet = await tx.wallet.findUnique({ where: { userId } });
  const total = totalAvailableBalanceCents(wallet);
  if (total < amountCents) {
    const error = new Error('INSUFFICIENT_FUNDS');
    error.code = 'INSUFFICIENT_FUNDS';
    error.statusCode = 400;
    error.balanceCents = total;
    error.neededCents = amountCents - total;
    throw error;
  }

  const bonusDebitedCents = Math.min(Number(wallet?.bonusBalanceCents || 0), amountCents);
  const realDebitedCents = amountCents - bonusDebitedCents;
  return tx.wallet.update({
    where: { userId },
    data: {
      balanceCents: { decrement: realDebitedCents },
      bonusBalanceCents: { decrement: bonusDebitedCents },
    },
  });
}

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const { userId, email, name } = req.auth;

    await Promise.all([
      prisma.user.upsert({
        where: { id: userId },
        update: { email, name },
        create: { id: userId, email, name },
      }),
      prisma.wallet.upsert({
        where: { userId },
        update: {},
        create: { userId, balanceCents: 0, bonusBalanceCents: 0 },
      }),
    ]);

    const promotions = await getPromotionCatalog(prisma);

    await Promise.all([
      ensureWelcomeReward(prisma, userId, promotions),
      settleMonthlyRewards(prisma, userId, new Date(), promotions),
    ]);

    const activeMembershipSince = new Date(Date.now() - PROMOTION_SELECTION_DAYS * 24 * 60 * 60 * 1000);
    const membershipPromotionKeys = promotions
      .filter((promotion) => promotion.kind === 'membership')
      .map((promotion) => promotion.key);

    const [wallet, preview, totals, rewardCredits, activeMembershipCredits, dispenseStats, transactionCounts, user, selectionState] = await Promise.all([
      prisma.wallet.findUnique({ where: { userId } }),
      getCurrentMonthRewardPreview(prisma, userId, new Date(), promotions),
      getUserRewardTotals(prisma, userId),
      getRewardCredits(prisma, userId, 10),
      prisma.rewardCredit.findMany({
        where: {
          userId,
          promotionKey: { in: membershipPromotionKeys },
          createdAt: { gte: activeMembershipSince },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.dispense.aggregate({
        where: { userId, status: 'COMPLETED' },
        _sum: { liters: true, totalCents: true },
        _count: { id: true },
      }),
      Promise.all([
        prisma.recharge.count({ where: { userId } }),
        prisma.dispense.count({ where: { userId } }),
      ]),
      prisma.user.findUnique({
        where: { id: userId },
        select: { createdAt: true },
      }),
      getUserPromotionSelectionState(prisma, userId, new Date(), promotions),
    ]);

    const realBalanceCents = Number(wallet?.balanceCents || 0);
    const bonusBalanceCents = Number(wallet?.bonusBalanceCents || 0);
    const totalAvailableCents = realBalanceCents + bonusBalanceCents;
    const totalLitersDispensed = Number(dispenseStats._sum.liters || 0);
    const totalSpentCents = Number(dispenseStats._sum.totalCents || 0);
    const rechargeCount = Number(transactionCounts[0] || 0);
    const dispenseCount = Number(transactionCounts[1] || 0);
    const transactionCount = rechargeCount + dispenseCount;
    const membershipDays = user?.createdAt
      ? Math.max(1, Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)))
      : 1;
    const welcomeCredit = rewardCredits.find((item) => item.promotionKey === 'welcome_first_garrafon') || null;
    const welcomeAvailable = Boolean(welcomeCredit) && rechargeCount === 0 && dispenseCount === 0;
    const welcomeUsed = Boolean(welcomeCredit) && !welcomeAvailable;
    const activeMembershipByKey = new Map(activeMembershipCredits.map((item) => [item.promotionKey, item]));
    const isPromotionEnabledForUser = (promotion) => {
      if (!isMonthlySelectablePromotion(promotion)) return Boolean(promotion.isActive);
      if (promotion.kind === 'membership') {
        return selectionState.selectedPromotionKeys.includes(promotion.key) && activeMembershipByKey.has(promotion.key);
      }
      return selectionState.selectedPromotionKeys.includes(promotion.key);
    };

    return res.json({
      wallet: {
        balanceCents: totalAvailableCents,
        realBalanceCents,
        bonusBalanceCents,
        totalAvailableCents,
      },
      stats: {
        totalLitersDispensed,
        totalSpentCents,
        transactionCount,
        rechargeCount,
        dispenseCount,
        membershipDays,
      },
      bonusSummary: {
        totalBonusEarnedCents: totals.totalBonusEarnedCents,
        totalBonusEarned: moneyFromCents(totals.totalBonusEarnedCents),
        bonusRewardsCount: totals.bonusRewardsCount,
      },
      monthlyProgress: preview,
      promotions: promotions.map((promotion) => ({
        key: promotion.key,
        title: promotion.title,
        summary: promotion.summary,
        description: promotion.description,
        kind: promotion.kind,
        sortOrder: promotion.sortOrder,
        isActive: Boolean(promotion.isActive),
        requiresMonthlySelection: isMonthlySelectablePromotion(promotion),
        isSelectedForMonth: selectionState.selectedPromotionKeys.includes(promotion.key),
        isEnabledForUserThisMonth: isPromotionEnabledForUser(promotion),
        config: promotion.config || {},
        status: promotion.key === 'welcome_first_garrafon'
          ? {
              available: welcomeAvailable,
              used: welcomeUsed,
              label: welcomeAvailable ? 'Disponible' : (welcomeUsed ? 'Usada' : 'Activa'),
              creditAmountCents: Number(welcomeCredit?.amountCents || 0),
            }
          : promotion.kind === 'membership'
            ? {
                purchased: activeMembershipByKey.has(promotion.key),
                label: activeMembershipByKey.has(promotion.key) ? 'Pagada' : 'Pagar para activar',
                creditAmountCents: Number(activeMembershipByKey.get(promotion.key)?.amountCents || 0),
                activeUntil: selectionState.expiresAt,
              }
            : null,
      })),
      welcomeReward: {
        available: welcomeAvailable,
        used: welcomeUsed,
        amountCents: Number(welcomeCredit?.amountCents || 0),
        amount: moneyFromCents(welcomeCredit?.amountCents || 0),
      },
      selection: {
        month: selectionState.month,
        requiredCount: selectionState.requiredCount,
        selectedPromotionKeys: selectionState.selectedPromotionKeys,
        complete: selectionState.complete,
        expiresAt: selectionState.expiresAt,
        durationDays: selectionState.durationDays,
        selectablePromotions: selectionState.selectablePromotions.map((promotion) => ({
          key: promotion.key,
          title: promotion.title,
          summary: promotion.summary,
          description: promotion.description,
          kind: promotion.kind,
          sortOrder: promotion.sortOrder,
          config: promotion.config || {},
        })),
      },
      recentBonusCredits: rewardCredits.map((item) => ({
        id: item.id,
        promotionKey: item.promotionKey,
        amountCents: item.amountCents,
        amount: moneyFromCents(item.amountCents),
        description: item.description,
        createdAt: item.createdAt,
        metadata: item.metadata || {},
      })),
    });
  } catch (error) {
    console.error('GET /api/rewards/summary error', error);
    return res.status(500).json({ error: 'No se pudo cargar el resumen de recompensas' });
  }
});

router.put('/selection', requireAuth, async (req, res) => {
  try {
    const { userId, email, name } = req.auth;
    const promotionKeys = Array.isArray(req.body?.promotionKeys) ? req.body.promotionKeys : [];

    await Promise.all([
      prisma.user.upsert({
        where: { id: userId },
        update: { email, name },
        create: { id: userId, email, name },
      }),
      prisma.wallet.upsert({
        where: { userId },
        update: {},
        create: { userId, balanceCents: 0, bonusBalanceCents: 0 },
      }),
    ]);

    const promotions = await getPromotionCatalog(prisma);
    const result = await saveUserPromotionSelections(prisma, userId, promotionKeys, new Date(), promotions);

    return res.json({
      ok: true,
      selection: result,
    });
  } catch (error) {
    console.error('PUT /api/rewards/selection error', error);
    return res.status(400).json({ error: error.message || 'No se pudo guardar tu seleccion de promociones' });
  }
});

router.post('/membership/purchase', requireAuth, async (req, res) => {
  try {
    const { userId, email, name } = req.auth;
    const promotionKey = String(req.body?.promotionKey || '').trim();

    await Promise.all([
      prisma.user.upsert({
        where: { id: userId },
        update: { email, name },
        create: { id: userId, email, name },
      }),
      prisma.wallet.upsert({
        where: { userId },
        update: {},
        create: { userId, balanceCents: 0, bonusBalanceCents: 0 },
      }),
    ]);

    const promotions = await getPromotionCatalog(prisma);
    const promotion = getPromotionByKey(promotions, promotionKey);
    if (!promotion?.isActive || promotion.kind !== 'membership') {
      return res.status(400).json({ error: 'Membresia no disponible' });
    }

    const selectionState = await getUserPromotionSelectionState(prisma, userId, new Date(), promotions);
    if (!selectionState.selectedPromotionKeys.includes(promotionKey)) {
      return res.status(400).json({ error: 'Primero elige esta membresia en tus promociones' });
    }

    const activeSince = new Date(Date.now() - PROMOTION_SELECTION_DAYS * 24 * 60 * 60 * 1000);
    const existingMembershipCredit = await prisma.rewardCredit.findFirst({
      where: {
        userId,
        promotionKey,
        createdAt: { gte: activeSince },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingMembershipCredit) {
      return res.status(409).json({
        error: 'MEMBERSHIP_ALREADY_ACTIVE',
        message: 'Esta membresia ya esta activa por 30 dias.',
        activeUntil: selectionState.expiresAt,
      });
    }

    const monthlyPriceCents = Number(promotion.config?.monthlyPriceCents || 0);
    const garrafones = Number(promotion.config?.garrafones || 0);
    const pricePerGarrafonCents = await getMachinePricePerGarrafonCents(req.body?.machineId, req.body?.hardwareId);
    const planValueCents = Math.round(garrafones * pricePerGarrafonCents);

    if (!monthlyPriceCents || !garrafones || planValueCents <= 0) {
      return res.status(400).json({ error: 'Configuracion de membresia invalida' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await debitWalletBalanceTx(tx, userId, monthlyPriceCents);

      await tx.ledgerEntry.create({
        data: {
          userId,
          type: 'DEBIT',
          amountCents: monthlyPriceCents,
          currency: 'MXN',
          description: `Pago de ${promotion.title}`,
          source: `MEMBERSHIP:${promotionKey}`,
          externalId: `MEMBERSHIP:${userId}:${promotionKey}:${Date.now()}`,
          status: 'POSTED',
        },
      });

      const reward = await applyRewardCreditTx(tx, {
        userId,
        promotionKey,
        externalId: `reward:membership:${userId}:${promotionKey}:${Date.now()}`,
        amountCents: planValueCents,
        description: `${promotion.title}: ${garrafones} garrafones por 30 dias`,
        metadata: {
          rule: 'membership-wallet-purchase',
          garrafones,
          monthlyPriceCents,
          pricePerGarrafonCents,
          planValueCents,
          durationDays: PROMOTION_SELECTION_DAYS,
          machineId: normalizeMachineId(req.body?.machineId) || null,
          hardwareId: normalizeHardwareId(req.body?.hardwareId),
        },
      });

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      return { reward, wallet };
    });

    return res.json({
      ok: true,
      promotionKey,
      amountCents: monthlyPriceCents,
      planValueCents,
      creditedCents: planValueCents,
      activeUntil: selectionState.expiresAt,
      wallet: {
        balanceCents: totalAvailableBalanceCents(result.wallet),
        realBalanceCents: Number(result.wallet?.balanceCents || 0),
        bonusBalanceCents: Number(result.wallet?.bonusBalanceCents || 0),
      },
    });
  } catch (error) {
    if (error.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({
        error: 'INSUFFICIENT_FUNDS',
        message: 'No tienes saldo suficiente para pagar esta membresia',
        balanceCents: error.balanceCents,
        neededCents: error.neededCents,
      });
    }

    console.error('POST /api/rewards/membership/purchase error', error);
    return res.status(500).json({ error: error.message || 'No se pudo pagar la membresia' });
  }
});

module.exports = router;
