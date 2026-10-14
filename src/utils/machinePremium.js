const { clipRequest, verifiedClipStatus } = require('./clip');
const { verifiedTransparentStatus, transparentProof, paymentAction, transparentConfig } = require('./clipTransparent');

const PREMIUM_PLANS = [
  { key: 'basic', label: 'Básico', maxGarrafones: 100, monthlyPriceCents: 27100, sortOrder: 1 },
  { key: 'basic_plus', label: 'Básico+', maxGarrafones: 150, monthlyPriceCents: 33000, sortOrder: 2 },
  { key: 'intermediate', label: 'Intermedio', maxGarrafones: 250, monthlyPriceCents: 44900, sortOrder: 3 },
  { key: 'intermediate_plus', label: 'Intermedio+', maxGarrafones: 350, monthlyPriceCents: 56900, sortOrder: 4 },
  { key: 'advanced', label: 'Avanzado', maxGarrafones: 500, monthlyPriceCents: 74800, sortOrder: 5 },
  { key: 'advanced_plus', label: 'Avanzado+', maxGarrafones: 600, monthlyPriceCents: 86700, sortOrder: 6 },
  { key: 'premium', label: 'Premium', maxGarrafones: null, monthlyPriceCents: 98600, sortOrder: 7 },
];

function previousMexicoMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year').value), month = Number(parts.find((p) => p.type === 'month').value);
  return { from: new Date(Date.UTC(year, month - 2, 1, 6)), to: new Date(Date.UTC(year, month - 1, 1, 6)) };
}

function premiumSegment(garrafones, plans = PREMIUM_PLANS) {
  if (!Number.isFinite(garrafones) || garrafones < 0) throw new Error('Volumen de máquina inválido');
  const plan = [...plans].sort((a, b) => a.sortOrder - b.sortOrder).find((tier) => tier.maxGarrafones === null || garrafones <= tier.maxGarrafones);
  if (!plan || !Number.isSafeInteger(plan.monthlyPriceCents) || plan.monthlyPriceCents <= 0) throw new Error('Plan Premium no configurado');
  return plan;
}

async function premiumQuote(client, machineId, now = new Date()) {
  const period = previousMexicoMonth(now);
  const [volume, plans] = await Promise.all([
    client.dispense.aggregate({ where: { machineId, status: 'COMPLETED', createdAt: { gte: period.from, lt: period.to } }, _sum: { liters: true } }),
    client.machinePremiumPlan.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);
  const garrafones = Number(volume._sum.liters || 0) / 20;
  const plan = premiumSegment(garrafones, plans);
  return { machineId, amountCents: plan.monthlyPriceCents, segment: plan.label, planKey: plan.key,
    volumeGarrafones: garrafones, volumeFrom: period.from, volumeTo: period.to, plans };
}

async function activeMachinePremium(client, machineId, now = new Date()) {
  const environment = process.env.CLIP_API_KEY ? transparentConfig().environment : 'production';
  return client.machinePremiumPayment.findFirst({ where: { machineId, status: 'SUCCEEDED', endsAt: { gt: now },
    ...(process.env.CLIP_API_KEY ? { OR: [{ clipEnvironment: null }, { clipEnvironment: environment }] } : {}) }, orderBy: { endsAt: 'desc' } });
}

async function machinePremiumOverview(client, machineIds, now = new Date()) {
  if (!machineIds.length) return new Map();
  const environment = process.env.CLIP_API_KEY ? transparentConfig().environment : null;
  const payments = await client.machinePremiumPayment.findMany({
    where: { machineId: { in: machineIds }, status: 'SUCCEEDED', endsAt: { gt: now },
      ...(environment ? { OR: [{ clipEnvironment: null }, { clipEnvironment: environment }] } : {}) },
    select: { machineId: true, endsAt: true }, orderBy: { endsAt: 'desc' },
  });
  const overview = new Map();
  for (const payment of payments) {
    if (!overview.has(payment.machineId)) overview.set(payment.machineId, { active: true, endsAt: payment.endsAt });
  }
  return overview;
}

function addCalendarMonth(date) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

async function settleMachinePremium(client, payment, verified, now = new Date()) {
  const status = payment.clipFlow === 'TRANSPARENT' ? verifiedTransparentStatus(payment, verified) : verifiedClipStatus(payment, verified);
  if (status === 'PENDING') return { status, pendingAction: payment.clipFlow === 'TRANSPARENT' ? paymentAction(verified) : null };
  return client.$transaction(async (tx) => {
    const claimed = await tx.machinePremiumPayment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status } });
    if (!claimed.count) return tx.machinePremiumPayment.findUnique({ where: { id: payment.id }, select: { status: true, endsAt: true } });
    if (status !== 'SUCCEEDED') return { status };
    // Serialize renewals of the same machine so two distinct paid invoices extend, rather than overlap.
    await tx.$queryRaw`SELECT "id" FROM public."Machine" WHERE "id" = ${payment.machineId} FOR UPDATE`;
    const current = await activeMachinePremium(tx, payment.machineId, now);
    const startsAt = current?.endsAt || now;
    const endsAt = addCalendarMonth(startsAt);
    await tx.machinePremiumPayment.update({ where: { id: payment.id }, data: { startsAt, endsAt } });
    return { status, endsAt };
  });
}

async function reconcileMachinePremium(client, payment) {
  if (payment.status !== 'PENDING' || !payment.providerPaymentId) return { status: payment.status, endsAt: payment.endsAt };
  return settleMachinePremium(client, payment, payment.clipFlow === 'TRANSPARENT'
    ? await transparentProof(payment) : await clipRequest('GET', payment.providerPaymentId));
}

module.exports = { PREMIUM_PLANS, previousMexicoMonth, premiumSegment, premiumQuote, activeMachinePremium, machinePremiumOverview,
  addCalendarMonth, settleMachinePremium, reconcileMachinePremium };
