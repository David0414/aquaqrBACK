function membershipHistoryItem(membership) {
  return { id: `MEMBERSHIP:${membership.id}`, type: 'membership',
    description: `Compra de membresía: ${membership.garrafonesTotal} garrafones (${membership.litersTotal} litros)`,
    amount: Number(membership.pricePaidCents || 0) / 100, currency: 'MXN', date: membership.startsAt,
    status: 'completed', machineId: membership.machineId || undefined,
    liters: membership.litersTotal, litersRemaining: membership.litersRemaining };
}

module.exports = { membershipHistoryItem };
