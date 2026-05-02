const express = require('express');
const { prisma } = require('../db');
const { requireAuthOrMonitorAdmin } = require('../utils/monitorAdmin');
const { ingestTelemetry, getTelemetryByHardwareId, normalizeHardwareId } = require('../utils/telemetryStore');

const router = express.Router();

function normalizeMachineId(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z_-]/g, '');
}

router.post('/push', async (req, res) => {
  try {
    const hardwareId = normalizeHardwareId(req.body?.hardwareId);
    const rawFrame = String(req.body?.rawFrame || '').trim();
    if (!hardwareId || !rawFrame) {
      return res.status(400).json({ error: 'hardwareId y rawFrame son requeridos' });
    }

    const telemetry = ingestTelemetry({
      hardwareId,
      rawFrame,
      receivedAt: req.body?.receivedAt,
      source: 'csharp-http',
    });

    if (!telemetry) {
      return res.status(400).json({ error: 'No se pudo interpretar la trama recibida' });
    }

    return res.json({ ok: true, telemetry });
  } catch (error) {
    console.error('POST /api/telemetry/push error', error);
    return res.status(500).json({ error: 'No se pudo recibir la telemetria' });
  }
});

router.get('/machine/:machineId', requireAuthOrMonitorAdmin, async (req, res) => {
  try {
    const machineId = normalizeMachineId(req.params.machineId);
    if (!machineId) {
      return res.status(400).json({ error: 'machineId invalido' });
    }

    const machine = await prisma.machine.findUnique({ where: { id: machineId } });
    const hardwareId = normalizeHardwareId(machine?.hardwareId || machineId);
    const telemetry = getTelemetryByHardwareId(hardwareId);

    if (!telemetry) {
      return res.json({
        ok: true,
        machineId,
        hardwareId,
        machineOnline: false,
        lastSeenAt: null,
        rawFrame: '',
        currentStageCode: '00',
        phDecimal: null,
        solidsDecimal: null,
        phVoltage: null,
        fillValveOn: false,
        rinseValveOn: false,
        pumpOn: false,
        flowmeterPulses: 0,
        insertedCoinAmount: 0,
        accumulatedMoney: 0,
        error: '',
      });
    }

    return res.json({
      ok: true,
      machineId,
      ...telemetry,
    });
  } catch (error) {
    console.error('GET /api/telemetry/machine/:machineId error', error);
    return res.status(500).json({ error: 'No se pudo cargar la telemetria de la maquina' });
  }
});

module.exports = router;
