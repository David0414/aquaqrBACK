const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Exercise the real routes with a local identity/database fixture; never contact Clerk or hardware.
process.env.MONITOR_ADMIN_USER = 'fixture-admin';
process.env.MONITOR_ADMIN_PASSWORD = 'fixture-password';
process.env.QR_SIGNING_SECRET = 'fixture-qr-secret';
let users = [], machines = [], clerkAccounts = [], adminCredentials = [], credentialError = null;
const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
  if (value && typeof value === 'object') {
    if ('not' in value) return row[key] != null && row[key] !== value.not;
    if ('in' in value) return value.in.includes(row[key]);
  }
  return row[key] === value;
});
const withPartner = (machine) => machine && ({ ...machine, partner: users.find((user) => user.id === machine.partnerId) || null });
const db = {
  adminCredential: {
    findUnique: async ({ where }) => {
      if (credentialError) throw credentialError;
      const account = adminCredentials.find((item) => matches(item, where));
      return account ? { ...account, user: users.find((user) => user.id === account.userId) || null } : null;
    },
  },
  user: {
    findUnique: async ({ where }) => users.find((user) => matches(user, where)) || null,
    findFirst: async ({ where }) => users.find((user) => matches(user, where)) || null,
    findMany: async ({ where }) => users.filter((user) => matches(user, where)).map((user) => ({ ...user, ownedMachines: machines.filter((machine) => machine.partnerId === user.id) })),
    updateMany: async ({ where, data }) => { const rows = users.filter((user) => matches(user, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; },
    upsert: async ({ where, update, create }) => {
      let user = users.find((item) => matches(item, where));
      if (user) Object.assign(user, update); else { user = { ...create }; users.push(user); }
      return { ...user, ownedMachines: machines.filter((machine) => machine.partnerId === user.id) };
    },
  },
  machine: {
    findUnique: async ({ where }) => withPartner(machines.find((machine) => matches(machine, where))),
    findFirst: async ({ where }) => withPartner(machines.find((machine) => matches(machine, where))),
    findMany: async ({ where }) => machines.filter((machine) => matches(machine, where)).map(withPartner),
    update: async ({ where, data }) => { const machine = machines.find((item) => matches(item, where)); Object.assign(machine, data); return withPartner(machine); },
    upsert: async ({ where, update, create }) => { let machine = machines.find((item) => matches(item, where)); if (machine) Object.assign(machine, update); else { machine = { ...create }; machines.push(machine); } return withPartner(machine); },
  },
  dispense: { aggregate: async ({ where }) => ({ _count: { _all: where.machineId.in.length },
    _sum: { liters: where.machineId.in.length * 20, totalCents: where.machineId.in.length * 3500 } }) },
  userMembership: { aggregate: async () => ({ _count: { _all: 0 }, _sum: { pricePaidCents: 0 } }) },
  appPromotion: { upsert: async ({ create }) => create, findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  $transaction: async (run) => run(db),
};
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: db } };
const authPath = require.resolve('../src/utils/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireAuth: (req, res, next) => {
  const id = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!users.some((user) => user.id === id)) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = { userId: id }; return next();
} } };
const clerkPath = require.resolve('@clerk/backend');
require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: {
  createClerkClient: () => ({ users: {
    getUserList: async ({ emailAddress }) => ({ data: clerkAccounts.filter((account) => account.emailAddresses.some((email) => emailAddress.includes(email.emailAddress))) }),
    getUser: async (id) => clerkAccounts.find((account) => account.id === id),
  } }),
} };
const monitorAuth = require('../src/utils/monitorAdmin');
const { findPartnerAccount } = require('../src/routes/management');
const app = express();
app.use(express.json());
app.use('/management', require('../src/routes/management'));
app.use('/monitor', require('../src/routes/monitorAdmin'));
app.use('/telemetry', require('../src/routes/telemetry'));
app.use('/qr', require('../src/routes/qr'));
const originalImmediate = global.setImmediate;
global.setImmediate = () => 0; // Disable the module's automatic hardware connection in this test process.
app.use('/dispense', require('../src/routes/dispense'));
global.setImmediate = originalImmediate;
let server, base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
test.beforeEach(() => {
  clerkAccounts = [];
  adminCredentials = [];
  credentialError = null;
  users = [
    { id: 'admin', role: 'ADMIN', managementAccessActive: true },
    { id: 'partner-1', role: 'PARTNER', name: 'Socio Uno', managementAccessActive: true },
    { id: 'partner-2', role: 'PARTNER', name: 'Socio Dos', managementAccessActive: true },
    { id: 'customer', role: 'CUSTOMER', managementAccessActive: true },
  ];
  machines = [
    { id: 'AQ-001', hardwareId: '01', partnerId: 'partner-1', name: 'Centro', pricePerGarrafonCents: 3500, isActive: true },
    { id: 'AQ-002', hardwareId: '02', partnerId: 'partner-2', name: 'Norte', pricePerGarrafonCents: 3500, isActive: true },
    { id: 'AQ-003', hardwareId: '03', partnerId: null, name: 'Sin socio', pricePerGarrafonCents: 3500, isActive: true },
  ];
});
async function request(path, id, method = 'GET', body, extraHeaders = {}) {
  const response = await fetch(base + path, { method, headers: { ...(id ? { Authorization: `Bearer ${id}` } : {}),
    'Content-Type': 'application/json', ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

test('requires authenticated management roles rather than client role flags', async () => {
  assert.equal((await request('/monitor/summary')).status, 401);
  for (const path of ['/monitor/summary', '/management/partners', '/telemetry/machine/AQ-001']) {
    assert.equal((await request(path, 'customer')).status, 403);
  }
  assert.equal((await request('/management/partners', 'customer', 'POST', { role: 'ADMIN' })).status, 403);
  assert.equal((await request('/monitor/promotions/topup_bonus', 'partner-1', 'PUT', { isActive: false })).status, 403);
});

test('the same sign-in resolves the account panel from its saved role', async () => {
  for (const [id, role, path] of [['admin', 'ADMIN', '/water-monitor'], ['partner-1', 'PARTNER', '/partner-panel'], ['customer', 'CUSTOMER', '/home-dashboard']]) {
    const result = await request('/management/me', id);
    assert.equal(result.status, 200);
    assert.equal(result.data.role, role);
    assert.equal(result.data.defaultPath, path);
  }
  users.find((user) => user.id === 'partner-1').managementAccessActive = false;
  const suspended = await request('/management/me', 'partner-1');
  assert.equal(suspended.data.canManage, false);
  assert.equal(suspended.data.defaultPath, '/partner-panel');
});

test('an old administrative session cannot override the signed-in customer identity', async () => {
  const { token } = monitorAuth.createAdminSession();
  const headers = { 'X-Monitor-Session': token };
  const current = await request('/management/me', 'customer', 'GET', undefined, headers);
  assert.equal(current.data.role, 'CUSTOMER');
  assert.equal((await request('/monitor/summary', 'customer', 'GET', undefined, headers)).status, 403);
  assert.equal((await request('/management/me', 'invalid-account', 'GET', undefined, headers)).status, 401);
});

test('partner catalogs, sales totals and telemetry are limited to assigned machines', async () => {
  const result = await request('/monitor/summary', 'partner-1');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.machines.map((machine) => machine.id), ['AQ-001']);
  assert.equal(result.data.counts.machines, 1);
  assert.equal(result.data.sales.revenueCents, 3500);
  assert.deepEqual(result.data.promotions, []);
  assert.equal((await request('/telemetry/machine/AQ-002', 'partner-1')).status, 404);
  assert.equal((await request('/telemetry/machine/AQ-001', 'partner-1')).status, 200);
  assert.equal((await request('/monitor/machines/AQ-002/qr', 'partner-1')).status, 404);
  assert.equal((await request('/qr/generate?machineId=AQ-002', 'partner-1')).status, 404);
  assert.equal((await request('/monitor/machines/AQ-001/qr', 'partner-1')).status, 200);
  assert.equal((await request('/qr/generate?machineId=AQ-001', 'partner-1')).status, 200);
});

test('admin grants an existing verified account access, assigns a machine and the account opens its partner panel', async () => {
  clerkAccounts = [{ id: 'user_newpartner', firstName: 'Nuevo', lastName: 'Socio', primaryEmailAddressId: 'email_verified',
    emailAddresses: [{ id: 'email_verified', emailAddress: 'nuevo@example.com', verification: { status: 'verified' } }] }];
  assert.equal((await request('/management/partners', 'admin', 'POST', { email: 'noexiste@example.com' })).status, 400);
  const result = await request('/management/partners', 'admin', 'POST', { email: 'nuevo@example.com' });
  assert.equal(result.status, 200);
  assert.equal(result.data.partner.role, 'PARTNER');
  assert.equal(result.data.partner.managementAccessActive, true);
  assert.deepEqual(result.data.partner.ownedMachines, []);
  assert.equal((await request('/management/machines/AQ-003/partner', 'admin', 'PUT', { partnerId: 'user_newpartner' })).status, 200);
  const account = await request('/management/me', 'user_newpartner');
  assert.equal(account.data.defaultPath, '/partner-panel');
  assert.equal(account.data.canManage, true);
  assert.deepEqual((await request('/monitor/machines', 'user_newpartner')).data.items.map((machine) => machine.id), ['AQ-003']);
});

test('an existing Google customer becomes a partner on the same account only after an admin grants access', async () => {
  const id = 'user_existingGoogle';
  const email = 'existing@example.com';
  users.push({ id, role: 'CUSTOMER', managementAccessActive: true });
  clerkAccounts = [{ id, firstName: 'Socio', primaryEmailAddressId: 'email_google',
    emailAddresses: [{ id: 'email_google', emailAddress: email, verification: { status: 'verified' } }],
    externalAccounts: [{ provider: 'oauth_google', emailAddress: email }] }];
  assert.equal((await request('/management/me', id)).data.role, 'CUSTOMER');
  assert.equal((await request('/management/partners', id, 'POST', { email })).status, 403);
  assert.equal((await request('/management/me', id)).data.role, 'CUSTOMER');
  assert.equal((await request('/management/partners', 'admin', 'POST', { email })).status, 200);
  const access = (await request('/management/me', id)).data;
  assert.equal(access.role, 'PARTNER');
  assert.equal(access.defaultPath, '/partner-panel');
  assert.equal(users.filter((user) => user.id === id).length, 1);
  assert.equal((await request('/management/machines/AQ-001/partner', 'admin', 'PUT', { partnerId: id })).status, 200);
  assert.deepEqual((await request('/monitor/machines', id)).data.items.map((machine) => machine.id), ['AQ-001']);
});

test('partner can edit prices and machine details, but cannot reassign, rewire, create or delete machines', async () => {
  assert.equal((await request('/monitor/machines/AQ-002', 'partner-1', 'PUT', { name: 'Other' })).status, 404);
  assert.equal((await request('/monitor/machines/AQ-001', 'partner-1', 'PUT', { name: 'Mi sucursal', pricePerGarrafon: '50' })).status, 200);
  assert.equal(machines[0].name, 'Mi sucursal');
  assert.equal(machines[0].pricePerGarrafonCents, 5000);
  assert.equal(machines[0].hardwareId, '01');
  assert.equal((await request('/monitor/machines/AQ-001', 'partner-1', 'PUT', { hardwareId: '02' })).status, 403);
  assert.equal((await request('/monitor/machines/AQ-001', 'partner-1', 'PUT', { partnerId: 'partner-2' })).status, 403);
  assert.equal((await request('/monitor/machines', 'partner-1', 'POST', { id: 'NEW' })).status, 403);
  assert.equal((await request('/monitor/machines/AQ-001', 'partner-1', 'DELETE')).status, 403);
});

test('calibration and manual hardware operations reject foreign machines and hardware spoofing', async () => {
  assert.equal((await request('/dispense/config/pulses', 'customer', 'POST', { machineId: 'AQ-001' })).status, 403);
  assert.equal((await request('/dispense/config/pulses', 'partner-1', 'POST', { machineId: 'AQ-002', hardwareId: '02' })).status, 404);
  assert.equal((await request('/dispense/config/pulses', 'partner-1', 'POST', { machineId: 'AQ-001', hardwareId: '02' })).status, 400);
  assert.equal((await request('/dispense/config/pulses', 'partner-1', 'POST', { machineId: 'AQ-001', hardwareId: '01', pulsesPerLiter: 400 })).status, 200);
  for (const action of ['bomba_on', 'valvula_llenado_on', 'reiniciar_sistema']) {
    assert.equal((await request('/dispense/demo/control', 'customer', 'POST', { machineId: 'AQ-001', action })).status, 403);
    assert.equal((await request('/dispense/demo/control', 'partner-1', 'POST', { machineId: 'AQ-002', action })).status, 404);
    assert.equal((await request('/dispense/demo/control', 'partner-1', 'POST', { machineId: 'AQ-001', hardwareId: '02', action })).status, 400);
  }
});

test('admin can list every partner and transfer or remove ownership; previous owner immediately loses access', async () => {
  const result = await request('/management/partners', 'admin');
  assert.deepEqual(result.data.items.map((partner) => partner.id), ['partner-1', 'partner-2']);
  assert.equal(result.data.items[0].ownedMachines[0].id, 'AQ-001');
  assert.equal((await request('/management/machines/AQ-001/partner', 'admin', 'PUT', { partnerId: 'partner-2' })).status, 200);
  assert.equal((await request('/telemetry/machine/AQ-001', 'partner-1')).status, 404);
  assert.equal((await request('/telemetry/machine/AQ-001', 'partner-2')).status, 200);
  assert.equal((await request('/management/machines/AQ-001/partner', 'admin', 'PUT', { partnerId: null })).status, 200);
  assert.equal((await request('/telemetry/machine/AQ-001', 'partner-2')).status, 404);
});

test('suspension takes effect on existing sessions and keeps machine ownership for reactivation', async () => {
  assert.equal((await request('/management/partners/partner-1/access', 'admin', 'PUT', { active: false })).status, 200);
  assert.equal((await request('/monitor/summary', 'partner-1')).status, 403);
  assert.equal((await request('/management/me', 'partner-1')).data.canManage, false);
  assert.equal(machines[0].partnerId, 'partner-1');
  assert.equal((await request('/management/partners/partner-1/access', 'admin', 'PUT', { active: true })).status, 200);
  assert.equal((await request('/monitor/summary', 'partner-1')).status, 200);
});

test('prevents two partners from receiving different catalog aliases for the same physical hardware', async () => {
  machines[2].hardwareId = '01';
  assert.equal((await request('/management/machines/AQ-003/partner', 'admin', 'PUT', { partnerId: 'partner-2' })).status, 409);
  assert.equal(machines[2].partnerId, null);
});

test('admin login is verified on the server and session signatures reject tampering and expiration', async () => {
  assert.equal((await request('/management/login', null, 'POST', { user: 'fixture-admin', password: 'wrong' })).status, 401);
  const result = await request('/management/login', null, 'POST', { user: 'fixture-admin', password: 'fixture-password' });
  assert.equal(result.status, 200);
  const token = result.data.token;
  assert.equal((await request('/management/me', null, 'GET', undefined, { 'X-Monitor-Session': token })).data.role, 'ADMIN');
  assert.equal(monitorAuth.validAdminSession(token, result.data.expiresAt + 1), false);
  assert.equal(monitorAuth.validAdminSession(token + 'invalid'), false);
});

test('granting partner access uses a verified account identity, never an editable profile email', async () => {
  const account = { id: 'user_verified', emailAddresses: [{ emailAddress: 'socio@example.com', verification: { status: 'verified' } }] };
  const clerk = { users: { getUserList: async () => ({ data: [account] }) } };
  assert.equal((await findPartnerAccount({ email: 'SOCIO@example.com' }, clerk)).id, 'user_verified');
  account.emailAddresses[0].verification.status = 'unverified';
  await assert.rejects(findPartnerAccount({ email: 'socio@example.com' }, clerk), /correo verificado/);
});

test('the Supabase administrator signs in with username and password and opens the full admin panel', async () => {
  const sql = require('fs').readFileSync(require('path').join(__dirname, '../CREAR_ADMIN_SUPABASE.sql'), 'utf8');
  const passwordHash = sql.match(/scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}/)[0];
  adminCredentials.push({ username: 'administrador', userId: 'admin', passwordHash });
  assert.equal((await request('/management/login', null, 'POST', { user: 'administrador', password: 'incorrecta' })).status, 401);
  const login = await request('/management/login', null, 'POST', { user: 'administrador', password: '123' });
  assert.equal(login.status, 200);
  assert.equal(login.data.role, 'ADMIN');
  assert.equal(login.data.passwordHash, undefined);
  const headers = { 'X-Monitor-Session': login.data.token };
  const me = await request('/management/me', null, 'GET', undefined, headers);
  assert.equal(me.data.userId, 'admin');
  assert.equal(me.data.defaultPath, '/water-monitor');
  assert.equal((await request('/monitor/summary', null, 'GET', undefined, headers)).data.counts.machines, 3);
  assert.equal((await request('/management/partners', null, 'GET', undefined, headers)).data.items.length, 2);
  assert.equal(monitorAuth.validAdminSession(login.data.token, login.data.expiresAt), false);
  assert.equal((await request('/management/me', null, 'GET', undefined, { 'X-Monitor-Session': login.data.token + 'altered' })).status, 401);
  assert.equal((await request('/management/me', 'customer', 'GET', undefined, headers)).data.role, 'CUSTOMER');
});

test('password changes, suspension, role changes and deletion revoke existing database admin sessions', async () => {
  const { hashAdminPassword } = require('../src/utils/adminAccounts');
  const passwordHash = await hashAdminPassword('123');
  const account = { username: 'administrador', userId: 'admin', passwordHash };
  adminCredentials.push(account);
  const login = await request('/management/login', null, 'POST', { user: 'administrador', password: '123' });
  assert.equal(login.status, 200);
  const headers = { 'X-Monitor-Session': login.data.token };
  const user = users.find((item) => item.id === 'admin');
  for (const change of [{ managementAccessActive: false }, { role: 'CUSTOMER' }]) {
    Object.assign(user, change);
    assert.equal((await request('/management/me', null, 'GET', undefined, headers)).status, 401);
    assert.equal((await request('/management/login', null, 'POST', { user: 'administrador', password: '123' })).status, 401);
    Object.assign(user, { role: 'ADMIN', managementAccessActive: true });
  }
  account.passwordHash = await hashAdminPassword('nueva');
  assert.equal((await request('/monitor/summary', null, 'GET', undefined, headers)).status, 401);
  account.passwordHash = passwordHash;
  adminCredentials = [];
  assert.equal((await request('/management/me', null, 'GET', undefined, headers)).status, 401);
});

test('a saved administrator password takes precedence over old environment credentials and headers', async () => {
  const { hashAdminPassword } = require('../src/utils/adminAccounts');
  const oldSession = monitorAuth.createAdminSession();
  adminCredentials.push({ username: 'fixture-admin', userId: 'admin', passwordHash: await hashAdminPassword('changed') });
  assert.equal((await request('/management/me', null, 'GET', undefined, { 'X-Monitor-Session': oldSession.token })).status, 401);
  assert.equal((await request('/management/login', null, 'POST', { user: 'fixture-admin', password: 'fixture-password' })).status, 401);
  assert.equal((await request('/monitor/summary', null, 'GET', undefined,
    { 'X-Monitor-User': 'fixture-admin', 'X-Monitor-Password': 'fixture-password' })).status, 401);
  assert.equal((await request('/management/login', null, 'POST', { user: 'fixture-admin', password: 'changed' })).status, 200);
});

test('schema rollout preserves environment login and database outages return a recoverable server error', async () => {
  credentialError = { code: 'P2021' };
  assert.equal((await request('/management/login', null, 'POST', { user: 'fixture-admin', password: 'fixture-password' })).status, 200);
  credentialError = { code: 'P1001', message: 'private connection details' };
  const result = await request('/management/login', null, 'POST', { user: 'administrador', password: '123' });
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result.data).includes('private connection details'));
});

test('database admin sessions work with the existing Clerk secret when no environment admin is configured', () => {
  const result = require('child_process').spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const auth = require('./src/utils/monitorAdmin');
    const identity = { adminUsername: 'administrador', passwordVersion: 'a'.repeat(64) };
    const session = auth.createAdminSession(Date.now(), identity);
    assert.equal(auth.validAdminSession(session.token), true);
    assert.equal(auth.validAdminSession(auth.createAdminSession().token), false);
  `], { cwd: require('path').join(__dirname, '..'), env: { ...process.env,
    MONITOR_ADMIN_USER: '', MONITOR_ADMIN_PASSWORD: '', MANAGEMENT_SESSION_SECRET: '', CLERK_SECRET_KEY: 'fixture-existing-clerk-key' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('malformed or oversized passwords cannot be used for database authentication', async () => {
  const { verifyAdminPassword, authenticateAdmin } = require('../src/utils/adminAccounts');
  assert.equal(await verifyAdminPassword('123', 'scrypt$invalid$invalid'), false);
  assert.equal(await authenticateAdmin('administrador', 'a'.repeat(257), db), null);
  assert.equal(await authenticateAdmin('administrador', null, db), null);
});
