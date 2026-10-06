const { getManagedMachine, normalizeMachineId, normalizeHardwareId } = require('./managementAccess');
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function buildMachineSettings(body, existing, principal) {
  const data = {};
  for (const field of ['name', 'location', 'address']) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'string' && body[field] !== null) throw error('Datos de máquina inválidos');
      data[field] = String(body[field] || '').trim().slice(0, 300) || null;
    }
  }
  if (body.hardwareId !== undefined) {
    const hardwareId = body.hardwareId ? normalizeHardwareId(body.hardwareId) : null;
    if (body.hardwareId && !hardwareId) throw error('El hardware debe tener uno o dos dígitos hexadecimales');
    if (principal.role !== 'ADMIN' && hardwareId !== normalizeHardwareId(existing?.hardwareId)) {
      throw error('Solo el administrador puede cambiar el hardware de la máquina', 403);
    }
    if (principal.role === 'ADMIN') data.hardwareId = hardwareId;
  }
  if (body.partnerId !== undefined && body.partnerId !== existing?.partnerId) {
    throw error('La asignación de socios se realiza desde el apartado Socios', 403);
  }
  if (body.pricePerGarrafonCents !== undefined || body.pricePerGarrafon !== undefined) {
    const amount = body.pricePerGarrafonCents !== undefined ? Number(body.pricePerGarrafonCents) : Math.round(Number(body.pricePerGarrafon) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) throw error('Ingresa un precio válido para el garrafón');
    data.pricePerGarrafonCents = amount;
  }
  if (body.status !== undefined) {
    const status = String(body.status).toUpperCase();
    if (!['ONLINE', 'OFFLINE', 'MAINTENANCE', 'INSTALLING'].includes(status)) throw error('Estado operativo inválido');
    data.status = status;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw error('Estado de activación inválido');
    data.isActive = body.isActive;
  }
  if (body.coinsEnabled !== undefined) {
    if (principal.role !== 'ADMIN') throw error('Solo el administrador puede habilitar monedas', 403);
    if (typeof body.coinsEnabled !== 'boolean') throw error('Indica si las monedas deben estar habilitadas');
    data.coinsEnabled = body.coinsEnabled;
  }
  return data;
}

async function saveManagedMachine(client, principal, machineId, body, allowCreate = false) {
  const id = normalizeMachineId(machineId);
  if (!id) throw error('ID de máquina requerido');
  if (allowCreate && principal.role !== 'ADMIN') throw error('Solo el administrador puede registrar máquinas', 403);
  return client.$transaction(async (tx) => {
    const existing = allowCreate ? await tx.machine.findUnique({ where: { id } }) : await getManagedMachine(principal, id, undefined, tx);
    const data = buildMachineSettings(body, existing, principal);
    const hardwareId = data.hardwareId === undefined ? existing?.hardwareId : data.hardwareId;
    if (hardwareId && existing?.partnerId) {
      const conflict = await tx.machine.findFirst({ where: { id: { not: id }, hardwareId,
        partnerId: { not: existing.partnerId } } });
      if (conflict) throw error('Este hardware pertenece a una máquina de otro socio', 409);
    }
    return tx.machine.upsert({ where: { id }, update: data, create: { id, ...data },
      include: { partner: { select: { id: true, name: true, email: true, managementAccessActive: true } } } });
  }, { isolationLevel: 'Serializable' });
}

module.exports = { buildMachineSettings, saveManagedMachine };
