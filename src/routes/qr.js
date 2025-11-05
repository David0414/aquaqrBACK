// src/routes/qr.js
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../utils/auth');
const { signMachineLink, verifyMachineLink } = require('../utils/qrSigning');

const prisma = new PrismaClient();

const FRONT_URL = process.env.APP_PUBLIC_URL?.replace(/\/+$/, '') || 'http://localhost:5173';
const SECRET = process.env.QR_SIGNING_SECRET;
const QR_BASE_URL = process.env.QR_BASE_URL?.replace(/\/+$/, '') || FRONT_URL;

// ---------------------------------------------------------------------------
// 1) Generar QR (admin/ops): permanent (sticker) o ephemeral (pantalla)
//    GET /api/qr/generate?machineId=AQ-001&kind=permanent
// ---------------------------------------------------------------------------

router.get('/generate', requireAuth, async (req, res) => {
  try {
    const machineId = String(req.query.machineId || '').trim();
    const kind = String(req.query.kind || 'permanent').toLowerCase();

    if (!machineId) return res.status(400).json({ error: 'machineId requerido' });
    if (!SECRET) return res.status(500).json({ error: 'Falta QR_SIGNING_SECRET' });

    const mach = await prisma.machine.findUnique({ where: { id: machineId } });
    if (!mach) return res.status(404).json({ error: 'Máquina no encontrada' });

    const { sig, ts } = signMachineLink({
      machineId,
      secret: SECRET,
      mode: kind === 'ephemeral' ? 'ephemeral' : 'permanent'
    });

    const qs = new URLSearchParams({ m: machineId, sig });
    if (ts) qs.set('ts', String(ts));

    // 📌 Recomendado: mandar a una página del FRONT que resuelva el QR
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

    const v = verifyMachineLink({ machineId, ts: ts || undefined, sig, secret: SECRET });
    if (!v.ok) return res.status(400).json({ error: 'QR inválido o expirado', code: v.reason });

    const mach = await prisma.machine.findUnique({
      where: { id: machineId },
      select: { id: true, status: true, location: true, isActive: true }
    });
    if (!mach || !mach.isActive) return res.status(404).json({ error: 'Máquina no disponible' });

    res.json({
      ok: true,
      mode: v.mode, // 'permanent' o 'ephemeral'
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
// 3) Redirección pública opcional (si apuntas el QR al backend en /m)
//    Monta este router en /m y esto redirige al FRONT /qr-resolver
//    GET /m?m=...&sig=...[&ts=...]
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const machineId = String(req.query.m || '').trim();
    const ts = String(req.query.ts || '').trim();
    const sig = String(req.query.sig || '').trim();

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
