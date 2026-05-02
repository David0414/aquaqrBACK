const { prisma } = require('../db');

const CURRENCY = (process.env.CURRENCY || 'mxn').toUpperCase();
const GARRAFON_LITERS = Number.parseInt(process.env.GARRAFON_LITERS || '20', 10) || 20;
const PRICE_PER_GARRAFON_CENTS = Number.parseInt(process.env.PRICE_PER_GARRAFON_CENTS || '3500', 10) || 3500;
const DEFAULT_POINTS_PER_LITER = 10;

const PROMOTION_KEYS = Object.freeze({
  WELCOME: 'welcome_first_garrafon',
  TOPUP: 'topup_bonus',
  CASHBACK: 'monthly_cashback',
  POINTS: 'monthly_consumption_points',
  MEMBERSHIP: 'premium_membership',
});

const DEFAULT_PROMOTIONS = Object.freeze([
  {
    key: PROMOTION_KEYS.WELCOME,
    title: 'Recompensa registro primera vez',
    summary: 'Primer garrafon gratis',
    description: 'Cuando una persona se registra por primera vez, recibe su primer garrafon gratis. Sirve para que pruebe el servicio sin pagar la primera vez.',
    kind: 'welcome',
    sortOrder: 1,
    isActive: true,
    config: {
      welcomeBonusCents: PRICE_PER_GARRAFON_CENTS,
    },
  },
  {
    key: PROMOTION_KEYS.TOPUP,
    title: 'Recompensa por deposito (Top-Up)',
    summary: 'Bonos por recarga real',
    description: 'Recarga $100 y recibe $110, recarga $200 y recibe $230, recarga $500 y recibe $580. Mientras mas dinero recarga el cliente, mas saldo extra recibe.',
    kind: 'topup',
    sortOrder: 2,
    isActive: true,
    config: {
      tiers: [
        { amountCents: 10000, bonusCents: 1000, label: 'Recarga $100 -> recibe $110' },
        { amountCents: 20000, bonusCents: 3000, label: 'Recarga $200 -> recibe $230' },
        { amountCents: 50000, bonusCents: 8000, label: 'Recarga $500 -> recibe $580' },
      ],
    },
  },
  {
    key: PROMOTION_KEYS.CASHBACK,
    title: 'Cashback mensual',
    summary: 'Bonificacion por garrafones consumidos',
    description: 'Mientras mas garrafones compre el cliente en el mes, mas cashback recibe por garrafon: hasta 5 garrafones $2 por G, hasta 10 garrafones $3 por G y mas de 10 garrafones $4 por G.',
    kind: 'cashback',
    sortOrder: 3,
    isActive: true,
    config: {
      litersPerGarrafon: GARRAFON_LITERS,
      tiers: [
        { maxGarrafones: 5, cashbackPerGarrafonCents: 200, label: 'Hasta 5 garrafones -> $2 por G' },
        { maxGarrafones: 10, cashbackPerGarrafonCents: 300, label: 'Hasta 10 garrafones -> $3 por G' },
        { maxGarrafones: null, cashbackPerGarrafonCents: 400, label: 'Mas de 10 garrafones -> $4 por G' },
      ],
    },
  },
  {
    key: PROMOTION_KEYS.POINTS,
    title: 'Recompensa por consumo mensual',
    summary: 'Saldo extra segun puntos acumulados',
    description: 'El cliente gana puntos por comprar, y al llegar a ciertos niveles recibe saldo extra: 0 a 199 puntos sin beneficio, 200 puntos 5%, 500 puntos 10%, 1000 puntos 20%.',
    kind: 'points',
    sortOrder: 4,
    isActive: true,
    config: {
      pointsPerLiter: DEFAULT_POINTS_PER_LITER,
      tiers: [
        { minPoints: 0, bonusPercent: 0, label: '0-199 puntos -> Sin beneficio' },
        { minPoints: 200, bonusPercent: 5, label: '200 puntos -> 5% saldo extra' },
        { minPoints: 500, bonusPercent: 10, label: '500 puntos -> 10% saldo extra' },
        { minPoints: 1000, bonusPercent: 20, label: '1000 puntos -> 20% saldo extra' },
      ],
    },
  },
  {
    key: PROMOTION_KEYS.MEMBERSHIP,
    title: 'Membresia premium',
    summary: 'No disponible por ahora',
    description: 'La membresia premium sigue desactivada por ahora y no participa en el sistema actual.',
    kind: 'membership',
    sortOrder: 5,
    isActive: false,
    config: {
      plans: [
        { garrafones: 8, monthlyPriceCents: 24000, costPerGarrafonCents: 3000 },
        { garrafones: 11, monthlyPriceCents: 30800, costPerGarrafonCents: 2800 },
        { garrafones: 15, monthlyPriceCents: 39000, costPerGarrafonCents: 2600 },
      ],
    },
  },
]);

function startOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function addMonths(date, delta) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1, 0, 0, 0, 0));
}

function monthKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

async function ensurePromotionCatalog(client = prisma) {
  for (const promotion of DEFAULT_PROMOTIONS) {
    await client.appPromotion.upsert({
      where: { key: promotion.key },
      update: {
        title: promotion.title,
        summary: promotion.summary,
        description: promotion.description,
        kind: promotion.kind,
        sortOrder: promotion.sortOrder,
      },
      create: promotion,
    });
  }
}

async function getPromotionCatalog(client = prisma) {
  await ensurePromotionCatalog(client);
  const rows = await client.appPromotion.findMany({
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  return rows.map((row) => {
    const fallback = DEFAULT_PROMOTIONS.find((item) => item.key === row.key);
    return {
      ...row,
      config: row.config || fallback?.config || {},
    };
  });
}

function getPromotionByKey(promotions, key) {
  return promotions.find((promotion) => promotion.key === key) || null;
}

async function resolvePromotions(client = prisma, promotions = null) {
  if (Array.isArray(promotions) && promotions.length > 0) {
    return promotions;
  }
  return getPromotionCatalog(client);
}

function getTopUpBonusCents(amountCents, promotion) {
  if (!promotion?.isActive) return 0;
  const tiers = Array.isArray(promotion.config?.tiers) ? promotion.config.tiers : [];
  const tier = tiers
    .filter((item) => Number(item.amountCents) <= amountCents)
    .sort((a, b) => Number(b.amountCents) - Number(a.amountCents))[0];
  return Math.max(0, Number(tier?.bonusCents) || 0);
}

function getCashbackTier(garrafones, promotion) {
  const tiers = Array.isArray(promotion?.config?.tiers) ? promotion.config.tiers : [];
  return tiers.find((item) => item.maxGarrafones == null || garrafones <= Number(item.maxGarrafones)) || null;
}

function getPointsTier(points, promotion) {
  const tiers = Array.isArray(promotion?.config?.tiers) ? promotion.config.tiers : [];
  return tiers
    .filter((item) => points >= Number(item.minPoints || 0))
    .sort((a, b) => Number(b.minPoints || 0) - Number(a.minPoints || 0))[0] || null;
}

async function applyRewardCreditTx(tx, reward) {
  const amountCents = Math.max(0, Number(reward.amountCents) || 0);
  if (amountCents <= 0) {
    return { applied: false, amountCents: 0 };
  }

  if (reward.externalId) {
    const existing = await tx.rewardCredit.findUnique({
      where: { externalId: reward.externalId },
      select: { id: true, amountCents: true },
    });
    if (existing) {
      return { applied: false, amountCents: existing.amountCents, existing: true };
    }
  }

  const wallet = await tx.wallet.update({
    where: { userId: reward.userId },
    data: { bonusBalanceCents: { increment: amountCents } },
    select: {
      balanceCents: true,
      bonusBalanceCents: true,
    },
  });

  const rewardCredit = await tx.rewardCredit.create({
    data: {
      userId: reward.userId,
      promotionKey: reward.promotionKey,
      externalId: reward.externalId || null,
      amountCents,
      currency: reward.currency || CURRENCY,
      description: reward.description || null,
      metadata: reward.metadata || undefined,
    },
  });

  return {
    applied: true,
    amountCents,
    wallet,
    rewardCredit,
  };
}

async function ensureWelcomeReward(client, userId, promotions = null) {
  const resolvedPromotions = await resolvePromotions(client, promotions);
  const welcomePromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.WELCOME);
  if (!welcomePromotion?.isActive) return null;

  const wallet = await client.wallet.findUnique({ where: { userId } });
  if (!wallet) return null;

  return client.$transaction(async (tx) => {
    const amountCents = Number(welcomePromotion.config?.welcomeBonusCents) || PRICE_PER_GARRAFON_CENTS;
    return applyRewardCreditTx(tx, {
      userId,
      promotionKey: welcomePromotion.key,
      externalId: `reward:welcome:${userId}`,
      amountCents,
      description: 'Bonificacion de bienvenida: primer garrafon gratis',
      metadata: {
        rule: 'welcome',
      },
    });
  });
}

async function getMonthlyCompletedDispenseStats(client, userId, fromDate, toDate) {
  const aggregate = await client.dispense.aggregate({
    where: {
      userId,
      status: 'COMPLETED',
      createdAt: {
        gte: fromDate,
        lt: toDate,
      },
    },
    _sum: {
      liters: true,
      totalCents: true,
    },
    _count: {
      id: true,
    },
  });

  const liters = Number(aggregate._sum.liters || 0);
  const totalCents = Number(aggregate._sum.totalCents || 0);
  const transactions = Number(aggregate._count.id || 0);
  const litersPerGarrafon = GARRAFON_LITERS;
  const garrafones = litersPerGarrafon > 0 ? liters / litersPerGarrafon : 0;

  return {
    liters,
    totalCents,
    transactions,
    garrafones,
  };
}

async function settleMonthlyRewards(client, userId, now = new Date(), promotions = null) {
  const resolvedPromotions = await resolvePromotions(client, promotions);
  const previousMonth = addMonths(startOfMonth(now), -1);
  const fromDate = previousMonth;
  const toDate = addMonths(fromDate, 1);
  const key = monthKey(fromDate);
  const stats = await getMonthlyCompletedDispenseStats(client, userId, fromDate, toDate);
  const results = [];

  if (stats.liters <= 0 || stats.totalCents <= 0) {
    return {
      settledMonth: key,
      stats,
      results,
    };
  }

  const cashbackPromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.CASHBACK);
  if (cashbackPromotion?.isActive) {
    const cashbackTier = getCashbackTier(stats.garrafones, cashbackPromotion);
    const cashbackPerGarrafonCents = Number(cashbackTier?.cashbackPerGarrafonCents) || 0;
    const cashbackCents = Math.round(stats.garrafones * cashbackPerGarrafonCents);

    const outcome = await client.$transaction(async (tx) => applyRewardCreditTx(tx, {
      userId,
      promotionKey: cashbackPromotion.key,
      externalId: `reward:cashback:${userId}:${key}`,
      amountCents: cashbackCents,
      description: `Cashback mensual ${key}`,
      metadata: {
        month: key,
        liters: stats.liters,
        garrafones: Number(stats.garrafones.toFixed(3)),
        cashbackPerGarrafonCents,
      },
    }));
    results.push({
      promotionKey: cashbackPromotion.key,
      amountCents: cashbackCents,
      applied: outcome.applied,
    });
  }

  const pointsPromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.POINTS);
  if (pointsPromotion?.isActive) {
    const pointsPerLiter = Math.max(1, Number(pointsPromotion.config?.pointsPerLiter) || DEFAULT_POINTS_PER_LITER);
    const points = Math.round(stats.liters * pointsPerLiter);
    const pointsTier = getPointsTier(points, pointsPromotion);
    const bonusPercent = Number(pointsTier?.bonusPercent) || 0;
    const bonusCents = Math.round(stats.totalCents * (bonusPercent / 100));

    const outcome = await client.$transaction(async (tx) => applyRewardCreditTx(tx, {
      userId,
      promotionKey: pointsPromotion.key,
      externalId: `reward:points:${userId}:${key}`,
      amountCents: bonusCents,
      description: `Saldo extra por consumo mensual ${key}`,
      metadata: {
        month: key,
        points,
        bonusPercent,
        liters: stats.liters,
        totalSpentCents: stats.totalCents,
      },
    }));
    results.push({
      promotionKey: pointsPromotion.key,
      amountCents: bonusCents,
      points,
      bonusPercent,
      applied: outcome.applied,
    });
  }

  return {
    settledMonth: key,
    stats,
    results,
  };
}

