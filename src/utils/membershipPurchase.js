const { randomUUID } = require('crypto');
const { membershipQuote, membershipMachine, activeMembershipWhere } = require('./memberships');
const { monthKey, startOfMonth } = require('./rewards');

const fail = (message, statusCode, code, extra = {}) => Object.assign(new Error(message), { statusCode, code, ...extra });

async function purchaseMembership(client, userId, promotion, request = {}) {
  if (request.purchaseId && !/^[a-zA-Z0-9_-]{16,100}$/.test(request.purchaseId)) throw fail('Identificador de compra inválido', 400);
  const purchaseKey = `${userId}:${request.purchaseId || randomUUID()}`;
  const runPurchase = () => client.$transaction(async (tx) => {
    const existingPurchase = await tx.userMembership.findUnique({ where: { purchaseKey } });
    if (existingPurchase) {
      if (existingPurchase.promotionKey !== promotion.key || existingPurchase.machineId !== String(request.machineId || '').trim().toUpperCase()) {
        throw fail('Esta solicitud ya corresponde a otra compra', 409);
      }
      return { membership: existingPurchase, wallet: await tx.wallet.findUnique({ where: { userId } }), replay: true };
    }
    const machine = await membershipMachine(request.machineId, request.hardwareId, tx);
    const quote = membershipQuote(promotion, machine.pricePerGarrafonCents);
    if (request.expectedPriceCents !== undefined && Number(request.expectedPriceCents) !== quote.purchasePriceCents) {
      throw fail('El precio de la máquina cambió. Revisa el importe antes de pagar.', 409, 'PRICE_CHANGED', { quote });
    }
    const active = await tx.userMembership.findFirst({ where: activeMembershipWhere(userId) });
    if (active) throw fail('Todavía tienes litros de una membresía. Al agotarlos podrás comprar otra.', 409, 'MEMBERSHIP_ALREADY_ACTIVE');
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    const total = Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0);
    if (total < quote.purchasePriceCents) throw fail('No tienes saldo suficiente para pagar esta membresía', 400, 'INSUFFICIENT_FUNDS',
      { balanceCents: total, neededCents: quote.purchasePriceCents - total, quote });
    const bonus = Math.min(Number(wallet.bonusBalanceCents || 0), quote.purchasePriceCents);
    const real = quote.purchasePriceCents - bonus;
    const updated = await tx.wallet.updateMany({ where: { userId, balanceCents: { gte: real }, bonusBalanceCents: { gte: bonus } },
      data: { balanceCents: { decrement: real }, bonusBalanceCents: { decrement: bonus } } });
    if (updated.count !== 1) throw fail('Tu saldo cambió. Revisa la compra e intenta nuevamente.', 409, 'BALANCE_CHANGED');
    const startsAt = new Date();
    const membership = await tx.userMembership.create({ data: {
      userId, promotionKey: promotion.key, machineId: machine.id, purchaseKey,
      garrafonesTotal: quote.garrafones, garrafonesRemaining: quote.garrafones,
      litersTotal: quote.litersTotal, litersRemaining: quote.litersTotal,
      pricePaidCents: quote.purchasePriceCents, pricePerGarrafonCents: machine.pricePerGarrafonCents,
      startsAt, expiresAt: null, status: 'ACTIVE',
      metadata: { rule: 'membership-wallet-purchase', validity: 'UNTIL_USED', quote, machineId: machine.id, hardwareId: machine.hardwareId },
    } });
    await tx.ledgerEntry.create({ data: { userId, type: 'DEBIT', amountCents: quote.purchasePriceCents, currency: 'MXN',
      description: `Compra de membresía: ${quote.garrafones} garrafones en ${machine.id}`,
      source: `MEMBERSHIP:${promotion.key}`, externalId: `MEMBERSHIP:${membership.id}`, status: 'POSTED' } });
    await tx.userPromotionSelection.deleteMany({ where: { userId, OR: [{ monthKey: monthKey(startOfMonth(startsAt)) }, { expiresAt: null }, { expiresAt: { gt: startsAt } }] } });
    await tx.userPromotionSelection.createMany({ data: [{ userId, monthKey: monthKey(startOfMonth(startsAt)), promotionKey: promotion.key, expiresAt: null }] });
    return { membership, wallet: await tx.wallet.findUnique({ where: { userId } }), replay: false };
  }, { isolationLevel: 'Serializable' });
  for (let attempt = 0; ; attempt += 1) {
    try { return await runPurchase(); }
    catch (error) {
      if (attempt >= 2 || !['P2034', 'P2002'].includes(error.code)) throw error;
    }
  }
}

module.exports = { purchaseMembership };
