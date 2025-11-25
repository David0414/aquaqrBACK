// src/routes/profile.js
const express = require('express');
const router = express.Router();

const { prisma } = require('../db');      // usa el singleton
const { requireAuth } = require('../utils/auth');

/**
 * GET /api/profile
 * Devuelve los datos básicos del usuario: { email, name, phone }
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;

    // Asegura que exista el registro del usuario
    const user = await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId },
      select: {
        email: true,
        name: true,
        phone: true,
      },
    });

    res.json({
      email: user.email || '',
      name: user.name || '',
      phone: user.phone || '',
    });
  } catch (e) {
    console.error('GET /api/profile error', e);
    res.status(500).json({ error: 'No se pudo obtener el perfil' });
  }
});

/**
 * PUT /api/profile
 * Body: { email?: string, name?: string, phone?: string }
 * - Si un campo viene como "", se guarda como null.
 */
router.put('/', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const body = req.body || {};

    const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';

    let email = null;
    if (rawEmail.length > 0) {
      // Validación sencilla de email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(rawEmail)) {
        return res.status(400).json({ error: 'Correo inválido' });
      }
      email = rawEmail.toLowerCase();
    }

    let phone = null;
    if (rawPhone.length > 0) {
      // Validación sencilla; ajusta el patrón si lo deseas
      if (!/^\+?[\d\s\-()]{7,}$/.test(rawPhone)) {
        return res.status(400).json({ error: 'Teléfono inválido' });
      }
      phone = rawPhone;
    }

    const name = rawName.length > 0 ? rawName : null;

    const user = await prisma.user.upsert({
      where: { id: userId },
      update: { email, name, phone },
      create: { id: userId, email, name, phone },
      select: {
        email: true,
        name: true,
        phone: true,
      },
    });

    res.json({
      ok: true,
      user: {
        email: user.email || '',
        name: user.name || '',
        phone: user.phone || '',
      },
    });
  } catch (e) {
    console.error('PUT /api/profile error', e);
    res.status(500).json({ error: 'No se pudo actualizar el perfil' });
  }
});

module.exports = router;
