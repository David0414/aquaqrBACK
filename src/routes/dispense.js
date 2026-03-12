// src/routes/dispense.js
const express = require('express');
const router = express.Router();
const net = require('net');

const { prisma } = require('../db');           // 👈 usa el singleton SIEMPRE
const { requireAuth } = require('../utils/auth');
const { sendUserNotification } = require('../utils/notifications');

/* ----------------------------------------------------------------------------- */
/* Config desde .env                                                             */
/* ----------------------------------------------------------------------------- */
function intFromEnv(name, fallback) {
  const v = process.env[name];
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const CURRENCY = (process.env.CURRENCY || 'mxn').toUpperCase();

const GARRAFON_LITERS = intFromEnv('GARRAFON_LITERS', 20);                     // 20 L
const PRICE_PER_GARRAFON_CENTS = intFromEnv('PRICE_PER_GARRAFON_CENTS', 3500); // $35.00
const ENV_PPL = intFromEnv('PRICE_PER_LITER_CENTS', NaN);

// Si se define PRICE_PER_LITER_CENTS en .env se respeta, si no, se calcula.
const PRICE_PER_LITER_CENTS = Number.isFinite(ENV_PPL)
  ? ENV_PPL
  : Math.round(PRICE_PER_GARRAFON_CENTS / GARRAFON_LITERS);

// Opciones de litros: 1/4, 1/2 y completo.
const LITERS_QUARTER = Math.round((GARRAFON_LITERS / 4) * 10) / 10; // ej. 5.0
const LITERS_HALF = Math.round((GARRAFON_LITERS / 2) * 10) / 10;    // ej. 10.0
const LITERS_FULL = GARRAFON_LITERS;                                // ej. 20
const ALLOWED_LITERS = new Set([LITERS_QUARTER, LITERS_HALF, LITERS_FULL]);
const DEMO_ACTION_TO_COMMAND = Object.freeze({
  bomba_on: '1',
  bomba_off: '0',
  valvula_enjuague_on: '3',
  valvula_enjuague_off: '4',
  valvula_llenado_on: '5',
  valvula_llenado_off: '6',
  inputs: '7',
  qr_inicio: '1',
  litros_5: '0',
  litros_10: '3',
  litros_20: '4',
  enjuague: '5',
  inicio_dispensado: '6',
});

/* ----------------------------------------------------------------------------- */
/* Utils                                                                         */
/* ----------------------------------------------------------------------------- */
async function ensureUserAndWallet(userId) {
  // Crea User/Wallet si no existen (id = userId de Clerk, está bien que no sea cuid)
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
  });

  await prisma.wallet.upsert({
    where: { userId },
    update: {},
    create: { userId, balanceCents: 0 },
  });
}

function totalForLiters(ltrs) {
  // total en centavos, entero
  return Math.round(ltrs * PRICE_PER_LITER_CENTS);
}

function mapDispenseStatus(s) {
  switch (s) {
    case 'STARTED':
      return 'pending';
    case 'FAILED':
      return 'failed';
    case 'CANCELED':
      return 'cancelled';
    case 'COMPLETED':
    default:
      return 'completed';
  }
}

function controlHost() {
  return process.env.WATERSERVER_HOST || '127.0.0.1';
}

function controlPort() {
  const raw = Number.parseInt(process.env.WATERSERVER_CONTROL_PORT || '5003', 10);
  return Number.isFinite(raw) ? raw : 5003;
}

function controlTimeoutMs() {
  const raw = Number.parseInt(process.env.WATERSERVER_CONTROL_TIMEOUT_MS || '4000', 10);
  return Number.isFinite(raw) ? raw : 4000;
}

function sendControlCommand(command) {
  const host = controlHost();
  const port = controlPort();
  const timeoutMs = controlTimeoutMs();

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const lines = [];
    let buffer = '';
    let settled = false;

    const finish = (err, payload) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(payload);
    };

    socket.setTimeout(timeoutMs);

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.trim();
        if (line.length > 0) lines.push(line);
      }
      if (lines.length >= 2) {
        finish(null, {
          welcome: lines[0] || null,
          response: lines[lines.length - 1] || null,
          lines,
          host,
          port,
        });
      }
    });

    socket.on('timeout', () => {
      finish(new Error(`Timeout al conectar/controlar waterserver (${timeoutMs}ms)`));
    });

    socket.on('error', (err) => {
      finish(err);
    });

    socket.on('close', () => {
      if (settled) return;
      if (buffer.trim().length > 0) lines.push(buffer.trim());
      if (lines.length === 0) {
        finish(new Error('Sin respuesta del waterserver'));
        return;
      }
      finish(null, {
        welcome: lines[0] || null,
        response: lines[lines.length - 1] || null,
        lines,
        host,
        port,
      });
    });

    socket.connect(port, host, () => {
      socket.write(`${command}\n`, 'utf8');
    });
  });
}

