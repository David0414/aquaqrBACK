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
const MACHINE_LOCK_TTL_MS = intFromEnv('MACHINE_LOCK_TTL_MS', 20 * 60 * 1000);

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

function normalizeMachineId(value) {
  const machineId = String(value || '').trim();
  return machineId || null;
}

function normalizeHardwareId(value) {
  const hardwareId = String(value || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!hardwareId) return null;
  return hardwareId.padStart(2, '0').slice(-2);
}

function machineLockExpiresAt() {
  return new Date(Date.now() + MACHINE_LOCK_TTL_MS);
}

function isActiveLock(lock, now = new Date()) {
  return Boolean(lock && lock.expiresAt > now);
}

async function findMachineLockConflict(machineId, hardwareId, userId) {
  const now = new Date();
  const where = [];

  if (machineId) where.push({ machineId });
  if (hardwareId) where.push({ hardwareId });
  if (where.length === 0) return null;

  const locks = await prisma.machineLock.findMany({
    where: { OR: where },
    orderBy: { updatedAt: 'desc' },
  });

  return locks.find((lock) => isActiveLock(lock, now) && lock.userId !== userId) || null;
}

async function findOwnMachineLock(machineId, hardwareId, userId) {
  const now = new Date();
  const where = [];

  if (machineId) where.push({ machineId });
  if (hardwareId) where.push({ hardwareId });
  if (where.length === 0) return null;

  const locks = await prisma.machineLock.findMany({
    where: {
      userId,
      OR: where,
    },
    orderBy: { updatedAt: 'desc' },
  });

  return locks.find((lock) => isActiveLock(lock, now)) || null;
}

function throwMachineBusy(lock, userId) {
  const error = new Error(
    lock.userId === userId
      ? 'Esta maquina ya tiene un proceso activo con tu usuario'
      : 'Esta maquina esta en uso por otro usuario'
  );
  error.statusCode = 423;
  error.code = 'MACHINE_BUSY';
  error.machineId = lock.machineId;
  error.expiresAt = lock.expiresAt;
  error.isOwnLock = lock.userId === userId;
  throw error;
}

