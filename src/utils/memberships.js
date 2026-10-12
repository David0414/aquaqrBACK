const { prisma } = require('../db');
const { normalizeMachineId, normalizeHardwareId } = require('./managementAccess');

const accessError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function membershipQuote(promotion, pricePerGarrafonCents) {
  const config = promotion?.config || {};
  const garrafones = Number(config.garrafones || 0);
  const publicPrice = Number(pricePerGarrafonCents);
  const referencePrice = Number(config.referencePricePerGarrafonCents || 3500);
  const referenceUnit = Number(config.costPerGarrafonCents || Number(config.monthlyPriceCents) / garrafones);
  const discount = config.discountPerGarrafonCents;
  if (!Number.isInteger(garrafones) || garrafones <= 0 || !Number.isSafeInteger(publicPrice) || publicPrice <= 0
    || (discount === undefined ? !Number.isFinite(referenceUnit) || referenceUnit <= 0 || referenceUnit >= referencePrice
      : !Number.isSafeInteger(discount) || discount <= 0 || discount >= publicPrice)) {
    throw accessError('Configuración de membresía inválida');
  }
  const costPerGarrafonCents = discount === undefined ? Math.max(1, Math.round(publicPrice * referenceUnit / referencePrice)) : publicPrice - discount;
  const purchasePriceCents = costPerGarrafonCents * garrafones;
  const standardPriceCents = publicPrice * garrafones;
  return { garrafones, litersTotal: garrafones * 20, costPerGarrafonCents, purchasePriceCents,
    monthlyPriceCents: purchasePriceCents, pricePerGarrafonCents: publicPrice, standardPriceCents,
    savingsCents: standardPriceCents - purchasePriceCents, durationDays: null, validity: 'UNTIL_USED' };
}

async function membershipMachine(machineIdValue, hardwareIdValue, client = prisma) {
  const id = normalizeMachineId(machineIdValue);
  const hardwareId = normalizeHardwareId(hardwareIdValue);
  if ((machineIdValue && !id) || (hardwareIdValue && !hardwareId)) throw accessError('Selecciona una máquina válida para esta membresía.');
  const machine = id ? await client.machine.findUnique({ where: { id } })
    : hardwareId ? await client.machine.findFirst({ where: { hardwareId, isActive: true } })
      : await client.machine.findFirst({ where: { isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  if (!machine || !machine.isActive) throw accessError(id || hardwareId
    ? 'La máquina seleccionada no está disponible para comprar una membresía.'
    : 'No hay máquinas activas para comprar una membresía.');
  if (hardwareId && normalizeHardwareId(machine.hardwareId) !== hardwareId) throw accessError('El QR no corresponde al hardware de esta máquina');
  return machine;
}

async function membershipContext(client, userId, machineId, hardwareId) {
  const machines = await client.machine.findMany({ where: { isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, location: true, pricePerGarrafonCents: true } });
  let selected = null;
  if (machineId || hardwareId) selected = await membershipMachine(machineId, hardwareId, client);
  else if (machines.length) {
    const active = await client.userMembership.findFirst({ where: activeMembershipWhere(userId), select: { machineId: true } });
    selected = machines.find((machine) => machine.id === active?.machineId) || machines[0];
  }
  return { machine: selected, machines };
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

module.exports = { membershipQuote, membershipMachine, membershipContext, activeMembershipWhere, membershipCoverage };
