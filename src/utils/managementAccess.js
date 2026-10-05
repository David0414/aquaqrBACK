const { prisma } = require('../db');
const { requireAuthOrMonitorAdmin } = require('./monitorAdmin');

const normalizeMachineId = (value) => String(value || '').trim().toUpperCase().replace(/[^0-9A-Z_-]/g, '');
const normalizeHardwareId = (value) => {
  const text = String(value || '').trim().toUpperCase();
  return /^[0-9A-F]{1,2}$/.test(text) ? text.padStart(2, '0') : null;
};

async function getManagementPrincipal(auth, client = prisma) {
  if (auth?.monitorAdmin) return { userId: auth.userId, role: 'ADMIN', active: true };
  const user = await client.user.findUnique({ where: { id: auth.userId }, select: {
    id: true, name: true, email: true, role: true, managementAccessActive: true,
  } });
  const bootstrapAdmins = String(process.env.ADMIN_CLERK_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
  const role = bootstrapAdmins.includes(auth.userId) ? 'ADMIN' : (user?.role || 'CUSTOMER');
  return { userId: auth.userId, role, active: user?.managementAccessActive !== false, name: user?.name, email: user?.email };
}

function canManage(principal) {
  return Boolean(principal?.active && ['ADMIN', 'PARTNER'].includes(principal.role));
}

function machineScope(principal) {
  if (!canManage(principal)) throw Object.assign(new Error('No tienes acceso al panel de administración'), { statusCode: 403 });
  return principal.role === 'ADMIN' ? {} : { partnerId: principal.userId };
}

function sendAccessError(res, error) {
  const status = error.statusCode || 500;
  if (status === 500) console.error('Management access error', error);
  return res.status(status).json({ error: status === 500 ? 'No se pudo verificar el acceso' : error.message });
}

function requireManagement(req, res, next) {
  return requireAuthOrMonitorAdmin(req, res, async () => {
    try {
      req.management = await getManagementPrincipal(req.auth);
      machineScope(req.management);
      return next();
    } catch (error) { return sendAccessError(res, error); }
  });
}

function requireAdministrator(req, res, next) {
  return requireManagement(req, res, () => {
    if (req.management.role !== 'ADMIN') return res.status(403).json({ error: 'Solo el administrador puede realizar esta acción' });
    return next();
  });
}

async function getManagedMachine(principal, machineId, suppliedHardwareId, client = prisma) {
  const id = normalizeMachineId(machineId);
  if (!id) throw Object.assign(new Error('Selecciona una máquina'), { statusCode: 400 });
  const machine = await client.machine.findFirst({ where: { id, ...machineScope(principal) } });
  if (!machine) throw Object.assign(new Error('Máquina no disponible para esta cuenta'), { statusCode: 404 });
  if (suppliedHardwareId !== undefined && suppliedHardwareId !== null && suppliedHardwareId !== '') {
    if (!normalizeHardwareId(suppliedHardwareId) || normalizeHardwareId(suppliedHardwareId) !== normalizeHardwareId(machine.hardwareId)) {
      throw Object.assign(new Error('El hardware no corresponde a la máquina seleccionada'), { statusCode: 400 });
    }
  }
  return machine;
}

function requireManagedMachine(source = 'params', field = 'id', checkHardware = false) {
  return (req, res, next) => requireManagement(req, res, async () => {
    try {
      req.managedMachine = await getManagedMachine(req.management, req[source]?.[field], checkHardware ? req[source]?.hardwareId : undefined);
      return next();
    } catch (error) { return sendAccessError(res, error); }
  });
}

module.exports = { getManagementPrincipal, canManage, machineScope, requireManagement, requireAdministrator,
  getManagedMachine, requireManagedMachine, sendAccessError, normalizeMachineId, normalizeHardwareId };
