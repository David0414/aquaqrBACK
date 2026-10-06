const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { prisma } = require('../db');
const { signMachineLink } = require('../utils/qrSigning');
const { requireManagement, requireAdministrator, requireManagedMachine, machineScope, sendAccessError } = require('../utils/managementAccess');
const { saveManagedMachine } = require('../utils/machineSettings');
const { getPromotionCatalog, ensurePromotionCatalog } = require('../utils/rewards');
const { machineSales } = require('../utils/machineSales');

const router = express.Router();

const FRONT_URL = (process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, '');
const QR_BASE_URL = (process.env.QR_BASE_URL || FRONT_URL).replace(/\/+$/, '');
const SECRET = process.env.QR_SIGNING_SECRET;
const STICKERS_DIR = path.join(__dirname, '..', '..', 'stickers');
const DEFAULT_PRICE_PER_GARRAFON_CENTS = Number.parseInt(process.env.PRICE_PER_GARRAFON_CENTS || '3500', 10) || 3500;
const STICKER_MACHINE_DEFAULTS = Object.freeze({
  'AQ-001': {
    name: 'Dispensador AQ-001',
    location: 'Sucursal Centro',
    address: 'Sucursal Centro',
    hardwareId: '01',
    status: 'ONLINE',
  },
});

function normalizeMachineId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z_-]/g, '');
}