async function getCurrentMonthRewardPreview(client, userId, now = new Date(), promotions = null) {
  const resolvedPromotions = await resolvePromotions(client, promotions);
  const fromDate = startOfMonth(now);
  const toDate = addMonths(fromDate, 1);
  const stats = await getMonthlyCompletedDispenseStats(client, userId, fromDate, toDate);
  const cashbackPromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.CASHBACK);
  const pointsPromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.POINTS);

  const cashbackTier = cashbackPromotion?.isActive ? getCashbackTier(stats.garrafones, cashbackPromotion) : null;
  const cashbackPerGarrafonCents = Number(cashbackTier?.cashbackPerGarrafonCents) || 0;
  const estimatedCashbackCents = Math.round(stats.garrafones * cashbackPerGarrafonCents);

  const pointsPerLiter = Math.max(1, Number(pointsPromotion?.config?.pointsPerLiter) || DEFAULT_POINTS_PER_LITER);
  const points = Math.round(stats.liters * pointsPerLiter);
  const pointsTier = pointsPromotion?.isActive ? getPointsTier(points, pointsPromotion) : null;
  const bonusPercent = Number(pointsTier?.bonusPercent) || 0;
  const estimatedPointsBonusCents = Math.round(stats.totalCents * (bonusPercent / 100));

  return {
    month: monthKey(fromDate),
    liters: stats.liters,
    garrafones: Number(stats.garrafones.toFixed(3)),
    totalSpentCents: stats.totalCents,
    transactions: stats.transactions,
    pointsPerLiter,
    points,
    cashbackPerGarrafonCents,
    estimatedCashbackCents,
    estimatedPointsBonusCents,
    bonusPercent,
    cashbackLabel: cashbackTier?.label || 'Sin cashback',
    pointsLabel: pointsTier?.label || 'Sin beneficio',
  };
}

async function getUserRewardTotals(client, userId) {
  const aggregate = await client.rewardCredit.aggregate({
    where: { userId },
    _sum: { amountCents: true },
    _count: { id: true },
  });

  return {
    totalBonusEarnedCents: Number(aggregate._sum.amountCents || 0),
    bonusRewardsCount: Number(aggregate._count.id || 0),
  };
}

async function getRewardCredits(client, userId, limit = 12) {
  return client.rewardCredit.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

module.exports = {
  CURRENCY,
  GARRAFON_LITERS,
  PRICE_PER_GARRAFON_CENTS,
  DEFAULT_POINTS_PER_LITER,
  PROMOTION_KEYS,
  DEFAULT_PROMOTIONS,
  ensurePromotionCatalog,
  getPromotionCatalog,
  getPromotionByKey,
  getTopUpBonusCents,
  getCashbackTier,
  getPointsTier,
  applyRewardCreditTx,
  ensureWelcomeReward,
  settleMonthlyRewards,
  getCurrentMonthRewardPreview,
  getUserRewardTotals,
  getRewardCredits,
  monthKey,
  startOfMonth,
};
