const express = require('express');
const QRCode = require('qrcode');
const { prisma } = require('../db');
const { signMachineLink } = require('../utils/qrSigning');
const { requireAuthOrMonitorAdmin } = require('../utils/monitorAdmin');
const { getPromotionCatalog, ensurePromotionCatalog } = require('../utils/rewards');

const router = express.Router();

const FRONT_URL = (process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, '');
const QR_BASE_URL = (process.env.QR_BASE_URL || FRONT_URL).replace(/\/+$/, '');
const SECRET = process.env.QR_SIGNING_SECRET;

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

router.get('/machines', requireAuthOrMonitorAdmin, async (_req, res) => {
  try {
    const machines = await prisma.machine.findMany({
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    });
    return res.json({ items: machines });
  } catch (error) {
    console.error('GET /api/monitor-admin/machines error', error);
    return res.status(500).json({ error: 'No se pudieron cargar las maquinas' });
  }
});

router.post('/machines', requireAuthOrMonitorAdmin, async (req, res) => {
  try {
    const id = normalizeMachineId(req.body?.id);
    if (!id) {
      return res.status(400).json({ error: 'id de maquina requerido' });
    }

    const machine = await prisma.machine.upsert({
      where: { id },
      update: {
        name: String(req.body?.name || '').trim() || null,
        location: String(req.body?.location || '').trim() || null,
        address: String(req.body?.address || '').trim() || null,
        hardwareId: normalizeHardwareId(req.body?.hardwareId),
        status: String(req.body?.status || 'ONLINE').trim().toUpperCase() || 'ONLINE',
        isActive: req.body?.isActive !== false,
      },
      create: {
        id,
        name: String(req.body?.name || '').trim() || null,
        location: String(req.body?.location || '').trim() || null,
        address: String(req.body?.address || '').trim() || null,
        hardwareId: normalizeHardwareId(req.body?.hardwareId),
        status: String(req.body?.status || 'ONLINE').trim().toUpperCase() || 'ONLINE',
        isActive: req.body?.isActive !== false,
      },
    });

    return res.json({ ok: true, machine });
  } catch (error) {
    console.error('POST /api/monitor-admin/machines error', error);
    return res.status(500).json({ error: 'No se pudo guardar la maquina' });
  }
});

router.put('/machines/:id', requireAuthOrMonitorAdmin, async (req, res) => {
  try {
    const id = normalizeMachineId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id de maquina invalido' });
    }

    const machine = await prisma.machine.update({
      where: { id },
      data: {
        name: String(req.body?.name || '').trim() || null,
        location: String(req.body?.location || '').trim() || null,
        address: String(req.body?.address || '').trim() || null,
        hardwareId: normalizeHardwareId(req.body?.hardwareId),
        status: String(req.body?.status || 'ONLINE').trim().toUpperCase() || 'ONLINE',
        isActive: req.body?.isActive !== false,
      },
    });

    return res.json({ ok: true, machine });
  } catch (error) {
    console.error('PUT /api/monitor-admin/machines/:id error', error);
    return res.status(500).json({ error: 'No se pudo actualizar la maquina' });
  }
});

router.get('/machines/:id/qr', requireAuthOrMonitorAdmin, async (req, res) => {
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

router.get('/promotions', requireAuthOrMonitorAdmin, async (_req, res) => {
  try {
    const promotions = await getPromotionCatalog(prisma);
    return res.json({ items: promotions });
  } catch (error) {
    console.error('GET /api/monitor-admin/promotions error', error);
    return res.status(500).json({ error: 'No se pudieron cargar las promociones' });
  }
});

router.put('/promotions/:key', requireAuthOrMonitorAdmin, async (req, res) => {
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

router.get('/summary', requireAuthOrMonitorAdmin, async (_req, res) => {
  try {
    const [machines, promotions] = await Promise.all([
      prisma.machine.findMany({ orderBy: [{ isActive: 'desc' }, { id: 'asc' }] }),
      getPromotionCatalog(prisma),
    ]);

    return res.json({
      machines,
      promotions,
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
