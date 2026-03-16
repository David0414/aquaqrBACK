require('dotenv').config();
const net = require('net');

function monitorHost() {
  return process.env.WATERSERVER_HOST || '127.0.0.1';
}

function monitorPort() {
  const raw = Number.parseInt(process.env.WATERSERVER_MONITOR_PORT || '5002', 10);
  return Number.isFinite(raw) ? raw : 5002;
}

function reconnectDelayMs() {
  const raw = Number.parseInt(process.env.WATERSERVER_MONITOR_RECONNECT_MS || '1500', 10);
  return Number.isFinite(raw) ? raw : 1500;
}

function nowStamp() {
  return new Date().toISOString();
}

function log(message) {
  process.stdout.write(`[${nowStamp()}] ${message}\n`);
}

function connect() {
  const host = monitorHost();
  const port = monitorPort();
  const socket = new net.Socket();
  let buffer = '';
  let reconnectScheduled = false;

  const scheduleReconnect = (reason) => {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    log(`${reason}. Reintentando en ${reconnectDelayMs()}ms...`);
    setTimeout(connect, reconnectDelayMs());
  };

  socket.setKeepAlive(true, 1000);

  socket.on('connect', () => {
    log(`Escuchando monitor ${host}:${port}`);
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || '';

    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      log(line);
    }
  });

  socket.on('error', (error) => {
    log(`Error monitor: ${error.message}`);
  });

  socket.on('close', () => {
    if (buffer.trim()) {
      log(buffer.trim());
      buffer = '';
    }
    scheduleReconnect('Conexion de monitor cerrada');
  });

  socket.connect(port, host);
}

connect();
