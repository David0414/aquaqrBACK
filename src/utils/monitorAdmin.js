const { requireAuth } = require('./auth');

const MONITOR_ADMIN_USER = process.env.MONITOR_ADMIN_USER || 'admin';
const MONITOR_ADMIN_PASSWORD = process.env.MONITOR_ADMIN_PASSWORD || '123';

function isMonitorAdminRequest(req) {
  const user = String(req.headers['x-monitor-user'] || '').trim();
  const password = String(req.headers['x-monitor-password'] || '').trim();
  return user === MONITOR_ADMIN_USER && password === MONITOR_ADMIN_PASSWORD;
}

function requireAuthOrMonitorAdmin(req, res, next) {
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
};