function normalizeHardwareId(value) {
  const clean = String(value || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  return clean ? clean.padStart(2, '0').slice(-2) : null;
}

function listStickerMachines() {
  try {
    if (!fs.existsSync(STICKERS_DIR)) return [];
    return fs.readdirSync(STICKERS_DIR)
      .filter((fileName) => fileName.toLowerCase().endsWith('.png'))
      .map((fileName) => {
        const id = normalizeMachineId(fileName.replace(/\.png$/i, ''));
        if (!id) return null;
        const defaults = STICKER_MACHINE_DEFAULTS[id] || {};
        return {
          id,
          name: defaults.name || `Dispensador ${id}`,
          location: defaults.location || null,
          address: defaults.address || defaults.location || null,
          hardwareId: normalizeHardwareId(defaults.hardwareId),
          pricePerGarrafonCents: DEFAULT_PRICE_PER_GARRAFON_CENTS,
          status: defaults.status || 'ONLINE',
          isActive: true,
          stickerUrl: `/stickers/${fileName}`,
          discoveredFrom: 'sticker',
          detectedOnly: true,
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error('listStickerMachines error', error);
    return [];
  }
}

function mergeMachines(dbMachines) {
  const byId = new Map(
    (dbMachines || []).map((machine) => [
      machine.id,
      {
        ...machine,
        stickerUrl: `/stickers/${machine.id}.png`,
        discoveredFrom: 'database',
      },
    ])
  );

  for (const stickerMachine of listStickerMachines()) {
    if (!byId.has(stickerMachine.id)) {
      byId.set(stickerMachine.id, stickerMachine);
      continue;
    }

    const current = byId.get(stickerMachine.id);
    byId.set(stickerMachine.id, {
      ...current,
      name: current.name || stickerMachine.name,
      location: current.location || stickerMachine.location,
      address: current.address || stickerMachine.address,
      hardwareId: current.hardwareId || stickerMachine.hardwareId,
      pricePerGarrafonCents: current.pricePerGarrafonCents || stickerMachine.pricePerGarrafonCents || DEFAULT_PRICE_PER_GARRAFON_CENTS,
      status: current.status || stickerMachine.status,
      stickerUrl: current.stickerUrl || stickerMachine.stickerUrl,
      discoveredFrom: current.discoveredFrom || 'database',
    });
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

router.get('/machines', requireManagement, async (req, res) => {
  try {
    const dbMachines = await prisma.machine.findMany({
      where: machineScope(req.management),
      include: { partner: { select: { id: true, name: true, email: true, managementAccessActive: true } } },
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    });
    const machines = req.management.role === 'ADMIN' ? mergeMachines(dbMachines) : dbMachines;
    return res.json({ items: machines });
  } catch (error) {
    console.error('GET /api/monitor-admin/machines error', error);
    return res.status(500).json({ error: 'No se pudieron cargar las maquinas' });
  }
});

router.post('/machines', requireAdministrator, async (req, res) => {
  try {
    const id = normalizeMachineId(req.body?.id);
    if (!id) {
      return res.status(400).json({ error: 'id de maquina requerido' });
    }

    const machine = await saveManagedMachine(prisma, req.management, id, req.body || {}, true);

    return res.json({ ok: true, machine });
  } catch (error) {
    return sendAccessError(res, error);
  }
});

router.put('/machines/:id', requireManagedMachine(), async (req, res) => {
  try {
    const id = normalizeMachineId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id de maquina invalido' });
    }

    const machine = await saveManagedMachine(prisma, req.management, id, req.body || {});

    return res.json({ ok: true, machine });
  } catch (error) {
    return sendAccessError(res, error);
  }
});

router.delete('/machines/:id', requireAdministrator, async (req, res) => {
  try {
    const id = normalizeMachineId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id de maquina invalido' });
    }

    const existing = await prisma.machine.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Maquina no encontrada' });
    }

    await prisma.machine.delete({ where: { id } });
    return res.json({ ok: true, deletedId: id });
  } catch (error) {
    console.error('DELETE /api/monitor-admin/machines/:id error', error);
    return res.status(500).json({ error: 'No se pudo eliminar la maquina' });
  }
});

router.get('/machines/:id/qr', requireManagedMachine(), async (req, res) => {
  try {
    const id = normalizeMachineId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id de maquina invalido' });
    }
    if (!SECRET) {
      return res.status(500).json({ error: 'Falta QR_SIGNING_SECRET en backend' });
    }

    const machine = await prisma.machine.findUnique({ where: { id } });
    if (!machine || !machine.isActive) {
      return res.status(404).json({ error: 'Maquina no disponible' });
    }

    const { sig } = signMachineLink({ machineId: id, secret: SECRET, mode: 'permanent' });
    const qs = new URLSearchParams({ m: id, sig });
    const deepUrl = `${QR_BASE_URL}/qr-resolver?${qs.toString()}`;
    const qrPngDataUrl = await QRCode.toDataURL(deepUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 6,
    });

    return res.json({
      ok: true,
      machineId: id,
      machineLocation: machine.location,
      deepUrl,
      qrPngDataUrl,
    });
  } catch (error) {
    console.error('GET /api/monitor-admin/machines/:id/qr error', error);
    return res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

router.get('/promotions', requireAdministrator, async (_req, res) => {
  try {
    const promotions = await getPromotionCatalog(prisma);
    return res.json({ items: promotions });
  } catch (error) {
    console.error('GET /api/monitor-admin/promotions error', error);
    return res.status(500).json({ error: 'No se pudieron cargar las promociones' });
  }
});

router.put('/promotions/:key', requireAdministrator, async (req, res) => {
  try {
    await ensurePromotionCatalog(prisma);
    const key = String(req.params.key || '').trim();
    const existing = await prisma.appPromotion.findUnique({ where: { key } });
    if (!existing) {
      return res.status(404).json({ error: 'Promocion no encontrada' });
    }

    const nextConfig = req.body?.config && typeof req.body.config === 'object'
      ? { ...(existing.config || {}), ...req.body.config }
      : existing.config;

    const promotion = await prisma.appPromotion.update({
      where: { key },
      data: {
        isActive: req.body?.isActive === undefined ? existing.isActive : Boolean(req.body.isActive),
        config: nextConfig,
      },
    });

    return res.json({ ok: true, promotion });
  } catch (error) {
    console.error('PUT /api/monitor-admin/promotions/:key error', error);
    return res.status(500).json({ error: 'No se pudo actualizar la promocion' });
  }
});

router.get('/summary', requireManagement, async (req, res) => {
  try {
    const [dbMachines, promotions] = await Promise.all([
      prisma.machine.findMany({ where: machineScope(req.management),
        include: { partner: { select: { id: true, name: true, email: true, managementAccessActive: true } } },
        orderBy: [{ isActive: 'desc' }, { id: 'asc' }] }),
      req.management.role === 'ADMIN' ? getPromotionCatalog(prisma) : Promise.resolve([]),
    ]);
    const machines = req.management.role === 'ADMIN' ? mergeMachines(dbMachines) : dbMachines;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sales = await machineSales(prisma, dbMachines.map((machine) => machine.id), since);

    return res.json({
      machines,
      role: req.management.role,
      name: req.management.name || null,
      promotions,
      sales,
      counts: {
        machines: machines.length,
        activeMachines: machines.filter((machine) => machine.isActive).length,
        activePromotions: promotions.filter((promotion) => promotion.isActive).length,
      },
    });
  } catch (error) {
    console.error('GET /api/monitor-admin/summary error', error);
    return res.status(500).json({ error: 'No se pudo cargar el resumen del monitor' });
  }
});

module.exports = router;
