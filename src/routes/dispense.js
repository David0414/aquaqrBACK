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
const DEFAULT_PULSES_PER_LITER = intFromEnv('FLOWMETER_PULSES_PER_LITER', 360);

// Opciones de litros: 1/4, 1/2 y completo.
const LITERS_QUARTER = Math.round((GARRAFON_LITERS / 4) * 10) / 10; // ej. 5.0
const LITERS_HALF = Math.round((GARRAFON_LITERS / 2) * 10) / 10;    // ej. 10.0
const LITERS_FULL = GARRAFON_LITERS;                                // ej. 20
const ALLOWED_LITERS = new Set([LITERS_QUARTER, LITERS_HALF, LITERS_FULL]);
const DEMO_ACTION_TO_COMMAND = Object.freeze({
  bomba_on: '24',
  bomba_off: '25',
  valvula_enjuague_on: '20',
  valvula_enjuague_off: '21',
  valvula_llenado_on: '22',
  valvula_llenado_off: '23',
  apagar_valvulas_forzado: 'FF',
  reiniciar_sistema: '5A',
  inputs: '01',
  recarga_monedas: '05',
  qr_inicio: '10',
  litros_5: '11',
  litros_10: '14',
  litros_20: '15',
  enjuague: '12',
  inicio_dispensado: '13',
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
  const raw = Number.parseInt(process.env.WATERSERVER_CONTROL_TIMEOUT_MS || '10000', 10);
  return Number.isFinite(raw) ? raw : 10000;
}

function sanitizePulsesPerLiter(value, fallback = DEFAULT_PULSES_PER_LITER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 65535);
}

function buildControlCommandLine(command, pulsesPerLiter) {
  const pulses = sanitizePulsesPerLiter(pulsesPerLiter);
  return `${String(command || '').trim().toUpperCase()} ${pulses}`;
}

function monitorPort() {
  const raw = Number.parseInt(process.env.WATERSERVER_MONITOR_PORT || '5002', 10);
  return Number.isFinite(raw) ? raw : 5002;
}

function monitorTimeoutMs() {
  const raw = Number.parseInt(process.env.WATERSERVER_MONITOR_TIMEOUT_MS || '7000', 10);
  return Number.isFinite(raw) ? raw : 7000;
}

function monitorFrameMaxAgeMs() {
  const raw = Number.parseInt(process.env.WATERSERVER_MONITOR_MAX_AGE_MS || '3000', 10);
  return Number.isFinite(raw) ? raw : 3000;
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

let controlQueue = Promise.resolve();

function enqueueControlCommand(command) {
  const run = () => sendControlCommand(command);
  const next = controlQueue.then(run, run);
  controlQueue = next.catch(() => {});
  return next;
}

const monitorState = {
  socket: null,
  buffer: '',
  latestFrame: null,
  waiters: [],
  reconnectTimer: null,
  connecting: false,
};

function isMonitorFrameLine(line) {
  return /E2[\s:-]?[0-9A-F]{2}/i.test(line) && /E3/i.test(line);
}

function resolveMonitorWaiters(frame) {
  const waiters = monitorState.waiters.splice(0);
  waiters.forEach((waiter) => waiter.resolve(frame));
}

function rejectMonitorWaiters(error) {
  const waiters = monitorState.waiters.splice(0);
  waiters.forEach((waiter) => waiter.reject(error));
}

function scheduleMonitorReconnect() {
  if (monitorState.reconnectTimer) return;
  monitorState.reconnectTimer = setTimeout(() => {
    monitorState.reconnectTimer = null;
    ensureMonitorConnection();
  }, 1000);
}

function handleMonitorLine(line) {
  if (!isMonitorFrameLine(line)) return;

  monitorState.latestFrame = {
    response: line,
    lines: [line],
    host: controlHost(),
    port: monitorPort(),
    receivedAt: Date.now(),
  };
  resolveMonitorWaiters(monitorState.latestFrame);
}

function ensureMonitorConnection() {
  if (monitorState.socket || monitorState.connecting) return;

  const host = controlHost();
  const port = monitorPort();
  const socket = new net.Socket();

  monitorState.connecting = true;
  monitorState.buffer = '';
  monitorState.socket = socket;

  socket.setKeepAlive(true, 1000);

  socket.on('connect', () => {
    monitorState.connecting = false;
  });

  socket.on('data', (chunk) => {
    monitorState.buffer += chunk.toString('utf8');
    const parts = monitorState.buffer.split(/\r?\n/);
    monitorState.buffer = parts.pop() || '';

    for (const part of parts) {
      const line = part.trim();
      if (line.length > 0) handleMonitorLine(line);
    }
  });

  socket.on('error', (error) => {
    monitorState.connecting = false;
    rejectMonitorWaiters(error);
    socket.destroy();
  });

  socket.on('close', () => {
    monitorState.connecting = false;
    monitorState.socket = null;
    scheduleMonitorReconnect();
  });

  socket.connect(port, host);
}

function readMonitorFrame() {
  const timeoutMs = monitorTimeoutMs();
  ensureMonitorConnection();

  if (
    monitorState.latestFrame
    && Date.now() - monitorState.latestFrame.receivedAt <= monitorFrameMaxAgeMs()
  ) {
    return Promise.resolve(monitorState.latestFrame);
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: (frame) => {
        clearTimeout(waiter.timer);
        resolve(frame);
      },
      reject: (error) => {
        clearTimeout(waiter.timer);
        reject(error);
      },
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      monitorState.waiters = monitorState.waiters.filter((item) => item !== waiter);
      reject(new Error(`Timeout al escuchar monitor waterserver (${timeoutMs}ms)`));
    }, timeoutMs);

    monitorState.waiters.push(waiter);
  });
}

