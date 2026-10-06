const { prisma } = require('../db');
const { normalizeMachineId, normalizeHardwareId } = require('./managementAccess');

async function requireMachineCoins(machineIdValue, hardwareIdValue, client = prisma) {
  const id = normalizeMachineId(machineIdValue);
  const hardwareId = normalizeHardwareId(hardwareIdValue);
  const machine = id ? await client.machine.findUnique({ where: { id } }) : null;
  const resolvedHardware = hardwareId || (/^[0-9A-F]{1,2}$/.test(id) ? normalizeHardwareId(id) : null);
  const resolved = machine || (resolvedHardware ? await client.machine.findFirst({ where: { hardwareId: resolvedHardware, isActive: true } }) : null);
  if (!resolved || !resolved.isActive || !resolved.coinsEnabled
    || (machine && hardwareId && normalizeHardwareId(machine.hardwareId) !== hardwareId)) {
    throw Object.assign(new Error('Las monedas están deshabilitadas para esta máquina'), { statusCode: 403, code: 'COINS_DISABLED' });
  }
  return resolved;
}

async function requireCoinSession(userId, machine, client = prisma) {
  const lock = await client.machineLock.findFirst({ where: { userId, expiresAt: { gt: new Date() },
    OR: [{ machineId: machine.id }, ...(machine.hardwareId ? [{ hardwareId: machine.hardwareId }] : [])] } });
  if (!lock) throw Object.assign(new Error('Escanea el QR e inicia una sesión en esta máquina antes de usar monedas'),
    { statusCode: 403, code: 'COIN_SESSION_REQUIRED' });
  return lock;
}

module.exports = { requireMachineCoins, requireCoinSession };
