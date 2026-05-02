// src/server.js
require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException', error);
});

const express = require('express');
const cors = require('cors');
const path = require('path');

// Rutas
const walletRoutes   = require('./routes/wallet');
const rechargeRoutes = require('./routes/recharge');
const dispenseRoutes = require('./routes/dispense');
const opsRoutes      = require('./routes/ops');
const webhookRouter  = require('./routes/webhooks');
const rewardsRoutes  = require('./routes/rewards');
const monitorAdminRoutes = require('./routes/monitorAdmin');
const telemetryRoutes = require('./routes/telemetry');

// ✅ CORREGIDO: server.js ya está dentro de src/, así que no va './src/...'
const qrRoutes       = require('./routes/qr');

// (si ya existen en tu repo)
const historyRoutes  = require('./routes/history');
const profileRoutes  = require('./routes/profile');

const app = express();

// CORS
app.use(cors({
  origin: process.env.APP_BASE_URL || 'http://localhost:5173',
  credentials: true,
}));

// 1) WEBHOOKS con RAW (antes de express.json)
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRouter);

// 2) Resto con JSON
app.use(express.json());
app.use('/stickers', express.static(path.join(__dirname, '..', 'stickers')));

// Healthcheck
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ---------- Rutas API ----------
app.use('/api/qr', qrRoutes);

// ✅ Usa `use` para montar el router bajo /m
//    Si tu router de QR expone router.get('/') como “redirector público”,
//    entonces GET /m?m=...&sig=... caerá aquí y redirigirá al FRONT.
app.use('/m', qrRoutes);

app.use('/api', walletRoutes);
app.use('/api/recharge', rechargeRoutes);
app.use('/api/dispense', dispenseRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/monitor-admin', monitorAdminRoutes);
app.use('/api/telemetry', telemetryRoutes);

// Historial (ej: GET /api/history)
app.use('/api', historyRoutes);

// Perfil de usuario
app.use('/api/profile', profileRoutes);

// Rutas de operaciones (protegidas con x-admin-token)
app.use('/ops', opsRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`API on http://localhost:${port}`);
});
