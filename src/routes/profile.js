const express = require('express');
const router = express.Router();

const { prisma } = require('../db');      // usa el singleton
const { requireAuth } = require('../utils/auth');

// GET /api/profile -> { phone }
router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;

    // Asegura que exista el registro del usuario
    const user = await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId },
      select: { phone: true },
    });

    res.json({ phone: user.phone || '' });
  } catch (e) {
    console.error('GET /api/profile error', e);
    res.status(500).json({ error: 'No se pudo obtener el perfil' });
  }
});

// PUT /api/profile { phone }
// - Si phone es "", se guarda como null (opcional).
router.put('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const raw = String(req.body?.phone ?? '').trim();

    let phone = null;
    if (raw.length > 0) {
      // Validación sencilla; ajusta el patrón si lo deseas
      if (!/^\+?[\d\s\-()]{10,}$/.test(raw)) {
        return res.status(400).json({ error: 'Teléfono inválido' });
      }
      phone = raw;
    }

    await prisma.user.upsert({
      where: { id: userId },
      update: { phone },
      create: { id: userId, phone },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/profile error', e);
    res.status(500).json({ error: 'No se pudo actualizar el perfil' });
  }
});

module.exports = router;
