// Backend/scripts/make-sticker.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const FRONT =
  (process.env.QR_BASE_URL || process.env.APP_PUBLIC_URL || 'http://localhost:5173')
    .replace(/\/+$/, ''); // sin slash final

const SECRET = process.env.QR_SIGNING_SECRET;
if (!SECRET) {
  console.error('Falta QR_SIGNING_SECRET en tu .env');
  process.exit(1);
}

const machineId = process.argv[2] || 'AQ-001';
const ephemeral = process.argv.includes('--ephemeral');

function hmacHex(s, key) {
  return crypto.createHmac('sha256', key).update(s).digest('hex');
}

(async () => {
  try {
    let qs = new URLSearchParams();
    qs.set('m', machineId);

    if (ephemeral) {
      const ts = Date.now();
      const sig = hmacHex(`${machineId}.${ts}`, SECRET);
      qs.set('ts', String(ts));
      qs.set('sig', sig);
    } else {
      const sig = hmacHex(`${machineId}`, SECRET);
      qs.set('sig', sig);
    }

    const deepUrl = `${FRONT}/qr-resolver?${qs.toString()}`;

    const outDir = path.join(process.cwd(), 'stickers');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const outFile = path.join(outDir, `${machineId}${ephemeral ? '-ephemeral' : ''}.png`);

    await QRCode.toFile(outFile, deepUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });

    console.log('✅ Sticker listo:', outFile);
    console.log('🔗 URL:', deepUrl);
    console.log(ephemeral ? '⏱️ Modo efímero (expira ~10 min)' : '📦 Modo permanente (para sticker físico)');
  } catch (e) {
    console.error('Error generando QR:', e);
    process.exit(1);
  }
})();
