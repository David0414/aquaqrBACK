const { prisma } = require('../db');

const CURRENCY = (process.env.CURRENCY || 'mxn').toUpperCase();
const GARRAFON_LITERS = Number.parseInt(process.env.GARRAFON_LITERS || '20', 10) || 20;
const PRICE_PER_GARRAFON_CENTS = Number.parseInt(process.env.PRICE_PER_GARRAFON_CENTS || '3500', 10) || 3500;
const DEFAULT_POINTS_PER_LITER = 10 / GARRAFON_LITERS;

const PROMOTION_KEYS = Object.freeze({
  WELCOME: 'welcome_first_garrafon',
  TOPUP: 'topup_bonus',
  CASHBACK: 'monthly_cashback',
  POINTS: 'monthly_consumption_points',
  MEMBERSHIP_1: 'premium_membership_1',
  MEMBERSHIP_2: 'premium_membership_2',
  MEMBERSHIP_3: 'premium_membership_3',
});

const MONTHLY_SELECTABLE_PROMOTION_KEYS = Object.freeze([
  PROMOTION_KEYS.CASHBACK,
  PROMOTION_KEYS.TOPUP,
  PROMOTION_KEYS.MEMBERSHIP_1,
  PROMOTION_KEYS.MEMBERSHIP_2,
  PROMOTION_KEYS.MEMBERSHIP_3,
]);

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
    summary: 'Recibe saldo extra al recargar',
    description: 'Si eliges esta promocion, tus recargas tienen bono: recarga $100 y recibe $5 extra, recarga $200 y recibe $10 extra, recarga $500 y recibe $30 extra.',
    kind: 'topup',
    sortOrder: 4,
    isActive: true,
    config: {
      tiers: [
        { amountCents: 10000, bonusCents: 500, label: 'Recarga $100 -> recibe $5 adicionales' },
        { amountCents: 20000, bonusCents: 1000, label: 'Recarga $200 -> recibe $10 adicionales' },
        { amountCents: 50000, bonusCents: 3000, label: 'Recarga $500 -> recibe $30 adicionales' },
      ],
    },
  },
  {
    key: PROMOTION_KEYS.CASHBACK,
    title: 'Cashback mensual',
    summary: '$0.50 por cada garrafon comprado',
    description: 'Si eliges esta promocion, al final del mes recibes $0.50 de saldo por cada garrafon comprado durante el mes.',
    kind: 'cashback',
    sortOrder: 3,
    isActive: true,
    config: {
      litersPerGarrafon: GARRAFON_LITERS,
      tiers: [
        { maxGarrafones: null, cashbackPerGarrafonCents: 50, label: '$0.50 por cada garrafon comprado' },
      ],
    },
  },
  {
    key: PROMOTION_KEYS.POINTS,
    title: 'Recompensa por consumo mensual',
    summary: 'Cada 20 litros suman 10 puntos',
    description: 'Beneficio automatico: cada 20 litros equivalen a 10 puntos. De 0 a 199 puntos no hay beneficio; con 200 puntos recibes $10 de saldo extra; con 500 puntos recibes $20; con 1,000 puntos recibes $30. Despues de 1,000 puntos el conteo vuelve a iniciar.',
    kind: 'points',
    sortOrder: 2,
    isActive: true,
    config: {
      pointsPerLiter: DEFAULT_POINTS_PER_LITER,
      resetAtPoints: 1000,
      tiers: [
        { minPoints: 0, bonusCents: 0, label: '0-199 puntos -> Sin beneficio' },
        { minPoints: 200, bonusCents: 1000, label: '200 puntos -> $10 saldo extra' },
        { minPoints: 500, bonusCents: 2000, label: '500 puntos -> $20 saldo extra' },
        { minPoints: 1000, bonusCents: 3000, label: '1,000 puntos -> $30 saldo extra' },
      ],
    },
  },
  {
    key: PROMOTION_KEYS.MEMBERSHIP_1,
    title: 'Membresia premium 1',
    summary: '5 garrafones al mes por $95',
    description: 'Plan mensual de un solo pago: 5 garrafones al mes por $95. Costo por garrafon: $19.',
    kind: 'membership',
    sortOrder: 5,
    isActive: true,
    config: {
      garrafones: 5,
      monthlyPriceCents: 9500,
      costPerGarrafonCents: 1900,
    },
  },
  {
    key: PROMOTION_KEYS.MEMBERSHIP_2,
    title: 'Membresia premium 2',
    summary: '8 garrafones al mes por $148',
    description: 'Plan mensual de un solo pago: 8 garrafones al mes por $148. Costo por garrafon: $18.50.',
    kind: 'membership',
    sortOrder: 6,
    isActive: true,
    config: {
      garrafones: 8,
      monthlyPriceCents: 14800,
      costPerGarrafonCents: 1850,
    },
  },
  {
    key: PROMOTION_KEYS.MEMBERSHIP_3,
    title: 'Membresia premium 3',
    summary: '11 garrafones al mes por $198',
    description: 'Plan mensual de un solo pago: 11 garrafones al mes por $198. Costo por garrafon: $18.',
    kind: 'membership',
    sortOrder: 7,
    isActive: true,
    config: {
      garrafones: 11,
      monthlyPriceCents: 19800,
      costPerGarrafonCents: 1800,
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
  const activeKeys = DEFAULT_PROMOTIONS.map((promotion) => promotion.key);

  for (const promotion of DEFAULT_PROMOTIONS) {
    await client.appPromotion.upsert({
      where: { key: promotion.key },
      update: {
        title: promotion.title,
        summary: promotion.summary,
        description: promotion.description,
        kind: promotion.kind,
        sortOrder: promotion.sortOrder,
        isActive: promotion.isActive,
        config: promotion.config,
      },
      create: promotion,
    });
  }

  await client.appPromotion.updateMany({
    where: {
      key: { notIn: activeKeys },
    },
    data: { isActive: false },
  });
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

function isMonthlySelectablePromotion(promotion) {
  return MONTHLY_SELECTABLE_PROMOTION_KEYS.includes(promotion?.key);
}

function getMonthlySelectablePromotions(promotions) {
  return (promotions || []).filter((promotion) => promotion.isActive && isMonthlySelectablePromotion(promotion));
}

function isMissingSelectionTableError(error) {
  return error?.code === 'P2021' || /UserPromotionSelection/i.test(String(error?.message || ''));
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

function getMembershipBonusCents(amountCents, promotion, pricePerGarrafonCents = PRICE_PER_GARRAFON_CENTS) {
  if (!promotion?.isActive || promotion?.kind !== 'membership') return 0;

  const monthlyPriceCents = Number(promotion.config?.monthlyPriceCents || 0);
  const garrafones = Number(promotion.config?.garrafones || 0);
  const publicPriceCents = Math.max(0, Number(pricePerGarrafonCents || PRICE_PER_GARRAFON_CENTS));
  if (!monthlyPriceCents || !garrafones || Number(amountCents) !== monthlyPriceCents) {
    return 0;
  }

  const planValueCents = Math.round(garrafones * publicPriceCents);
  return Math.max(0, planValueCents - monthlyPriceCents);
}

function getRechargeBonusOffer(amountCents, selectedPromotionKeys = [], promotions = [], options = {}) {
  const pricePerGarrafonCents = Number(options.pricePerGarrafonCents || PRICE_PER_GARRAFON_CENTS);
  const selected = new Set(selectedPromotionKeys || []);
  const selectedMembership = (promotions || [])
    .filter((promotion) => promotion?.isActive && promotion.kind === 'membership' && selected.has(promotion.key))
    .map((promotion) => ({
      promotion,
      bonusCents: getMembershipBonusCents(amountCents, promotion, pricePerGarrafonCents),
    }))
    .filter((item) => item.bonusCents > 0)
    .sort((a, b) => b.bonusCents - a.bonusCents)[0];

  if (selectedMembership) {
    return {
      promotionKey: selectedMembership.promotion.key,
      bonusCents: selectedMembership.bonusCents,
      description: selectedMembership.promotion.title,
      metadata: {
        rule: 'membership',
        garrafones: Number(selectedMembership.promotion.config?.garrafones || 0),
        monthlyPriceCents: Number(selectedMembership.promotion.config?.monthlyPriceCents || 0),
        pricePerGarrafonCents,
        planValueCents: Number(selectedMembership.promotion.config?.garrafones || 0) * pricePerGarrafonCents,
      },
    };
  }

  const topupPromotion = getPromotionByKey(promotions, PROMOTION_KEYS.TOPUP);
  const topupBonusCents = selected.has(PROMOTION_KEYS.TOPUP)
    ? getTopUpBonusCents(amountCents, topupPromotion)
    : 0;

  if (topupBonusCents > 0) {
    return {
      promotionKey: PROMOTION_KEYS.TOPUP,
      bonusCents: topupBonusCents,
      description: 'Recompensa por deposito',
      metadata: {
        rule: 'topup',
      },
    };
  }

  return {
    promotionKey: null,
    bonusCents: 0,
    description: null,
    metadata: {},
  };
}

function inferRechargeBonusOffer(amountCents, bonusCents, promotions = [], options = {}) {
  const pricePerGarrafonCents = Number(options.pricePerGarrafonCents || PRICE_PER_GARRAFON_CENTS);
  const amount = Number(amountCents || 0);
  const bonus = Number(bonusCents || 0);
  if (bonus <= 0) {
    return {
      promotionKey: null,
      bonusCents: 0,
      description: null,
      metadata: {},
    };
  }

  const membership = (promotions || [])
    .filter((promotion) => promotion?.isActive && promotion.kind === 'membership')
    .find((promotion) => getMembershipBonusCents(amount, promotion, pricePerGarrafonCents) === bonus);

  if (membership) {
    return {
      promotionKey: membership.key,
      bonusCents: bonus,
      description: membership.title,
      metadata: {
        rule: 'membership',
        garrafones: Number(membership.config?.garrafones || 0),
        monthlyPriceCents: Number(membership.config?.monthlyPriceCents || 0),
        pricePerGarrafonCents,
        planValueCents: Number(membership.config?.garrafones || 0) * pricePerGarrafonCents,
      },
    };
  }

  return {
    promotionKey: PROMOTION_KEYS.TOPUP,
    bonusCents: bonus,
    description: 'Recompensa por deposito',
    metadata: {
      rule: 'topup',
    },
  };
}

async function getUserPromotionSelections(client, userId, selectionMonthKey) {
  try {
    return await client.userPromotionSelection.findMany({
      where: {
        userId,
        monthKey: selectionMonthKey,
      },
      orderBy: { createdAt: 'asc' },
    });
  } catch (error) {
    if (isMissingSelectionTableError(error)) {
      return [];
    }
    throw error;
  }
}

async function getUserSelectedPromotionKeys(client, userId, selectionMonthKey) {
  const rows = await getUserPromotionSelections(client, userId, selectionMonthKey);
  return rows.map((row) => row.promotionKey);
}

async function saveUserPromotionSelections(client, userId, promotionKeys, now = new Date(), promotions = null) {
  const resolvedPromotions = await resolvePromotions(client, promotions);
  const selectionMonthKey = monthKey(startOfMonth(now));
  const selectablePromotions = getMonthlySelectablePromotions(resolvedPromotions);
  const selectableKeys = new Set(selectablePromotions.map((promotion) => promotion.key));
  const maxCount = Math.min(2, selectablePromotions.length);
  const uniqueKeys = [...new Set((promotionKeys || []).filter(Boolean))];

  if (uniqueKeys.length < 1 || uniqueKeys.length > maxCount) {
    throw new Error(maxCount > 0
      ? `Elige de 1 a ${maxCount} promociones`
      : 'No hay promociones para elegir');
  }

  const invalidKey = uniqueKeys.find((key) => !selectableKeys.has(key));
  if (invalidKey) {
    throw new Error('Una de las promociones elegidas no esta disponible este mes');
  }

  try {
    await client.$transaction(async (tx) => {
      await tx.userPromotionSelection.deleteMany({
        where: {
          userId,
          monthKey: selectionMonthKey,
        },
      });

      if (uniqueKeys.length > 0) {
        await tx.userPromotionSelection.createMany({
          data: uniqueKeys.map((promotionKey) => ({
            userId,
            monthKey: selectionMonthKey,
            promotionKey,
          })),
        });
      }
    });
  } catch (error) {
    if (isMissingSelectionTableError(error)) {
      throw new Error('La base de datos aun no tiene habilitada la seleccion mensual de promociones');
    }
    throw error;
  }

  return {
    month: selectionMonthKey,
    promotionKeys: uniqueKeys,
    requiredCount: maxCount,
  };
}

async function getUserPromotionSelectionState(client, userId, now = new Date(), promotions = null) {
  const resolvedPromotions = await resolvePromotions(client, promotions);
  const selectionMonthKey = monthKey(startOfMonth(now));
  const selectablePromotions = getMonthlySelectablePromotions(resolvedPromotions);
  const requiredCount = Math.min(2, selectablePromotions.length);
  const selectableKeys = new Set(selectablePromotions.map((promotion) => promotion.key));
  const selectedPromotionKeys = (await getUserSelectedPromotionKeys(client, userId, selectionMonthKey))
    .filter((key) => selectableKeys.has(key));

  return {
    month: selectionMonthKey,
    requiredCount,
    selectedPromotionKeys,
    complete: requiredCount === 0 ? true : selectedPromotionKeys.length > 0 && selectedPromotionKeys.length <= requiredCount,
    selectablePromotions,
  };
}

function getCashbackTier(garrafones, promotion) {
  const tiers = Array.isArray(promotion?.config?.tiers) ? promotion.config.tiers : [];
  return tiers.find((item) => item.maxGarrafones == null || garrafones <= Number(item.maxGarrafones)) || null;
}

function getPointsTier(points, promotion) {
  const tiers = Array.isArray(promotion?.config?.tiers) ? promotion.config.tiers : [];
  const resetAtPoints = Number(promotion?.config?.resetAtPoints || 0);
  const effectivePoints = resetAtPoints > 0 && points > resetAtPoints
    ? points % resetAtPoints
    : points;
  const comparablePoints = points > 0 && resetAtPoints > 0 && effectivePoints === 0
    ? resetAtPoints
    : effectivePoints;

  return tiers
    .filter((item) => comparablePoints >= Number(item.minPoints || 0))
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
  const selectedPromotionKeys = new Set(await getUserSelectedPromotionKeys(client, userId, key));
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
  if (cashbackPromotion?.isActive && selectedPromotionKeys.has(PROMOTION_KEYS.CASHBACK)) {
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
    const pointsPerLiter = Math.max(0, Number(pointsPromotion.config?.pointsPerLiter) || DEFAULT_POINTS_PER_LITER);
    const points = Math.round(stats.liters * pointsPerLiter);
    const pointsTier = getPointsTier(points, pointsPromotion);
    const bonusCents = Math.round(Number(pointsTier?.bonusCents) || 0);

    const outcome = await client.$transaction(async (tx) => applyRewardCreditTx(tx, {
      userId,
      promotionKey: pointsPromotion.key,
      externalId: `reward:points:${userId}:${key}`,
      amountCents: bonusCents,
      description: `Saldo extra por consumo mensual ${key}`,
      metadata: {
        month: key,
        points,
        bonusCents,
        liters: stats.liters,
        totalSpentCents: stats.totalCents,
      },
    }));
    results.push({
      promotionKey: pointsPromotion.key,
      amountCents: bonusCents,
      points,
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
  const currentMonthKey = monthKey(fromDate);
  const selectedPromotionKeys = new Set(await getUserSelectedPromotionKeys(client, userId, currentMonthKey));
  const stats = await getMonthlyCompletedDispenseStats(client, userId, fromDate, toDate);
  const cashbackPromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.CASHBACK);
  const pointsPromotion = getPromotionByKey(resolvedPromotions, PROMOTION_KEYS.POINTS);

  const cashbackTier = cashbackPromotion?.isActive && selectedPromotionKeys.has(PROMOTION_KEYS.CASHBACK)
    ? getCashbackTier(stats.garrafones, cashbackPromotion)
    : null;
  const cashbackPerGarrafonCents = Number(cashbackTier?.cashbackPerGarrafonCents) || 0;
  const estimatedCashbackCents = Math.round(stats.garrafones * cashbackPerGarrafonCents);

  const pointsPerLiter = Math.max(0, Number(pointsPromotion?.config?.pointsPerLiter) || DEFAULT_POINTS_PER_LITER);
  const points = Math.round(stats.liters * pointsPerLiter);
  const pointsTier = pointsPromotion?.isActive
    ? getPointsTier(points, pointsPromotion)
    : null;
  const estimatedPointsBonusCents = Math.round(Number(pointsTier?.bonusCents) || 0);

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
    pointsBonusCents: estimatedPointsBonusCents,
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
  MONTHLY_SELECTABLE_PROMOTION_KEYS,
  ensurePromotionCatalog,
  getPromotionCatalog,
  getPromotionByKey,
  isMonthlySelectablePromotion,
  getMonthlySelectablePromotions,
  getTopUpBonusCents,
  getMembershipBonusCents,
  getRechargeBonusOffer,
  inferRechargeBonusOffer,
  getCashbackTier,
  getPointsTier,
  applyRewardCreditTx,
  ensureWelcomeReward,
  settleMonthlyRewards,
  getCurrentMonthRewardPreview,
  getUserRewardTotals,
  getRewardCredits,
  getUserPromotionSelections,
  getUserSelectedPromotionKeys,
  saveUserPromotionSelections,
  getUserPromotionSelectionState,
  monthKey,
  startOfMonth,
};
