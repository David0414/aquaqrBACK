const { clipRequest, verifiedClipStatus } = require('./clip');
const { applyRewardCreditTx } = require('./rewards');

async function settleClipRecharge(client, payment, verified) {
  const status = verifiedClipStatus(payment, verified);
  if (status === 'PENDING') return { status };
  return client.$transaction(async (tx) => {
    const claimed = await tx.recharge.updateMany({ where: { id: payment.id, provider: 'CLIP', status: 'PENDING' }, data: { status } });
    if (!claimed.count) return { status: (await tx.recharge.findUnique({ where: { id: payment.id } }))?.status || status };
    if (status !== 'SUCCEEDED') return { status };
    await tx.wallet.upsert({ where: { userId: payment.userId }, update: { balanceCents: { increment: payment.amountCents } },
      create: { userId: payment.userId, balanceCents: payment.amountCents, bonusBalanceCents: 0 } });
    await tx.ledgerEntry.create({ data: { userId: payment.userId, type: 'CREDIT', amountCents: payment.amountCents,
      currency: 'MXN', description: 'Recarga por Clip', source: 'clip', externalId: `clip:${payment.providerPaymentId}`, status: 'POSTED' } });
    if (payment.bonusCents > 0) await applyRewardCreditTx(tx, { userId: payment.userId,
      promotionKey: payment.bonusPromotionKey || 'topup_bonus', amountCents: payment.bonusCents,
      externalId: `reward:clip:${payment.providerPaymentId}`, description: 'Bono por recarga con Clip',
      metadata: { ...(payment.bonusMetadata || {}), rechargeId: payment.id, amountCents: payment.amountCents } });
    return { status, wallet: await tx.wallet.findUnique({ where: { userId: payment.userId } }) };
  });
}

async function reconcileClipRecharge(client, payment) {
  if (payment.status !== 'PENDING' || !payment.providerPaymentId) return { status: payment.status };
  return settleClipRecharge(client, payment, await clipRequest('GET', payment.providerPaymentId));
}
module.exports = { settleClipRecharge, reconcileClipRecharge };
