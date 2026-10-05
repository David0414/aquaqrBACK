const { requireAuth } = require('./auth');
const crypto = require('crypto');

const MONITOR_ADMIN_USER = process.env.MONITOR_ADMIN_USER || '';
const MONITOR_ADMIN_PASSWORD = process.env.MONITOR_ADMIN_PASSWORD || '';

function matchesCredential(value, expected) {
  if (!expected || typeof value !== 'string') return false;
  const a = crypto.createHash('sha256').update(value).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function validAdminCredentials(user, password) {
  return matchesCredential(user, MONITOR_ADMIN_USER) && matchesCredential(password, MONITOR_ADMIN_PASSWORD);
}

function sessionSignature(payload) {
  return crypto.createHmac('sha256', `${MONITOR_ADMIN_USER}:${MONITOR_ADMIN_PASSWORD}`).update(payload).digest('base64url');
}

function createAdminSession(now = Date.now()) {
  if (!MONITOR_ADMIN_USER || !MONITOR_ADMIN_PASSWORD) throw new Error('Acceso de administrador no configurado');
  const expiresAt = now + 8 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ expiresAt, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  return { token: `${payload}.${sessionSignature(payload)}`, expiresAt };
}

function validAdminSession(token, now = Date.now()) {
  if (!MONITOR_ADMIN_USER || !MONITOR_ADMIN_PASSWORD || typeof token !== 'string' || token.length > 1000) return false;
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra || !matchesCredential(signature, sessionSignature(payload))) return false;
    return Number(JSON.parse(Buffer.from(payload, 'base64url').toString()).expiresAt) > now;
  } catch { return false; }
}

function isMonitorAdminRequest(req) {
  if (validAdminSession(req.headers['x-monitor-session'])) return true;
  const user = String(req.headers['x-monitor-user'] || '').trim();
  const password = String(req.headers['x-monitor-password'] || '');
  return validAdminCredentials(user, password);
}

function requireAuthOrMonitorAdmin(req, res, next) {
  if (req.headers.authorization) return requireAuth(req, res, next);
  if (isMonitorAdminRequest(req)) {
    req.auth = { userId: 'agua24-monitor-admin', monitorAdmin: true };
    return next();
  }

  return requireAuth(req, res, next);
}

module.exports = {
  MONITOR_ADMIN_USER,
  MONITOR_ADMIN_PASSWORD,
  isMonitorAdminRequest,
  requireAuthOrMonitorAdmin,
  validAdminCredentials,
  createAdminSession,
  validAdminSession,
};
