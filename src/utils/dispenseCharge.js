const { membershipCoverage } = require('./memberships');

// Called inside the completion transaction. Even a fully covered dispense gets
// a ledger marker so retrying completion cannot consume the membership twice.
async function chargeDispenseTx(tx, record, debitWalletBalanceTx) {
  const existing = await tx.dispense.findUnique({ where: { id: record.id } });
  const externalId = `DISPENSE:${existing.id}`;
  const posted = await tx.ledgerEntry.findMany({ where: { userId: existing.userId, type: 'DEBIT', status: 'POSTED',
    OR: [{ externalId }, { source: externalId }] } });
  const chargedAlready = posted.reduce((sum, row) => sum + Number(row.amountCents || 0), 0);
  let coveredLiters = Number(existing.membershipCoveredLiters || 0);
  let coveredCents = Number(existing.membershipCoveredCents || 0);
  const remainingCost = Math.max(0, existing.totalCents - coveredCents - chargedAlready);
  let wallet, debit = { realDebitedCents: 0, bonusDebitedCents: 0 }, ledger = posted[0];
  const alreadyCharged = posted.length > 0 && remainingCost === 0;
  let amountToCharge = 0;
  if (!alreadyCharged) {
    const litersToCover = Math.min(existing.liters - coveredLiters, remainingCost / existing.pricePerLiterCents);
    const coverage = await membershipCoverage(tx, existing.userId, litersToCover, existing.machineId,
      { consume: true, purchasedBefore: existing.createdAt });
    const additionalCoverage = Math.min(remainingCost, Math.round(coverage.coveredLiters * existing.pricePerLiterCents));
    coveredLiters += coverage.coveredLiters;
    coveredCents += additionalCoverage;
    amountToCharge = remainingCost - additionalCoverage;
    if (amountToCharge > 0) {
      debit = await debitWalletBalanceTx(tx, existing.userId, amountToCharge);
      wallet = debit.updatedWallet;
    } else wallet = await tx.wallet.findUnique({ where: { userId: existing.userId } });
    ledger = await tx.ledgerEntry.create({ data: { userId: existing.userId, type: 'DEBIT', amountCents: amountToCharge,
      currency: existing.currency, description: `Dispensado de agua - ${existing.liters}L${coveredLiters ? ` (${coveredLiters}L de membresía)` : ''}`,
      source: externalId, externalId: posted.length ? `DISPENSE_ADJUST:${existing.id}:${Date.now()}` : externalId, status: 'POSTED' } });
    await tx.dispense.update({ where: { id: existing.id }, data: { membershipCoveredLiters: coveredLiters, membershipCoveredCents: coveredCents } });
  } else wallet = await tx.wallet.findUnique({ where: { userId: existing.userId } });
  return { alreadyCharged, updatedWallet: wallet,
    newBalanceCents: Number(wallet?.balanceCents || 0) + Number(wallet?.bonusBalanceCents || 0),
    newRealBalanceCents: Number(wallet?.balanceCents || 0), newBonusBalanceCents: Number(wallet?.bonusBalanceCents || 0),
    realDebitedCents: debit.realDebitedCents, bonusDebitedCents: debit.bonusDebitedCents,
    membershipCoveredLiters: coveredLiters, membershipCoveredCents: coveredCents,
    chargedCents: chargedAlready + amountToCharge, ledgerId: ledger?.id };
}

module.exports = { chargeDispenseTx };
