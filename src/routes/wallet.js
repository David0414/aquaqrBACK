// src/routes/wallet.js
const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { requireAuth } = require('../utils/auth'); // tu middleware que llena req.auth

// GET /api/me/wallet → devuelve saldo y crea user/wallet si no existen
router.get('/me/wallet', requireAuth, async (req, res) => {
  try {
    const { userId, email, name } = req.auth; // lo pone requireAuth

    // 1) Asegura usuario
    await prisma.user.upsert({
      where: { id: userId },
      update: { email, name },
      create: { id: userId, email, name },
    });

    // 2) Asegura wallet 1:1
    const wallet = await prisma.wallet.upsert({
      where: { userId },      // <- requiere userId @unique en Wallet
      update: {},
      create: { userId, balanceCents: 0 },
    });

    return res.json({ balanceCents: wallet.balanceCents });
  } catch (e) {
    console.error('GET /me/wallet error', e);
    return res.status(500).json({ error: 'DB error', detail: e.message });
  }
});

module.exports = router;
