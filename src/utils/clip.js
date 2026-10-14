const CLIP_CHECKOUT_URL = 'https://api.payclip.com/v2/checkout';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const clipError = (message, statusCode = 502, code = 'CLIP_UNAVAILABLE') => Object.assign(new Error(message), { statusCode, code });

function clipAuthorization() {
  const token = String(process.env.CLIP_AUTH_TOKEN || '').trim();
  if (token) return token.startsWith('Basic ') ? token : `Basic ${token}`;
  if (process.env.CLIP_API_KEY && process.env.CLIP_SECRET_KEY) {
    return `Basic ${Buffer.from(`${process.env.CLIP_API_KEY}:${process.env.CLIP_SECRET_KEY}`).toString('base64')}`;
  }
  throw clipError('Los pagos con Clip todavía no están configurados.', 503, 'CLIP_NOT_CONFIGURED');
}

function clipCheckoutEnvironment() {
  const apiKey = String(process.env.CLIP_API_KEY || '').trim();
  if (apiKey) return apiKey.startsWith('test_') ? 'sandbox' : 'production';
  const token = String(process.env.CLIP_AUTH_TOKEN || '').trim().replace(/^Basic\s+/i, '');
  try {
    const basicKey = Buffer.from(token, 'base64').toString('utf8').split(':', 1)[0];
    return basicKey.startsWith('test_') ? 'sandbox' : 'production';
  } catch { return 'production'; }
}

function publicReturnUrl(path) {
  let url;
  try { url = new URL(path, process.env.APP_PUBLIC_URL); } catch { throw clipError('Falta configurar la dirección pública de la app.', 503); }
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw clipError('La dirección pública de la app debe usar HTTPS.', 503);
  }
  return url.href;
}

function validCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'pago.clip.mx' || url.hostname.endsWith('.payclip.com') || url.hostname === 'payclip.com');
  } catch { return false; }
}

async function clipRequest(method, id, body, fetcher = global.fetch) {
  if (id && !UUID.test(id)) throw clipError('Identificador de pago Clip inválido', 400);
  const response = await fetcher(`${CLIP_CHECKOUT_URL}${id ? `/${id}` : ''}`, {
    method, headers: { Authorization: clipAuthorization(), 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw clipError('No se pudo conectar con Clip. Intenta nuevamente.');
  return data;
}

async function createClipCheckout({ id, amountCents, description, returnPath, fetcher }) {
  const returnUrl = publicReturnUrl(returnPath);
  const webhookBase = process.env.API_PUBLIC_URL;
  if (!webhookBase) throw clipError('Falta configurar la dirección pública del backend para recibir el pago.', 503);
  const webhook = new URL('/api/payments/clip/webhook', webhookBase);
  if (webhook.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw clipError('El webhook de Clip debe usar HTTPS.', 503);
  const data = await clipRequest('POST', null, {
    amount: amountCents / 100, currency: 'MXN', purchase_description: description,
    redirection_url: { success: returnUrl, error: returnUrl, default: returnUrl },
    metadata: { external_reference: id }, webhook_url: webhook.href,
    override_settings: { tip_enabled: false, locale: 'es-MX' },
    custom_payment_options: { payment_method_types: ['debit', 'credit'] },
  }, fetcher);
  if (!UUID.test(data.payment_request_id || '') || !validCheckoutUrl(data.payment_request_url)) throw clipError('Clip devolvió un enlace de pago inválido.');
  return { providerPaymentId: data.payment_request_id, checkoutUrl: data.payment_request_url };
}

function verifiedClipStatus(payment, data) {
  let metadata = data.metadata;
  try { if (typeof metadata === 'string') metadata = JSON.parse(metadata); } catch { metadata = null; }
  if (data.payment_request_id !== payment.providerPaymentId || metadata?.external_reference !== payment.id ||
      !Number.isFinite(Number(data.amount)) || Math.round(Number(data.amount) * 100) !== payment.amountCents || data.currency !== 'MXN') {
    throw clipError('No se pudo validar el importe y la referencia del pago.', 409, 'PAYMENT_MISMATCH');
  }
  if (data.status === 'CHECKOUT_COMPLETED') return 'SUCCEEDED';
  if (data.status === 'CHECKOUT_CANCELLED') return 'CANCELED';
  if (data.status === 'CHECKOUT_EXPIRED') return 'FAILED';
  if (['CHECKOUT_CREATED', 'CHECKOUT_PENDING'].includes(data.status)) return 'PENDING';
  throw clipError('Clip devolvió un estado de pago desconocido.');
}

module.exports = { createClipCheckout, clipAuthorization, clipCheckoutEnvironment, clipRequest, verifiedClipStatus, validCheckoutUrl, UUID };
