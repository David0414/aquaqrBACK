// src/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Rutas
const walletRoutes   = require('./routes/wallet');
const rechargeRoutes = require('./routes/recharge');
const dispenseRoutes = require('./routes/dispense');
const opsRoutes      = require('./routes/ops');
const webhookRouter  = require('./routes/webhooks');
const qrRoutes       = require('./routes/qr');
const historyRoutes  = require('./routes/history');
const profileRoutes  = require('./routes/profile');
const notificationRoutes = require('./routes/notifications'); // 👈 AQUÍ IMPORTAS EL ROUTER

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

// Healthcheck
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ---------- Rutas API ----------
app.use('/api/qr', qrRoutes);
app.use('/m', qrRoutes);

app.use('/api', walletRoutes);
app.use('/api/recharge', rechargeRoutes);
app.use('/api/dispense', dispenseRoutes);
app.use('/api', historyRoutes);
app.use('/api/notifications', notificationRoutes); // 👈 aquí montas el router correcto
app.use('/api/profile', profileRoutes);
app.use('/ops', opsRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`API on http://localhost:${port}`);
});
