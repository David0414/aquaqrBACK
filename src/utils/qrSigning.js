// src/utils/qrSigning.js
const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min

function hmacHex(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function signMachineLink({ machineId, ts = null, secret, mode = 'permanent' }) {
  if (mode === 'ephemeral') {
    if (!ts) ts = Date.now();
    return { sig: hmacHex(`${machineId}.${ts}`, secret), ts };
  }
  // permanent (para sticker)
  return { sig: hmacHex(`${machineId}`, secret) };
}

function safeEqualHex(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(aHex) || !/^[0-9a-f]+$/i.test(bHex)) return false;
  if (aHex.length !== bHex.length) return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  return crypto.timingSafeEqual(a, b);
}

function verifyMachineLink({ machineId, ts, sig, secret, now = Date.now(), ttlMs = DEFAULT_TTL_MS }) {
  if (!machineId || !sig) return { ok: false, reason: 'missing_params' };

  // 1) Primero intenta efímero (si trae ts)
  if (ts) {
    const age = now - Number(ts);
    if (Number.isNaN(age) || age < 0 || age > ttlMs) return { ok: false, reason: 'expired' };
    const expected = hmacHex(`${machineId}.${ts}`, secret);
    return safeEqualHex(expected, sig) ? { ok: true, mode: 'ephemeral' } : { ok: false, reason: 'bad_sig' };
  }

  // 2) Si no trae ts, asume permanente (sticker)
  const expected = hmacHex(`${machineId}`, secret);
  return safeEqualHex(expected, sig) ? { ok: true, mode: 'permanent' } : { ok: false, reason: 'bad_sig' };
}

module.exports = { signMachineLink, verifyMachineLink, DEFAULT_TTL_MS };
