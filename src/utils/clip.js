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

module.exports = { clipAuthorization, clipRequest, verifiedClipStatus, UUID };
