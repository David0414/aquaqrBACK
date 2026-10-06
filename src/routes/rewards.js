const express = require('express');
const router = express.Router();
const { prisma } = require('../db');
const { requireAuth } = require('../utils/auth');
const { membershipQuote, membershipMachine, activeMembershipWhere } = require('../utils/memberships');
const { purchaseMembership } = require('../utils/membershipPurchase');
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
} = require('../utils/rewards');

function moneyFromCents(amountCents) {
  return Number((Number(amountCents || 0) / 100).toFixed(2));
}

function totalAvailableBalanceCents(wallet) {
  return Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0);
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

    const catalog = await getPromotionCatalog(prisma);
    const machine = req.query.machineId || req.query.hardwareId
      ? await membershipMachine(req.query.machineId, req.query.hardwareId) : null;
    const promotions = catalog.map((promotion) => promotion.kind === 'membership' && machine
      ? { ...promotion, config: { ...promotion.config, ...membershipQuote(promotion, machine.pricePerGarrafonCents) } } : promotion);

    await Promise.all([
      ensureWelcomeReward(prisma, userId, promotions),
      settleMonthlyRewards(prisma, userId, new Date(), promotions),
    ]);

    const [wallet, preview, totals, rewardCredits, activeMemberships, dispenseStats, transactionCounts, user, selectionState] = await Promise.all([
      prisma.wallet.findUnique({ where: { userId } }),
      getCurrentMonthRewardPreview(prisma, userId, new Date(), promotions),
      getUserRewardTotals(prisma, userId),
      getRewardCredits(prisma, userId, 10),
      prisma.userMembership.findMany({
        where: activeMembershipWhere(userId),
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
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
    const activeMembershipByKey = new Map(activeMemberships.map((item) => [item.promotionKey, item]));
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
      machine: machine ? { id: machine.id, name: machine.name, pricePerGarrafonCents: machine.pricePerGarrafonCents } : null,
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
                label: activeMembershipByKey.has(promotion.key) ? 'Activa hasta agotar litros' : 'Sin activar',
                creditAmountCents: 0,
                garrafonesRemaining: Number(activeMembershipByKey.get(promotion.key)?.garrafonesRemaining || 0),
                litersRemaining: Number(activeMembershipByKey.get(promotion.key)?.litersRemaining || 0),
                activeUntil: activeMembershipByKey.get(promotion.key)?.expiresAt || null,
                machineId: activeMembershipByKey.get(promotion.key)?.machineId || null,
                pricePaidCents: activeMembershipByKey.get(promotion.key)?.pricePaidCents || 0,
                garrafonesTotal: activeMembershipByKey.get(promotion.key)?.garrafonesTotal || 0,
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
        activePromotionKeys: selectionState.activePromotionKeys,
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
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'No se pudo cargar el resumen de recompensas' });
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

    const result = await purchaseMembership(prisma, userId, promotion, req.body || {});
    const member = result.membership;
    return res.json({ ok: true, promotionKey, replay: result.replay,
      amountCents: member.pricePaidCents, activeUntil: member.expiresAt, validity: 'UNTIL_USED',
      membership: { id: member.id, promotionKey, machineId: member.machineId, garrafonesRemaining: member.garrafonesRemaining,
        litersRemaining: member.litersRemaining, activeUntil: member.expiresAt },
      wallet: { balanceCents: totalAvailableBalanceCents(result.wallet), realBalanceCents: Number(result.wallet?.balanceCents || 0),
        bonusBalanceCents: Number(result.wallet?.bonusBalanceCents || 0) } });
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
    return res.status(error.statusCode || (error.code === 'P2034' ? 409 : 500)).json({ error: error.code || 'MEMBERSHIP_PURCHASE_FAILED', message: error.code === 'P2034' ? 'La compra cambió al mismo tiempo. Revisa tu saldo e intenta nuevamente.' : error.message, quote: error.quote });
  }
});

module.exports = router;
