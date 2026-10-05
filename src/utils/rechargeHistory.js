// Coin credits already live in the ledger; include them without crediting the wallet again.
async function getRechargeHistoryItems(client, userId, { limit, cursor = null }) {
  const coinWhere = { userId, type: 'CREDIT', status: 'POSTED', source: 'telemetry-coin' };
  let before = {};
  if (cursor) {
    const [recharge, coin] = await Promise.all([
      client.recharge.findFirst({ where: { userId, id: cursor } }),
      client.ledgerEntry.findFirst({ where: { ...coinWhere, id: cursor } }),
    ]);
    const anchor = recharge || coin;
    if (!anchor) return [];
    before = { OR: [
      { createdAt: { lt: anchor.createdAt } },
      { createdAt: anchor.createdAt, id: { lt: anchor.id } },
    ] };
  }

  const [recharges, coins] = await Promise.all([
    client.recharge.findMany({
      where: { userId, ...before },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    }),
    client.ledgerEntry.findMany({
      where: { ...coinWhere, ...before },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    }),
  ]);

  const pendingIds = recharges.filter((r) => r.status === 'PENDING' && r.providerPaymentId)
    .map((r) => r.providerPaymentId);
  const postedCredits = pendingIds.length ? await client.ledgerEntry.findMany({
    where: { userId, type: 'CREDIT', status: 'POSTED', externalId: { in: pendingIds } },
    select: { externalId: true },
  }) : [];
  const postedIds = new Set(postedCredits.map((entry) => entry.externalId));
  const statuses = { SUCCEEDED: 'completed', FAILED: 'failed', PENDING: 'pending', CANCELED: 'cancelled' };

  return [
    ...recharges.map((r) => ({
      id: r.id,
      type: 'recharge',
      description: r.bonusCents > 0 ? 'Recarga de saldo con bonificacion' : 'Recarga de saldo',
      amount: (r.amountCents || 0) / 100,
      bonusAmount: (r.bonusCents || 0) / 100,
      totalReceivedAmount: ((r.amountCents || 0) + (r.bonusCents || 0)) / 100,
      currency: (r.currency || 'MXN').toUpperCase(),
      date: r.createdAt,
      status: postedIds.has(r.providerPaymentId) ? 'completed' : (statuses[r.status] || 'completed'),
      paymentMethod: r.provider === 'STRIPE' ? 'Stripe' : r.provider,
      providerPaymentId: r.providerPaymentId || undefined,
    })),
    ...coins.map((entry) => ({
      id: entry.id,
      type: 'recharge',
      description: 'Recarga de saldo con monedas',
      amount: entry.amountCents / 100,
      bonusAmount: 0,
      totalReceivedAmount: entry.amountCents / 100,
      currency: (entry.currency || 'MXN').toUpperCase(),
      date: entry.createdAt,
      status: 'completed',
      paymentMethod: 'Monedas',
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, limit);
}

module.exports = { getRechargeHistoryItems };
