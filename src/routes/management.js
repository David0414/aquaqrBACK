const express = require('express');
const { createClerkClient } = require('@clerk/backend');
const { prisma } = require('../db');
const { requireAuthOrMonitorAdmin, validAdminCredentials, createAdminSession } = require('../utils/monitorAdmin');
const { getManagementPrincipal, canManage, requireAdministrator, sendAccessError, normalizeMachineId } = require('../utils/managementAccess');

const router = express.Router();
const loginAttempts = new Map();
const partnerSelect = { id: true, name: true, email: true, role: true, managementAccessActive: true,
  ownedMachines: { select: { id: true, name: true, location: true, isActive: true }, orderBy: { id: 'asc' } } };

router.post('/login', (req, res) => {
  const now = Date.now();
  for (const [key, attempt] of loginAttempts) if (attempt.expiresAt <= now) loginAttempts.delete(key);
  const key = req.ip;
  const attempt = loginAttempts.get(key) || { count: 0, expiresAt: now + 15 * 60 * 1000 };
  if (attempt.count >= 10) return res.status(429).json({ error: 'Demasiados intentos. Intenta nuevamente en 15 minutos.' });
  if (!validAdminCredentials(String(req.body?.user || '').trim(), req.body?.password)) {
    attempt.count += 1;
    loginAttempts.set(key, attempt);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  loginAttempts.delete(key);
  res.set('Cache-Control', 'no-store');
  return res.json({ role: 'ADMIN', ...createAdminSession(now) });
});

router.get('/me', requireAuthOrMonitorAdmin, async (req, res) => {
  try {
    const principal = await getManagementPrincipal(req.auth);
    res.set('Cache-Control', 'no-store');
    return res.json({ ...principal, canManage: canManage(principal), defaultPath: canManage(principal) ?
      (principal.role === 'ADMIN' ? '/water-monitor' : '/partner-panel') : '/home-dashboard' });
  } catch (error) { return sendAccessError(res, error); }
});

router.get('/partners', requireAdministrator, async (_req, res) => {
  try {
    const partners = await prisma.user.findMany({ where: { role: 'PARTNER' }, select: partnerSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    res.set('Cache-Control', 'no-store');
    return res.json({ items: partners });
  } catch (error) { return sendAccessError(res, error); }
});

// Resolve identities through Clerk, never through the editable customer profile email.
async function findPartnerAccount({ email, clerkUserId }, clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })) {
  if (clerkUserId) {
    if (!/^user_[a-zA-Z0-9]+$/.test(clerkUserId)) throw Object.assign(new Error('ID de cuenta inválido'), { statusCode: 400 });
    return clerk.users.getUser(clerkUserId);
  }
  const address = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw Object.assign(new Error('Ingresa el correo de la cuenta del socio'), { statusCode: 400 });
  const { data } = await clerk.users.getUserList({ emailAddress: [address], limit: 10 });
  const matches = data.filter((user) => user.emailAddresses.some((item) => item.emailAddress.toLowerCase() === address && item.verification?.status === 'verified'));
  if (matches.length !== 1) throw Object.assign(new Error('No se encontró una cuenta con ese correo verificado. El socio debe registrarse primero.'), { statusCode: 400 });
  return matches[0];
}

router.post('/partners', requireAdministrator, async (req, res) => {
  try {
    const account = await findPartnerAccount(req.body || {});
    const existing = await getManagementPrincipal({ userId: account.id });
    if (existing.role === 'ADMIN') return res.status(400).json({ error: 'Esta cuenta ya es administradora' });
    const email = account.emailAddresses.find((item) => item.id === account.primaryEmailAddressId)?.emailAddress || null;
    const name = [account.firstName, account.lastName].filter(Boolean).join(' ') || account.username || null;
    const partner = await prisma.user.upsert({ where: { id: account.id },
      update: { role: 'PARTNER', managementAccessActive: true, email, name },
      create: { id: account.id, clerkId: account.id, role: 'PARTNER', managementAccessActive: true, email, name },
      select: partnerSelect });
    return res.json({ ok: true, partner });
  } catch (error) {
    if (error.status === 404) error = Object.assign(new Error('Cuenta de socio no encontrada'), { statusCode: 400 });
    return sendAccessError(res, error);
  }
});

router.put('/partners/:id/access', requireAdministrator, async (req, res) => {
  try {
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'Indica si el acceso debe estar activo' });
    const result = await prisma.user.updateMany({ where: { id: req.params.id, role: 'PARTNER' },
      data: { managementAccessActive: req.body.active } });
    if (!result.count) return res.status(404).json({ error: 'Socio no encontrado' });
    return res.json({ ok: true });
  } catch (error) { return sendAccessError(res, error); }
});

router.put('/machines/:id/partner', requireAdministrator, async (req, res) => {
  try {
    const id = normalizeMachineId(req.params.id);
    const partnerId = req.body?.partnerId;
    if (!id || (partnerId !== null && (typeof partnerId !== 'string' || !partnerId.trim()))) {
      return res.status(400).json({ error: 'Selecciona un socio o indica que la máquina quede sin asignar' });
    }
    const machine = await prisma.$transaction(async (tx) => {
      const current = await tx.machine.findUnique({ where: { id } });
      if (!current) throw Object.assign(new Error('Registra la máquina antes de asignarla'), { statusCode: 404 });
      if (partnerId) {
        const partner = await tx.user.findFirst({ where: { id: partnerId, role: 'PARTNER', managementAccessActive: true } });
        if (!partner) throw Object.assign(new Error('El socio no existe o tiene el acceso suspendido'), { statusCode: 400 });
        if (current.hardwareId) {
          const conflict = await tx.machine.findFirst({ where: { id: { not: id }, hardwareId: current.hardwareId,
            partnerId: { not: partnerId } } });
          if (conflict) throw Object.assign(new Error('Este hardware ya está asignado a otro socio'), { statusCode: 409 });
        }
      }
      return tx.machine.update({ where: { id }, data: { partnerId }, include: { partner: {
        select: { id: true, name: true, email: true, managementAccessActive: true } } } });
    }, { isolationLevel: 'Serializable' });
    return res.json({ ok: true, machine });
  } catch (error) {
    if (error.code === 'P2034') error = Object.assign(new Error('La asignación cambió al mismo tiempo. Intenta de nuevo.'), { statusCode: 409 });
    return sendAccessError(res, error);
  }
});

module.exports = router;
module.exports.findPartnerAccount = findPartnerAccount;
