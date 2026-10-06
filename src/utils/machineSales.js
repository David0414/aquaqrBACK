async function machineSales(client, machineIds, since) {
  const scope = { machineId: { in: machineIds } };
  const [dispenses, memberships] = await Promise.all([
    client.dispense.aggregate({ where: { ...scope, status: 'COMPLETED', createdAt: { gte: since } },
      _sum: { liters: true, totalCents: true, membershipCoveredCents: true }, _count: { _all: true } }),
    client.userMembership.aggregate({ where: { ...scope, startsAt: { gte: since }, pricePaidCents: { gt: 0 } },
      _sum: { pricePaidCents: true }, _count: { _all: true } }),
  ]);
  const waterRevenue = Math.max(0, Number(dispenses._sum.totalCents || 0) - Number(dispenses._sum.membershipCoveredCents || 0));
  return { periodDays: 30, transactions: dispenses._count._all, liters: dispenses._sum.liters || 0,
    membershipPurchases: memberships._count._all,
    revenueCents: waterRevenue + Number(memberships._sum.pricePaidCents || 0) };
}

module.exports = { machineSales };