async function sendDemoAction(action, pulsesPerLiter) {
  const command = DEMO_ACTION_TO_COMMAND[action];
  if (!command) {
    const error = new Error('Accion demo invalida');
    error.statusCode = 400;
    error.allowedActions = Object.keys(DEMO_ACTION_TO_COMMAND);
    throw error;
  }

  const safePulsesPerLiter = sanitizePulsesPerLiter(pulsesPerLiter);
  const commandLine = buildControlCommandLine(command, safePulsesPerLiter);
  const out = await enqueueControlCommand(commandLine);
  return {
    action,
    command,
    commandLine,
    pulsesPerLiter: safePulsesPerLiter,
    ...out,
  };
}

/* ----------------------------------------------------------------------------- */
/* POST /api/dispense                                                            */
/* Body: { liters:number, machineId?:string, location?:string }                  */
/* ----------------------------------------------------------------------------- */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { liters, machineId, location, pulsesPerLiter } = req.body || {};
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

    // Inicia el llenado en el equipo, pero no descuenta saldo todavia.
    // El cobro se confirma cuando la telemetria reporta proceso finalizado.
    const safePulsesPerLiter = sanitizePulsesPerLiter(pulsesPerLiter);
    await enqueueControlCommand(buildControlCommandLine(DEMO_ACTION_TO_COMMAND.inicio_dispensado, safePulsesPerLiter));

    const dispense = await prisma.dispense.create({
      data: {
        userId,
        liters: ltrs,
        pricePerLiterCents,
        totalCents,
        currency: CURRENCY,
        status: 'STARTED',
        machineId: machineId || null,
        machineLocation: location || null,
      },
    });

    return res.json({
      ok: true,
      status: 'STARTED',
      txId: dispense.id,
      liters: ltrs,
      pricePerLiterCents,
      amountCents: totalCents,
      totalCents,
      currency: CURRENCY,
      pulsesPerLiter: safePulsesPerLiter,
      prevBalanceCents: wallet.balanceCents,
      newBalanceCents: wallet.balanceCents,
    });
  } catch (e) {
    console.error('POST /api/dispense error', e);
    return res.status(500).json({ error: 'No se pudo iniciar el dispensado' });
  }
});

