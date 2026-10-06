const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

async function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyAdminPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 256 || typeof hash !== 'string') return false;
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(hash);
  if (!match) return false;
  const key = await scrypt(password, match[1], 64);
  return crypto.timingSafeEqual(key, Buffer.from(match[2], 'hex'));
}

const passwordVersion = (hash) => crypto.createHash('sha256').update(hash).digest('hex');
const activeAdministrator = (account) => account?.user?.role === 'ADMIN' && account.user.managementAccessActive === true;

async function findAdminAccount(username, client = require('../db').prisma) {
  try {
    return await client.adminCredential.findUnique({ where: { username }, include: {
      user: { select: { id: true, role: true, managementAccessActive: true } },
    } });
  } catch (error) {
    // Keep the existing server-configured login available during the schema rollout.
    if (error.code === 'P2021') return null;
    throw error;
  }
}

async function authenticateAdmin(username, password, client) {
  if (typeof username !== 'string' || !username || username.length > 100 ||
      typeof password !== 'string' || !password || password.length > 256) return null;
  const account = await findAdminAccount(username, client);
  if (account) {
    if (!activeAdministrator(account) || !await verifyAdminPassword(password, account.passwordHash)) return null;
    return { adminUsername: account.username, passwordVersion: passwordVersion(account.passwordHash) };
  }
  return require('./monitorAdmin').validAdminCredentials(username, password) ? {} : null;
}

async function resolveAdminSession(session, client) {
  const account = await findAdminAccount(session.adminUsername, client);
  if (!activeAdministrator(account) || passwordVersion(account.passwordHash) !== session.passwordVersion) return null;
  return account.userId;
}

module.exports = { hashAdminPassword, verifyAdminPassword, authenticateAdmin, resolveAdminSession, findAdminAccount };
