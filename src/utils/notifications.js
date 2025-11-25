// src/utils/notifications.js
const nodemailer = require('nodemailer');
const { prisma } = require('../db');

const EMAIL_FROM = process.env.EMAIL_FROM || 'AquaQR <no-reply@example.com>';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Crea el registro de NotificationSettings si no existe (sin condiciones de carrera)
 */
async function getOrCreateNotificationSettings(userId) {
  if (!userId) {
    throw new Error('getOrCreateNotificationSettings necesita userId');
  }

  return prisma.notificationSettings.upsert({
    where: { userId },
    update: {}, // no modificamos nada si ya existe
    create: {
      userId,
      transactionConfirmations: true,
      promotionalOffers: true,
      securityAlerts: true,
      maintenanceNotices: false,
      emailNotifications: true,
      whatsappNotifications: true,
    },
  });
}

async function getNotificationPreferences(userId) {
  const settings = await getOrCreateNotificationSettings(userId);

  return {
    transactionConfirmations: settings.transactionConfirmations,
    promotionalOffers: settings.promotionalOffers,
    securityAlerts: settings.securityAlerts,
    maintenanceNotices: settings.maintenanceNotices,
    emailNotifications: settings.emailNotifications,
    whatsappNotifications: settings.whatsappNotifications,
  };
}

async function updateNotificationPreferences(userId, prefs = {}) {
  const settings = await getOrCreateNotificationSettings(userId);

  return prisma.notificationSettings.update({
    where: { id: settings.id },
    data: {
      transactionConfirmations: !!prefs.transactionConfirmations,
      promotionalOffers: !!prefs.promotionalOffers,
      securityAlerts: !!prefs.securityAlerts,
      maintenanceNotices: !!prefs.maintenanceNotices,
      emailNotifications: !!prefs.emailNotifications,
      whatsappNotifications: !!prefs.whatsappNotifications,
    },
  });
}

/**
 * Envía un correo al usuario respetando sus preferencias.
 * type: 'recharge' | 'dispense'
 */
async function sendUserNotification({ userId, type, subject, text, html }) {
  try {
    // ⚠️ Si no hay userId, mejor no hacemos nada
    if (!userId) {
      console.warn('[sendUserNotification] llamado sin userId, tipo:', type);
      return;
    }

    const settings = await getOrCreateNotificationSettings(userId);

    // Canal email desactivado
    if (!settings.emailNotifications) return;

    // De momento usamos transactionConfirmations para recarga y dispensado
    if (!settings.transactionConfirmations) return;

    // Resolvemos el correo del usuario desde la tabla User
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const toEmail = user?.email;
    if (!toEmail) {
      console.warn('[sendUserNotification] Usuario sin email, no se envía nada', { userId });
      return;
    }

    await transporter.sendMail({
      from: EMAIL_FROM,
      to: toEmail,
      subject,
      text,
      html,
    });
  } catch (err) {
    console.error('[sendUserNotification] Error enviando correo', err);
  }
}

module.exports = {
  getNotificationPreferences,
  updateNotificationPreferences,
  sendUserNotification,
};
