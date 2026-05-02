const express = require('express');
const QRCode = require('qrcode');
const { prisma } = require('../db');
const { requireAuthOrMonitorAdmin } = require('../utils/monitorAdmin');
const { signMachineLink, verifyMachineLink } = require('../utils/qrSigning');

const router = express.Router();

const FRONT_URL = (process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, '');
const SECRET = process.env.QR_SIGNING_SECRET;
const QR_BASE_URL = (process.env.QR_BASE_URL || FRONT_URL).replace(/\/+$/, '');
const ALLOW_UNKNOWN_MACHINES = String(process.env.ALLOW_UNKNOWN_MACHINES || '').toLowerCase() === 'true';

function normalizeMachineId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z_-]/g, '');
}

function loadMachinesFromEnv() {
  try {
    const raw = process.env.MACHINES_JSON || '[]';
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map((machine) => ({
      id: normalizeMachineId(machine.id),
      name: machine.name || null,
      location: machine.location || null,
      address: machine.address || null,
      hardwareId: machine.hardwareId || null,
      isActive: machine.isActive !== false,
      status: machine.status || 'ONLINE',
    })).filter((machine) => machine.id);
  } catch (error) {
    console.error('[QR] MACHINES_JSON invalido:', error.message);
    return [];
  }
}

async function findMachine(machineId) {
  const normalizedId = normalizeMachineId(machineId);
  if (!normalizedId) return null;

  const dbMachine = await prisma.machine.findUnique({
    where: { id: normalizedId },
  });
  if (dbMachine) return dbMachine;

  const fallback = loadMachinesFromEnv().find((machine) => machine.id === normalizedId);
  if (fallback) return fallback;

  if (ALLOW_UNKNOWN_MACHINES) {
    return {
      id: normalizedId,
      name: null,
      location: null,
      address: null,
      hardwareId: null,
      isActive: true,
      status: 'ONLINE',
    };
  }

  return null;
}

router.get('/generate', requireAuthOrMonitorAdmin, async (req, res) => {
  try {
    const machineId = normalizeMachineId(req.query.machineId);
    const kind = String(req.query.kind || 'permanent').toLowerCase();

    if (!machineId) return res.status(400).json({ error: 'machineId requerido' });
    if (!SECRET) {
      console.error('[QR] Falta QR_SIGNING_SECRET (generate)');
      return res.status(500).json({ error: 'Falta QR_SIGNING_SECRET en backend (prod)' });
    }

    const machine = await findMachine(machineId);
    if (!machine) return res.status(404).json({ error: 'Maquina no encontrada' });
    if (!machine.isActive) return res.status(404).json({ error: 'Maquina no disponible' });

    const { sig, ts } = signMachineLink({
      machineId,
      secret: SECRET,
      mode: kind === 'ephemeral' ? 'ephemeral' : 'permanent',
    });

    const qs = new URLSearchParams({ m: machineId, sig });
    if (ts) qs.set('ts', String(ts));

    const deepUrl = `${QR_BASE_URL}/qr-resolver?${qs.toString()}`;
    const dataUrl = await QRCode.toDataURL(deepUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });

    return res.json({
      machineId,
      machineLocation: machine.location || null,
      deepUrl,
      qrPngDataUrl: dataUrl,
      kind: kind === 'ephemeral' ? 'ephemeral' : 'permanent',
    });
  } catch (error) {
    console.error('GET /api/qr/generate error', error);
    return res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

router.get('/resolve', async (req, res) => {
  try {
    const machineId = normalizeMachineId(req.query.m);
    const ts = String(req.query.ts || '').trim();
    const sig = String(req.query.sig || '').trim();

    if (!SECRET) {
      console.error('[QR] Falta QR_SIGNING_SECRET (resolve)');
      return res.status(500).json({ error: 'Falta QR_SIGNING_SECRET en backend (prod)' });
    }

    const verification = verifyMachineLink({ machineId, ts: ts || undefined, sig, secret: SECRET });
    if (!verification.ok) {
      return res.status(400).json({ error: 'QR invalido o expirado', code: verification.reason });
    }

    const machine = await findMachine(machineId);
    if (!machine || !machine.isActive) {
      return res.status(404).json({ error: 'Maquina no disponible' });
    }

    return res.json({
      ok: true,
      mode: verification.mode,
      machineId: machine.id,
      machineLocation: machine.location || null,
      machineAddress: machine.address || null,
      hardwareId: machine.hardwareId || null,
      status: machine.status || 'ONLINE',
    });
  } catch (error) {
    console.error('GET /api/qr/resolve error', error);
    return res.status(500).json({ error: 'No se pudo resolver el QR' });
  }
});

router.get('/', async (req, res) => {
  try {
    const machineId = normalizeMachineId(req.query.m);
    const ts = String(req.query.ts || '').trim();
    const sig = String(req.query.sig || '').trim();

    if (!SECRET) {
      console.error('[QR] Falta QR_SIGNING_SECRET (public redirect)');
      return res.redirect(302, `${FRONT_URL}/qr-resolver?error=falta_secret`);
    }

    const verification = verifyMachineLink({ machineId, ts: ts || undefined, sig, secret: SECRET });
    const qs = new URLSearchParams(verification.ok ? { m: machineId, sig, ...(ts ? { ts } : {}) } : { error: verification.reason });
    return res.redirect(302, `${FRONT_URL}/qr-resolver?${qs.toString()}`);
  } catch (error) {
    console.error('GET /m redirect error', error);
    return res.redirect(302, `${FRONT_URL}/qr-resolver?error=server`);
  }
});

module.exports = router;
