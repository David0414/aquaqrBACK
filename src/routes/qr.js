// src/routes/qr.js
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
// ❌ Sin Prisma aquí
const { requireAuth } = require('../utils/auth');
const { signMachineLink, verifyMachineLink } = require('../utils/qrSigning');

const FRONT_URL = (process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, '');
const SECRET = process.env.QR_SIGNING_SECRET;
const QR_BASE_URL = (process.env.QR_BASE_URL || FRONT_URL).replace(/\/+$/, '');

// ---- Carga de máquinas desde ENV (MACHINES_JSON) ----
function loadMachines() {
  try {
    const raw = process.env.MACHINES_JSON || '[]';
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map(m => ({
      id: String(m.id),
      isActive: m.isActive !== false, // default true
      location: m.location || null,
      status: m.status || 'ONLINE',
    }));
  } catch (e) {
    console.error('[QR] MACHINES_JSON inválido:', e.message);
    return [];
  }
}
const MACHINES = loadMachines();
const ALLOW_UNKNOWN_MACHINES = String(process.env.ALLOW_UNKNOWN_MACHINES || '').toLowerCase() === 'true';

function getMachine(id) {
  const m = MACHINES.find(x => x.id === id);
  if (m) return m;
  if (ALLOW_UNKNOWN_MACHINES) return { id, isActive: true, location: null, status: 'ONLINE' };
  return null;
}

// ---------------------------------------------------------------------------
// 1) Generar QR (admin/ops): permanent (sticker) o ephemeral (pantalla)
//    GET /api/qr/generate?machineId=AQ-001&kind=permanent
// ---------------------------------------------------------------------------
router.get('/generate', requireAuth, async (req, res) => {
  try {
    const machineId = String(req.query.machineId || '').trim();
    const kind = String(req.query.kind || 'permanent').toLowerCase();

    if (!machineId) return res.status(400).json({ error: 'machineId requerido' });
    if (!SECRET) {
      console.error('[QR] Falta QR_SIGNING_SECRET (generate)');
      return res.status(500).json({ error: 'Falta QR_SIGNING_SECRET en backend (prod)' });
    }

    const mach = getMachine(machineId);
    if (!mach) return res.status(404).json({ error: 'Máquina no encontrada (MACHINES_JSON)' });
    if (!mach.isActive) return res.status(404).json({ error: 'Máquina no disponible' });

    const { sig, ts } = signMachineLink({
      machineId,
      secret: SECRET,
      mode: kind === 'ephemeral' ? 'ephemeral' : 'permanent'
    });

    const qs = new URLSearchParams({ m: machineId, sig });
    if (ts) qs.set('ts', String(ts));

    const deepUrl = `${QR_BASE_URL}/qr-resolver?${qs.toString()}`;
    const dataUrl = await QRCode.toDataURL(deepUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });

    res.json({ machineId, deepUrl, qrPngDataUrl: dataUrl, kind: kind === 'ephemeral' ? 'ephemeral' : 'permanent' });
  } catch (e) {
    console.error('GET /api/qr/generate error', e);
    res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

// ---------------------------------------------------------------------------
// 2) Resolver para FRONT
//    GET /api/qr/resolve?m=...&sig=...[&ts=...]
// ---------------------------------------------------------------------------
router.get('/resolve', async (req, res) => {
  try {
    const machineId = String(req.query.m || '').trim();
    const ts = String(req.query.ts || '').trim();
    const sig = String(req.query.sig || '').trim();

    if (!SECRET) {
      console.error('[QR] Falta QR_SIGNING_SECRET (resolve)');
      return res.status(500).json({ error: 'Falta QR_SIGNING_SECRET en backend (prod)' });
    }

    const v = verifyMachineLink({ machineId, ts: ts || undefined, sig, secret: SECRET });
    if (!v.ok) return res.status(400).json({ error: 'QR inválido o expirado', code: v.reason });

    const mach = getMachine(machineId);
    if (!mach || !mach.isActive) return res.status(404).json({ error: 'Máquina no disponible' });

    res.json({
      ok: true,
      mode: v.mode,
      machineId: mach.id,
      machineLocation: mach.location || null,
      status: mach.status || 'ONLINE'
    });
  } catch (e) {
    console.error('GET /api/qr/resolve error', e);
    res.status(500).json({ error: 'No se pudo resolver el QR' });
  }
});

// ---------------------------------------------------------------------------
// 3) Redirección pública (si apuntas el QR al backend en /m)
//    GET /m?m=...&sig=...[&ts=...]
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const machineId = String(req.query.m || '').trim();
    const ts = String(req.query.ts || '').trim();
    const sig = String(req.query.sig || '').trim();

    if (!SECRET) {
      console.error('[QR] Falta QR_SIGNING_SECRET (public redirect)');
      const url = `${FRONT_URL}/qr-resolver?error=falta_secret`;
      return res.redirect(302, url);
    }

    const v = verifyMachineLink({ machineId, ts: ts || undefined, sig, secret: SECRET });
    const qs = new URLSearchParams(v.ok ? { m: machineId, sig, ...(ts ? { ts } : {}) } : { error: v.reason });

    const url = `${FRONT_URL}/qr-resolver?${qs.toString()}`;
    return res.redirect(302, url);
  } catch (e) {
    console.error('GET /m redirect error', e);
    const url = `${FRONT_URL}/qr-resolver?error=server`;
    return res.redirect(302, url);
  }
});

module.exports = router;
