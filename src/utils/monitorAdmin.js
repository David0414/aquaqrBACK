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
  const key = process.env.MANAGEMENT_SESSION_SECRET ||
    (MONITOR_ADMIN_USER && MONITOR_ADMIN_PASSWORD ? `${MONITOR_ADMIN_USER}:${MONITOR_ADMIN_PASSWORD}` : process.env.CLERK_SECRET_KEY);
  if (!key) throw new Error('Acceso de administrador no configurado');
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

function createAdminSession(now = Date.now(), identity = {}) {
  const expiresAt = now + 8 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ ...identity, expiresAt, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  return { token: `${payload}.${sessionSignature(payload)}`, expiresAt };
}

function readAdminSession(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1000) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra || !matchesCredential(signature, sessionSignature(payload))) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now) return null;
    if (session.adminUsername !== undefined || session.passwordVersion !== undefined) {
      if (typeof session.adminUsername !== 'string' || !session.adminUsername || session.adminUsername.length > 100 ||
          typeof session.passwordVersion !== 'string' || !/^[a-f0-9]{64}$/.test(session.passwordVersion)) return null;
    } else if (!MONITOR_ADMIN_USER || !MONITOR_ADMIN_PASSWORD) return null;
    return session;
  } catch { return null; }
}

function validAdminSession(token, now = Date.now()) {
  return Boolean(readAdminSession(token, now));
}

async function monitorAdminIdentity(req) {
  const session = readAdminSession(req.headers['x-monitor-session']);
  if (session?.adminUsername) return require('./adminAccounts').resolveAdminSession(session);
  if (session) {
    const savedAccount = await require('./adminAccounts').findAdminAccount(MONITOR_ADMIN_USER);
    return savedAccount ? null : 'agua24-monitor-admin';
  }
  if (req.headers['x-monitor-user']) {
    const identity = await require('./adminAccounts').authenticateAdmin(
      String(req.headers['x-monitor-user']).trim(), String(req.headers['x-monitor-password'] || ''));
    if (identity) return identity.adminUsername ? require('./adminAccounts').resolveAdminSession(identity) : 'agua24-monitor-admin';
  }
  return null;
}

async function isMonitorAdminRequest(req) {
  return Boolean(await monitorAdminIdentity(req));
}

async function requireAuthOrMonitorAdmin(req, res, next) {
  if (req.headers.authorization) return requireAuth(req, res, next);
  try {
    const userId = await monitorAdminIdentity(req);
    if (userId) {
      req.auth = { userId, monitorAdmin: true };
      return next();
    }
  } catch {
    return res.status(503).json({ error: 'No se pudo verificar el acceso. Intenta nuevamente.' });
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
