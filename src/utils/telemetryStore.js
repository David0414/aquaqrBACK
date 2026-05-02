const telemetryByHardwareId = new Map();

function normalizeHardwareId(value) {
  const clean = String(value || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  return clean ? clean.padStart(2, '0').slice(-2) : null;
}

function hexPairToDecimal(value) {
  const normalized = normalizeHardwareId(value);
  return normalized ? Number.parseInt(normalized, 16) : 0;
}

function hexWordToDecimal(high, low) {
  return (hexPairToDecimal(high) << 8) | hexPairToDecimal(low);
}

function isActiveHexByte(value) {
  return normalizeHardwareId(value) !== '00';
}

function extractTelemetryBytes(payload) {
  const matches = String(payload || '').toUpperCase().match(/[0-9A-F]{2}/g) || [];
  for (let index = 0; index <= matches.length - 15; index += 1) {
    const chunk = matches.slice(index, index + 15);
    if (chunk[0] === 'E2' && chunk[14] === 'E3') return chunk;
  }
  return null;
}

function parseTelemetryPayload(payload) {
  const bytes = extractTelemetryBytes(payload);
  if (!bytes) return null;

  const hardwareId = normalizeHardwareId(bytes[1]);
  const phDecimal = hexWordToDecimal(bytes[2], bytes[3]);
  const solidsDecimal = hexWordToDecimal(bytes[4], bytes[5]);
  const flowmeterPulses = hexWordToDecimal(bytes[10], bytes[11]);

  return {
    rawFrame: bytes.join('-'),
    hardwareId,
    phDecimal,
    solidsDecimal,
    phVoltage: Number(((phDecimal * 5) / 1023).toFixed(3)),
    fillValveOn: isActiveHexByte(bytes[6]),
    rinseValveOn: isActiveHexByte(bytes[7]),
    pumpOn: isActiveHexByte(bytes[8]),
    currentStageCode: normalizeHardwareId(bytes[9]) || '00',
    flowmeterPulses,
    insertedCoinAmount: hexPairToDecimal(bytes[12]),
    accumulatedMoney: hexPairToDecimal(bytes[13]),
  };
}

function ingestTelemetry(payload = {}) {
  const rawFrame = String(payload.rawFrame || '').trim();
  const parsed = parseTelemetryPayload(rawFrame);
  if (!parsed?.hardwareId) {
    return null;
  }

  const receivedAt = payload.receivedAt ? new Date(payload.receivedAt) : new Date();
  const nextTelemetry = {
    ...parsed,
    machineOnline: true,
    lastSeenAt: receivedAt.toISOString(),
    source: payload.source || 'http-push',
  };

  telemetryByHardwareId.set(parsed.hardwareId, nextTelemetry);
  return nextTelemetry;
}

function getTelemetryByHardwareId(hardwareId) {
  const normalized = normalizeHardwareId(hardwareId);
  if (!normalized) return null;
  return telemetryByHardwareId.get(normalized) || null;
}

module.exports = {
  normalizeHardwareId,
  parseTelemetryPayload,
  ingestTelemetry,
  getTelemetryByHardwareId,
};
