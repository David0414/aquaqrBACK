// src/utils/notifications.js
const nodemailer = require("nodemailer");
const { prisma } = require("../db");

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  CURRENCY,
} = process.env;

// ============ TRANSPORT SMTP ============

let transporter = null;

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  const port = Number(SMTP_PORT || 587);
  const secure = SMTP_SECURE === "true" || port === 465;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  transporter
    .verify()
    .then(() => console.log("[mail] SMTP listo para enviar correos"))
    .catch((err) =>
      console.error("[mail] Error verificando SMTP (se puede ignorar en dev)", err)
    );
} else {
  console.warn(
    "[mail] SMTP no configurado, no se enviarán correos de notificación"
  );
}

function hasMailTransport() {
  return !!transporter;
}

// ============ PREFERENCIAS EN BD ============

/**
 * Crea/recupera NotificationSettings sin condiciones de carrera
 */
async function getOrCreateNotificationSettings(userId) {
  if (!userId) throw new Error("userId requerido en getOrCreateNotificationSettings");

  return prisma.notificationSettings.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      transactionConfirmations: true,
      promotionalOffers: true,
      securityAlerts: true,
      maintenanceNotices: false,
      emailNotifications: true,
      whatsappNotifications: false, // por ahora no usamos WA
    },
  });
}

/**
 * Devuelve preferencias planas para el front
 */
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

/**
 * Actualiza preferencias (parcialmente) y devuelve el objeto plano
 */
async function updateNotificationPreferences(userId, payload = {}) {
  if (!userId) throw new Error("userId requerido en updateNotificationPreferences");

  const baseDefaults = {
    transactionConfirmations: true,
    promotionalOffers: true,
    securityAlerts: true,
    maintenanceNotices: false,
    emailNotifications: true,
    whatsappNotifications: false,
  };

  const allowedKeys = Object.keys(baseDefaults);
  const data = {};

  for (const key of allowedKeys) {
    if (typeof payload[key] === "boolean") {
      data[key] = payload[key];
    }
  }

  const updated = await prisma.notificationSettings.upsert({
    where: { userId },
    update: data,
    create: { userId, ...baseDefaults, ...data },
  });

  return {
    transactionConfirmations: updated.transactionConfirmations,
    promotionalOffers: updated.promotionalOffers,
    securityAlerts: updated.securityAlerts,
    maintenanceNotices: updated.maintenanceNotices,
    emailNotifications: updated.emailNotifications,
    whatsappNotifications: updated.whatsappNotifications,
  };
}

// ============ ENVÍO DE EMAIL ============

/**
 * Envía un correo al usuario si:
 *  - tiene email
 *  - tiene activadas emailNotifications + transactionConfirmations
 *
 * options.type: 'recharge' | 'dispense' | ...
 * options.amountCents: número en centavos
 * options.liters: litros dispensados (para type='dispense')
 */
async function sendUserNotification(userId, options) {
  const { type, amountCents, liters } = options || {};

  if (!userId || !type) {
    console.log(
      "[sendUserNotification] llamado sin userId o sin type",
      userId,
      type
    );
    return;
  }

  if (!hasMailTransport()) return;

  const settings = await getOrCreateNotificationSettings(userId);

  // Solo queremos mandar correos de confirmación de transacción
  if (!settings.emailNotifications || !settings.transactionConfirmations) {
    console.log(
      "[sendUserNotification] usuario sin emailNotifications/transactionConfirmations",
      userId
    );
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user || !user.email) {
    console.log(
      "[sendUserNotification] usuario sin email guardado en BD",
      userId
    );
    return;
  }

  const to = user.email;
  const currency = (CURRENCY || "MXN").toUpperCase();
  const amount =
    typeof amountCents === "number"
      ? (amountCents / 100).toFixed(2)
      : undefined;

  let subject;
  let text;
  let html;

  if (type === "recharge") {
    subject = "Confirmación de recarga de saldo";
    text =
      `Hola,\n\n` +
      `Tu recarga de ${amount} ${currency} se ha acreditado correctamente en tu monedero AquaQR.\n\n` +
      `Gracias por usar AquaQR.`;
    html = `
      <p>Hola,</p>
      <p>
        Tu recarga de <strong>${amount} ${currency}</strong> se ha acreditado
        correctamente en tu monedero AquaQR.
      </p>
      <p>Gracias por usar AquaQR 💧</p>
    `;
  } else if (type === "dispense") {
    const litersText =
      typeof liters === "number" ? `${liters} L de agua` : "tu dispensado de agua";
    subject = "Confirmación de dispensado de agua";
    text =
      `Hola,\n\n` +
      `Acabas de completar ${litersText} por un total de ${amount} ${currency}.\n\n` +
      `Gracias por usar AquaQR.`;
    html = `
      <p>Hola,</p>
      <p>
        Acabas de completar <strong>${litersText}</strong> por un total de
        <strong>${amount} ${currency}</strong>.
      </p>
      <p>Gracias por usar AquaQR 💧</p>
    `;
  } else {
    subject = "Notificación de tu cuenta AquaQR";
    text = "Tienes una nueva actividad en tu cuenta AquaQR.";
    html = "<p>Tienes una nueva actividad en tu cuenta AquaQR.</p>";
  }

  try {
    await transporter.sendMail({
      from: EMAIL_FROM || "AquaQR <no-reply@aquaqr.test>",
      to,
      subject,
      text,
      html,
    });
    console.log("[sendUserNotification] correo enviado", { userId, type });
  } catch (err) {
    console.error("[sendUserNotification] Error enviando correo", err);
  }
}

module.exports = {
  getNotificationPreferences,
  updateNotificationPreferences,
  sendUserNotification,
};