/* ----------------------------------------------------------------------------- */
/* POST /api/dispense                                                            */
/* Body: { liters:number, machineId?:string, location?:string }                  */
/* ----------------------------------------------------------------------------- */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { liters, machineId, location } = req.body || {};
    const { userId } = req.auth;

    const ltrs = Number(liters);
    if (!ALLOWED_LITERS.has(ltrs)) {
      return res.status(400).json({
        error: 'Litros inválidos',
        allowed: Array.from(ALLOWED_LITERS),
      });
    }

    const pricePerLiterCents = PRICE_PER_LITER_CENTS;
    const totalCents = totalForLiters(ltrs);

    await ensureUserAndWallet(userId);
    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return res.status(500).json({ error: 'Wallet no encontrada' });
    }

    if (wallet.balanceCents < totalCents) {
      return res.status(400).json({
        error: 'INSUFFICIENT_FUNDS',
        neededCents: totalCents - wallet.balanceCents,
        balanceCents: wallet.balanceCents,
        totalCents,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1) Debita saldo del wallet
      const w = await tx.wallet.update({
        where: { userId },
        data: { balanceCents: { decrement: totalCents } },
      });

      // 2) Asiento contable (DEBIT) para auditoría
      const ledger = await tx.ledgerEntry.create({
        data: {
          userId,
          type: 'DEBIT',
          amountCents: totalCents,
          currency: CURRENCY,
          description: `Dispensado de agua • ${ltrs}L`,
          source: `DISPENSE${machineId ? `:${machineId}` : ''}${
            location ? `@${location}` : ''
          }`,
          status: 'POSTED',
        },
      });

      // 3) Registro en DISPENSE
      const dispense = await tx.dispense.create({
        data: {
          userId,
          liters: ltrs,
          pricePerLiterCents,
          totalCents,
          currency: CURRENCY,
          status: 'COMPLETED',
          machineId: machineId || null,
          machineLocation: location || null,
        },
      });

      return {
        newBalanceCents: w.balanceCents,
        ledgerId: ledger.id,
        dispense,
      };
    });

    // 👉 NOTIFICACIÓN *NO BLOQUEANTE* (no usamos await)
    //    Si Brevo tarda 1 minuto, tu endpoint responde igual en milisegundos.
    sendUserNotification(userId, {
      type: 'dispense',
      amountCents: totalCents,
      liters: ltrs,
    }).catch((errNotif) => {
      console.error('[Dispense] Error enviando notificación', errNotif);
    });

    // Respuesta rápida al cliente
    return res.json({
      ok: true,
      liters: ltrs,
      pricePerLiterCents,
      totalCents,
      currency: CURRENCY,
      newBalanceCents: result.newBalanceCents,
    });
  } catch (e) {
    console.error('POST /api/dispense error', e);
    return res.status(500).json({ error: 'No se pudo registrar el dispensado' });
  }
});

/* ----------------------------------------------------------------------------- */
/* GET /api/dispense/history?limit=20&cursor=<id>                                */
/* ----------------------------------------------------------------------------- */
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const cursor = req.query.cursor || null;

    const rows = await prisma.dispense.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const items = page.map((d) => ({
      id: d.id,
      type: 'dispensing',
      description: d.description || `Dispensado de agua • ${d.liters}L`,
      amount: (d.totalCents || 0) / 100,
      currency: (d.currency || 'MXN').toUpperCase(),
      date: d.createdAt,
      status: mapDispenseStatus(d.status),
      liters: d.liters,
      machineId: d.machineId || undefined,
      machineLocation: d.machineLocation || undefined,
    }));

    res.json({
      items,
      hasMore,
      nextCursor: hasMore ? rows[limit].id : null,
    });
  } catch (e) {
    console.error('GET /api/dispense/history error', e);
    res
      .status(500)
      .json({ error: 'No se pudo obtener el historial de dispensados' });
  }
});

/* ----------------------------------------------------------------------------- */
/* GET /api/dispense/config (pública)                                            */
/* ----------------------------------------------------------------------------- */
router.get('/config', (_req, res) => {
  res.json({
    currency: CURRENCY,
    garrafonLiters: GARRAFON_LITERS,
    pricePerGarrafonCents: PRICE_PER_GARRAFON_CENTS,
    pricePerLiterCents: PRICE_PER_LITER_CENTS,
    optionsLiters: Array.from(ALLOWED_LITERS),
  });
});

/* ----------------------------------------------------------------------------- */
/* GET /api/dispense/quote?liters=10  (pública)                                  */
/* ----------------------------------------------------------------------------- */
router.get('/quote', (req, res) => {
  const ltrs = Number(req.query.liters || 0);
  if (!ALLOWED_LITERS.has(ltrs)) {
    return res.status(400).json({
      error: 'Litros inválidos',
      allowed: Array.from(ALLOWED_LITERS),
    });
  }
  const totalCents = totalForLiters(ltrs);
  res.json({
    liters: ltrs,
    totalCents,
    currency: CURRENCY,
    pricePerLiterCents: PRICE_PER_LITER_CENTS,
  });
});

/* ----------------------------------------------------------------------------- */
/* POST /api/dispense/demo/control                                               */
/* Body: { action: 'bomba_on' | ... }                                            */
/* ----------------------------------------------------------------------------- */
router.post('/demo/control', requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const command = DEMO_ACTION_TO_COMMAND[action];

    if (!command) {
      return res.status(400).json({
        error: 'Accion demo invalida',
        allowedActions: Object.keys(DEMO_ACTION_TO_COMMAND),
      });
    }

    const out = await sendControlCommand(command);
    return res.json({
      ok: true,
      action,
      command,
      ...out,
    });
  } catch (e) {
    console.error('POST /api/dispense/demo/control error', e);
    return res.status(502).json({
      error: 'No se pudo contactar waterserver',
      detail: e.message,
    });
  }
});

module.exports = router;