/* ----------------------------------------------------------------------------- */
/* POST /api/dispense/complete                                                   */
/* Body: { txId:string }                                                         */
/* ----------------------------------------------------------------------------- */
router.post('/complete', requireAuth, async (req, res) => {
  try {
    const { txId } = req.body || {};
    const { userId } = req.auth;
    const id = String(txId || '').trim();

    if (!id) {
      return res.status(400).json({ error: 'txId requerido' });
    }

    await ensureUserAndWallet(userId);

    const existing = await prisma.dispense.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Dispensado no encontrado' });
    }

    if (existing.status === 'COMPLETED') {
      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      return res.json({
        ok: true,
        alreadyCompleted: true,
        status: existing.status,
        txId: existing.id,
        liters: existing.liters,
        pricePerLiterCents: existing.pricePerLiterCents,
        amountCents: existing.totalCents,
        totalCents: existing.totalCents,
        currency: existing.currency,
        newBalanceCents: wallet?.balanceCents ?? 0,
      });
    }

    if (existing.status !== 'STARTED') {
      return res.status(409).json({
        error: `No se puede completar un dispensado en estado ${existing.status}`,
        status: existing.status,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.dispense.updateMany({
        where: { id: existing.id, userId, status: 'STARTED' },
        data: { status: 'COMPLETED' },
      });

      if (claimed.count !== 1) {
        const current = await tx.dispense.findUnique({ where: { id: existing.id } });
        return { alreadyCompleted: current?.status === 'COMPLETED' };
      }

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        const error = new Error('Wallet no encontrada');
        error.statusCode = 500;
        throw error;
      }

      if (wallet.balanceCents < existing.totalCents) {
        const error = new Error('INSUFFICIENT_FUNDS');
        error.statusCode = 400;
        error.code = 'INSUFFICIENT_FUNDS';
        error.neededCents = existing.totalCents - wallet.balanceCents;
        error.balanceCents = wallet.balanceCents;
        error.totalCents = existing.totalCents;
        throw error;
      }

      const updatedWallet = await tx.wallet.update({
        where: { userId },
        data: { balanceCents: { decrement: existing.totalCents } },
      });

      const ledger = await tx.ledgerEntry.create({
        data: {
          userId,
          type: 'DEBIT',
          amountCents: existing.totalCents,
          currency: existing.currency,
          description: `Dispensado de agua • ${existing.liters}L`,
          source: `DISPENSE:${existing.id}`,
          externalId: `DISPENSE:${existing.id}`,
          status: 'POSTED',
        },
      });

      return {
        alreadyCompleted: false,
        newBalanceCents: updatedWallet.balanceCents,
        ledgerId: ledger.id,
      };
    });

    const wallet = result.alreadyCompleted
      ? await prisma.wallet.findUnique({ where: { userId } })
      : null;

    if (!result.alreadyCompleted) {
      sendUserNotification(userId, {
        type: 'dispense',
        amountCents: existing.totalCents,
        liters: existing.liters,
      }).catch((errNotif) => {
        console.error('[Dispense] Error enviando notificacion', errNotif);
      });
    }

    return res.json({
      ok: true,
      alreadyCompleted: result.alreadyCompleted,
      status: 'COMPLETED',
      txId: existing.id,
      liters: existing.liters,
      pricePerLiterCents: existing.pricePerLiterCents,
      amountCents: existing.totalCents,
      totalCents: existing.totalCents,
      currency: existing.currency,
      newBalanceCents: result.newBalanceCents ?? wallet?.balanceCents ?? 0,
      ledgerId: result.ledgerId,
    });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({
        error: 'INSUFFICIENT_FUNDS',
        neededCents: e.neededCents,
        balanceCents: e.balanceCents,
        totalCents: e.totalCents,
      });
    }

    console.error('POST /api/dispense/complete error', e);
    return res.status(e.statusCode || 500).json({
      error: e.message || 'No se pudo completar el dispensado',
    });
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
  const optionsLiters = Array.from(ALLOWED_LITERS);
  res.json({
    currency: CURRENCY,
    garrafonLiters: GARRAFON_LITERS,
    pricePerGarrafonCents: PRICE_PER_GARRAFON_CENTS,
    pricePerLiterCents: PRICE_PER_LITER_CENTS,
    optionsLiters,
    allowedLiters: optionsLiters,
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
    const out = await sendDemoAction(action, req.body?.pulsesPerLiter);
    return res.json({ ok: true, ...out });
  } catch (e) {
    if (e.statusCode === 400) {
      return res.status(400).json({
        error: e.message,
        ...(e.allowedActions ? { allowedActions: e.allowedActions } : {}),
      });
    }
    console.error('POST /api/dispense/demo/control error', e);
    return res.status(502).json({
      error: 'No se pudo contactar waterserver',
      detail: e.message,
    });
  }
});

router.get('/demo/monitor', requireAuth, async (_req, res) => {
  try {
    const out = await readMonitorFrame();
    return res.json({
      ok: true,
      source: 'monitor',
      ...out,
    });
  } catch (e) {
    console.error('GET /api/dispense/demo/monitor error', e);
    return res.status(502).json({
      error: 'No se pudo escuchar el monitor waterserver',
      detail: e.message,
    });
  }
});

module.exports = router;
