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
} = require('../utils/rewards');

function moneyFromCents(amountCents) {
  return Number((Number(amountCents || 0) / 100).toFixed(2));
}

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const { userId, email, name } = req.auth;

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

    await ensureWelcomeReward(prisma, userId);
    await settleMonthlyRewards(prisma, userId);

    const [wallet, promotions, preview, totals, rewardCredits, dispenseStats, transactionCounts, user] = await Promise.all([
      prisma.wallet.findUnique({ where: { userId } }),
      getPromotionCatalog(prisma),
      getCurrentMonthRewardPreview(prisma, userId),
      getUserRewardTotals(prisma, userId),
      getRewardCredits(prisma, userId, 10),
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
        config: promotion.config || {},
        status: promotion.key === 'welcome_first_garrafon'
          ? {
              available: welcomeAvailable,
              used: welcomeUsed,
              label: welcomeAvailable ? 'Disponible' : (welcomeUsed ? 'Usada' : 'Activa'),
              creditAmountCents: Number(welcomeCredit?.amountCents || 0),
            }
          : null,
      })),
      welcomeReward: {
        available: welcomeAvailable,
        used: welcomeUsed,
        amountCents: Number(welcomeCredit?.amountCents || 0),
        amount: moneyFromCents(welcomeCredit?.amountCents || 0),
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

module.exports = router;
