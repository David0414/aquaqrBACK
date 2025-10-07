// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const walletRoutes = require('./routes/wallet');
const rechargeRoutes = require('./routes/recharge');
const dispenseRoutes = require('./routes/dispense');
const opsRoutes = require('./routes/ops');
const webhookRouter = require('./routes/webhooks');

// 👇 FALTA ESTO
const historyRoutes = require('./routes/history');

const profileRoutes = require('./routes/profile');


const app = express();

// CORS
app.use(cors({
  origin: process.env.APP_BASE_URL || 'http://localhost:5173',
  credentials: true,
}));

// 1) WEBHOOKS con RAW
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRouter);

// 2) Resto con JSON
app.use(express.json());

app.get('/api/health', (_, res) => res.json({ ok: true }));

// Rutas API
app.use('/api', walletRoutes);
app.use('/api/recharge', rechargeRoutes);
app.use('/api/dispense', dispenseRoutes);

// 👇 MONTA EL HISTORIAL EN /api  => endpoint final: GET /api/history
app.use('/api', historyRoutes);

app.use('/api/profile', profileRoutes);


app.use('/ops', opsRoutes); // protegido con x-admin-token

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`API on http://localhost:${port}`);
});