async function acquireMachineLock(machineIdValue, userId, options = {}) {
  const machineId = normalizeMachineId(machineIdValue);
  const hardwareId = options.hardwareId === undefined
    ? undefined
    : normalizeHardwareId(options.hardwareId);
  if (!machineId && !hardwareId) return null;

  const now = new Date();
  const expiresAt = machineLockExpiresAt();
  const txId = options.txId === undefined ? undefined : options.txId;
  const machineLocation = options.machineLocation === undefined
    ? undefined
    : String(options.machineLocation || '').trim() || null;
  const selectedLiters = options.selectedLiters === undefined
    ? undefined
    : Number(options.selectedLiters);
  const safeSelectedLiters =
    Number.isFinite(selectedLiters) && selectedLiters > 0 ? selectedLiters : null;

  const conflict = await findMachineLockConflict(machineId, hardwareId, userId);
  if (conflict) {
    throwMachineBusy(conflict, userId);
  }
  const ownLock = await findOwnMachineLock(machineId, hardwareId, userId);
  const lockMachineId = machineId || ownLock?.machineId;
  if (!lockMachineId) return null;

  try {
    return await prisma.machineLock.upsert({
      where: { machineId: lockMachineId },
      update: {
        userId,
        expiresAt,
        ...(txId !== undefined ? { txId } : {}),
        ...(hardwareId !== undefined ? { hardwareId } : {}),
        ...(machineLocation !== undefined ? { machineLocation } : {}),
        ...(options.selectedLiters !== undefined ? { selectedLiters: safeSelectedLiters } : {}),
      },
      create: {
        machineId: lockMachineId,
        userId,
        expiresAt,
        ...(txId !== undefined ? { txId } : {}),
        ...(hardwareId !== undefined ? { hardwareId } : {}),
        ...(machineLocation !== undefined ? { machineLocation } : {}),
        ...(options.selectedLiters !== undefined ? { selectedLiters: safeSelectedLiters } : {}),
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      const lock = await findMachineLockConflict(lockMachineId, hardwareId, userId);
      if (lock && lock.expiresAt > now && lock.userId !== userId) {
        throwMachineBusy(lock, userId);
      }
    }
    throw error;
  }
}

async function requireMachineLockOwner(machineIdValue, userId, options = {}) {
  const machineId = normalizeMachineId(machineIdValue);
  const hardwareId = normalizeHardwareId(options.hardwareId);
  if (!machineId && !hardwareId) return null;

  const now = new Date();
  const conflict = await findMachineLockConflict(machineId, hardwareId, userId);
  if (conflict) {
    throwMachineBusy(conflict, userId);
  }

  const lock = await findOwnMachineLock(machineId, hardwareId, userId);
  if (!lock || lock.expiresAt <= now) {
    return acquireMachineLock(machineId, userId, options);
  }
  if (lock.userId !== userId) {
    throwMachineBusy(lock, userId);
  }
  return acquireMachineLock(lock.machineId || machineId, userId, {
    txId: lock.txId,
    hardwareId: hardwareId ?? lock.hardwareId,
    machineLocation: options.machineLocation ?? lock.machineLocation,
    selectedLiters: options.selectedLiters ?? lock.selectedLiters,
  });
}

async function releaseMachineLock(machineIdValue, userId) {
  const machineId = normalizeMachineId(machineIdValue);
  if (!machineId) return;
  await prisma.machineLock.deleteMany({ where: { machineId, userId } });
}

function sendMachineBusy(res, error) {
  return res.status(423).json({
    error: 'MACHINE_BUSY',
    message: error.message || 'Esta maquina esta ocupada',
    machineId: error.machineId,
    expiresAt: error.expiresAt,
    isOwnLock: Boolean(error.isOwnLock),
  });
}

function litersFromAction(action) {
  switch (action) {
    case 'litros_5':
      return 5;
    case 'litros_10':
      return 10;
    case 'litros_20':
      return 20;
    default:
      return undefined;
  }
}

function activePathForStage(stageCode, hasTx) {
  if (hasTx || stageCode === '06' || stageCode === '07') return '/filling-progress';
  if (stageCode === '03' || stageCode === '04') return '/water/position-down';
  if (stageCode === '05') return '/water/position-up';
  return '/water/choose';
}

async function completeStartedDispense(existing, source = 'api') {
  if (!existing) {
    return { completed: false, reason: 'missing-dispense' };
  }

  if (existing.status === 'COMPLETED') {
    return { completed: false, alreadyCompleted: true };
  }

  if (existing.status !== 'STARTED') {
    return { completed: false, reason: `status-${existing.status}` };
  }

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.dispense.updateMany({
      where: { id: existing.id, userId: existing.userId, status: 'STARTED' },
      data: { status: 'COMPLETED' },
    });

    if (claimed.count !== 1) {
      const current = await tx.dispense.findUnique({ where: { id: existing.id } });
      return { alreadyCompleted: current?.status === 'COMPLETED' };
    }

    const wallet = await tx.wallet.findUnique({ where: { userId: existing.userId } });
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
      where: { userId: existing.userId },
      data: { balanceCents: { decrement: existing.totalCents } },
    });

    const ledger = await tx.ledgerEntry.create({
      data: {
        userId: existing.userId,
        type: 'DEBIT',
        amountCents: existing.totalCents,
        currency: existing.currency,
        description: `Dispensado de agua - ${existing.liters}L`,
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

  await releaseMachineLock(existing.machineId, existing.userId);

  if (!result.alreadyCompleted) {
    sendUserNotification(existing.userId, {
      type: 'dispense',
      amountCents: existing.totalCents,
      liters: existing.liters,
    }).catch((errNotif) => {
      console.error(`[Dispense] Error enviando notificacion (${source})`, errNotif);
    });
  }

  return { completed: true, ...result };
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
const autoCompleteInFlight = new Set();

function isMonitorFrameLine(line) {
  return /E2[\s:-]?[0-9A-F]{2}/i.test(line) && /E3/i.test(line);
}

function extractMonitorFrameBytes(line) {
  const matches = String(line || '').toUpperCase().match(/[0-9A-F]{2}/g) || [];
  for (let index = 0; index <= matches.length - 15; index += 1) {
    const chunk = matches.slice(index, index + 15);
    if (chunk[0] === 'E2' && chunk[14] === 'E3') return chunk;
  }
  return null;
}

function parseMonitorTelemetry(line) {
  const bytes = extractMonitorFrameBytes(line);
  if (!bytes) return null;
  return {
    machineHardwareId: normalizeHardwareId(bytes[1]),
    currentStageCode: normalizeHardwareId(bytes[9]) || '00',
    rawFrame: bytes.join('-'),
  };
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
  const parsed = parseMonitorTelemetry(line);

  monitorState.latestFrame = {
    response: line,
    lines: [line],
    host: controlHost(),
    port: monitorPort(),
    receivedAt: Date.now(),
  };
  resolveMonitorWaiters(monitorState.latestFrame);

  maybeCompleteDispenseFromTelemetry(parsed).catch((error) => {
    console.error('[Dispense] Error en cierre automatico por telemetria', error);
  });
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

async function findLockForTelemetry(machineHardwareId) {
  const now = new Date();
  if (machineHardwareId) {
    const lock = await prisma.machineLock.findFirst({
      where: {
        hardwareId: machineHardwareId,
        txId: { not: null },
        expiresAt: { gt: now },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (lock) return lock;
  }

  const locks = await prisma.machineLock.findMany({
    where: {
      txId: { not: null },
      expiresAt: { gt: now },
    },
    orderBy: { updatedAt: 'desc' },
    take: 2,
  });

  return locks.length === 1 ? locks[0] : null;
}

async function maybeCompleteDispenseFromTelemetry(parsed) {
  if (!parsed) return;
  if (parsed.currentStageCode !== '07') return;

  const lock = await findLockForTelemetry(parsed.machineHardwareId);
  if (!lock?.txId) return;
  if (autoCompleteInFlight.has(lock.txId)) return;

  autoCompleteInFlight.add(lock.txId);
  try {
    const existing = await prisma.dispense.findFirst({
      where: {
        id: lock.txId,
        userId: lock.userId,
        status: 'STARTED',
      },
    });
    if (!existing) {
      await releaseMachineLock(lock.machineId, lock.userId);
      return;
    }

    const result = await completeStartedDispense(existing, 'telemetry');
    if (result.completed || result.alreadyCompleted) {
      console.log(`[Dispense] Cierre automatico por telemetria: ${existing.id}`);
    }
  } finally {
    autoCompleteInFlight.delete(lock.txId);
  }
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
    const { liters, machineId, location, pulsesPerLiter, hardwareId } = req.body || {};
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
    const safeMachineId = normalizeMachineId(machineId);

    await ensureUserAndWallet(userId);
    await requireMachineLockOwner(safeMachineId, userId, {
      hardwareId,
      machineLocation: location,
      selectedLiters: ltrs,
    });

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
        machineId: safeMachineId,
        machineLocation: location || null,
      },
    });

    await acquireMachineLock(safeMachineId, userId, {
      txId: dispense.id,
      hardwareId,
      machineLocation: location,
      selectedLiters: ltrs,
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
    if (e.code === 'MACHINE_BUSY') {
      return sendMachineBusy(res, e);
    }

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
      await releaseMachineLock(existing.machineId, userId);
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

    await releaseMachineLock(existing.machineId, userId);

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
/* GET /api/dispense/active                                                      */
/* ----------------------------------------------------------------------------- */
router.get('/active', requireAuth, async (req, res) => {
  try {
    const { userId } = req.auth;
    const now = new Date();
    const lock = await prisma.machineLock.findFirst({
      where: {
        userId,
        expiresAt: { gt: now },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!lock) {
      return res.json({ ok: true, active: false });
    }

    const stageCode = parseMonitorTelemetry(monitorState.latestFrame?.response)?.currentStageCode || null;
    const dispense = lock.txId
      ? await prisma.dispense.findFirst({
          where: { id: lock.txId, userId },
        })
      : null;
    const pricePerLiter = PRICE_PER_LITER_CENTS / 100;
    const selectedLiters = dispense?.liters ?? lock.selectedLiters ?? LITERS_FULL;
    const tx = dispense
      ? {
          at: dispense.createdAt?.getTime?.() || Date.now(),
          completedAt: dispense.updatedAt?.getTime?.() || undefined,
          liters: dispense.liters,
          pricePerLiter,
          amountCents: dispense.totalCents,
          prevBalanceCents: undefined,
          newBalanceCents: undefined,
          machineId: dispense.machineId || lock.machineId,
          location: dispense.machineLocation || lock.machineLocation || undefined,
          startPulseCount: 0,
          pulsesPerLiter: DEFAULT_PULSES_PER_LITER,
          txId: dispense.id,
          status: dispense.status,
        }
      : null;

    return res.json({
      ok: true,
      active: true,
      machineId: lock.machineId,
      machineLocation: lock.machineLocation,
      hardwareId: lock.hardwareId,
      selectedLiters,
      stageCode,
      tx,
      nextPath: activePathForStage(stageCode, Boolean(tx)),
      expiresAt: lock.expiresAt,
    });
  } catch (e) {
    console.error('GET /api/dispense/active error', e);
    return res.status(500).json({ error: 'No se pudo consultar la sesion activa' });
  }
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
    const machineId = normalizeMachineId(req.body?.machineId);
    const hardwareId = normalizeHardwareId(req.body?.hardwareId);
    const { userId } = req.auth;

    await ensureUserAndWallet(userId);
    if (action === 'qr_inicio') {
      await acquireMachineLock(machineId, userId, {
        hardwareId,
        machineLocation: req.body?.machineLocation,
      });
    } else if (action !== 'inputs' && action !== 'recarga_monedas') {
      await requireMachineLockOwner(machineId, userId, {
        hardwareId,
        machineLocation: req.body?.machineLocation,
        selectedLiters: litersFromAction(action),
      });
    }

    const out = await sendDemoAction(action, req.body?.pulsesPerLiter);
    return res.json({ ok: true, ...out });
  } catch (e) {
    if (e.code === 'MACHINE_BUSY') {
      return sendMachineBusy(res, e);
    }

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

setImmediate(() => {
  try {
    ensureMonitorConnection();
  } catch (error) {
    console.error('[Dispense] No se pudo iniciar monitor automatico', error);
  }
});

module.exports = router;
