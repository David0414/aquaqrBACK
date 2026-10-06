const { prisma } = require('../db');
const { normalizeMachineId, normalizeHardwareId } = require('./managementAccess');

const accessError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function membershipQuote(promotion, pricePerGarrafonCents) {
  const config = promotion?.config || {};
  const garrafones = Number(config.garrafones || 0);
  const publicPrice = Number(pricePerGarrafonCents);
  const referencePrice = Number(config.referencePricePerGarrafonCents || 3500);
  const referenceUnit = Number(config.costPerGarrafonCents || Number(config.monthlyPriceCents) / garrafones);
  if (!Number.isInteger(garrafones) || garrafones <= 0 || !Number.isSafeInteger(publicPrice) || publicPrice <= 0
    || !Number.isFinite(referenceUnit) || referenceUnit <= 0 || referenceUnit >= referencePrice) {
    throw accessError('Configuración de membresía inválida');
  }
  const costPerGarrafonCents = Math.max(1, Math.round(publicPrice * referenceUnit / referencePrice));
  const purchasePriceCents = costPerGarrafonCents * garrafones;
  const standardPriceCents = publicPrice * garrafones;
  return { garrafones, litersTotal: garrafones * 20, costPerGarrafonCents, purchasePriceCents,
    monthlyPriceCents: purchasePriceCents, pricePerGarrafonCents: publicPrice, standardPriceCents,
    savingsCents: standardPriceCents - purchasePriceCents, durationDays: null, validity: 'UNTIL_USED' };
}

async function membershipMachine(machineIdValue, hardwareIdValue, client = prisma) {
  const id = normalizeMachineId(machineIdValue);
  const hardwareId = normalizeHardwareId(hardwareIdValue);
  const machine = id ? await client.machine.findUnique({ where: { id } })
    : hardwareId ? await client.machine.findFirst({ where: { hardwareId, isActive: true } }) : null;
  if (!machine || !machine.isActive) throw accessError('Escanea el QR de una máquina activa para ver sus membresías');
  if (hardwareId && normalizeHardwareId(machine.hardwareId) !== hardwareId) throw accessError('El QR no corresponde al hardware de esta máquina');
  return machine;
}

function activeMembershipWhere(userId, machineId, now = new Date(), purchasedBefore) {
  return { userId, status: 'ACTIVE', litersRemaining: { gt: 0 },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    ...(machineId ? { AND: [{ OR: [{ machineId }, { machineId: null }] }] } : {}),
    ...(purchasedBefore ? { startsAt: { lte: purchasedBefore } } : {}) };
}

async function membershipCoverage(client, userId, liters, machineId, { consume = false, purchasedBefore } = {}) {
  const memberships = await client.userMembership.findMany({
    where: { ...activeMembershipWhere(userId, machineId, new Date(), purchasedBefore), ...(!machineId ? { machineId: null } : {}) }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  let remainingLiters = Math.max(0, Number(liters || 0));
  let coveredLiters = 0;
  for (const membership of memberships) {
    if (remainingLiters <= 0) break;
    const available = Math.max(0, Number(membership.litersRemaining));
    const usedLiters = Math.min(remainingLiters, available);
    if (consume) {
      const left = Math.max(0, available - usedLiters);
      const updated = await client.userMembership.updateMany({ where: { id: membership.id, status: 'ACTIVE', litersRemaining: available },
        data: { litersRemaining: left, garrafonesRemaining: left / 20, status: left <= 0.001 ? 'USED' : 'ACTIVE' } });
      if (updated.count !== 1) throw accessError('La membresía cambió al mismo tiempo. Intenta nuevamente.', 409);
    }
    coveredLiters += usedLiters;
    remainingLiters -= usedLiters;
  }
  return { coveredLiters, remainingLiters, hasCoverage: coveredLiters > 0 };
}

module.exports = { membershipQuote, membershipMachine, activeMembershipWhere, membershipCoverage };
