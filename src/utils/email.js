// src/utils/email.js
const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_SECURE,
  EMAIL_FROM,
} = process.env;

if (!SMTP_HOST) {
  console.warn(
    '[email] SMTP_HOST no está configurado; los correos se simularán en consola.'
  );
}

// Si no hay SMTP_HOST, transporter será null y sólo loguearemos
const transporter = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: String(SMTP_SECURE || '').toLowerCase() === 'true',
      auth:
        SMTP_USER && SMTP_PASS
          ? {
              user: SMTP_USER,
              pass: SMTP_PASS,
            }
          : undefined,
    })
  : null;

async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.log('[email] Simulado (sin SMTP configurado):', {
      to,
      subject,
    });
    return;
  }

  await transporter.sendMail({
    from: EMAIL_FROM || SMTP_USER,
    to,
    subject,
    text,
    html,
  });
}

module.exports = {
  sendEmail,
};
