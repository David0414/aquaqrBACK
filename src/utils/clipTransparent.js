const { UUID } = require('./clip');
const error = (message, statusCode = 502, code = 'CLIP_UNAVAILABLE') => Object.assign(new Error(message), { statusCode, code });
// Reuse the already verified POST response only within its charge request.
const chargeProofs = new WeakMap();

function transparentConfig() {
  const apiKey = String(process.env.CLIP_API_KEY || '').trim().replace(/^Bearer\s+/i, '');
  if (!/^(?:test_)?[a-zA-Z0-9_-]{16,}$/.test(apiKey)) throw error('Falta configurar la Clave API de Clip en el backend.', 503, 'CLIP_NOT_CONFIGURED');
  return { apiKey, environment: apiKey.startsWith('test_') ? 'sandbox' : 'production' };
}

function assertEnvironment(payment) {
  const config = transparentConfig();
  if (payment.clipEnvironment !== config.environment) throw error('Este pago corresponde a otro entorno de Clip. No se realizará un nuevo cargo.', 409, 'CLIP_ENVIRONMENT_CHANGED');
  return config;
}

async function paymentRequest(method, id, body, fetcher = global.fetch) {
  if (id && !UUID.test(id)) throw error('Identificador de pago inválido.', 400);
  const { apiKey } = transparentConfig();
  let response;
  try {
    response = await fetcher(`https://api.payclip.com/payments${id ? `/${id}` : ''}`, {
      method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(20000), ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw error('No se recibió la confirmación de Clip. Verifica el pago antes de intentar otro cargo.', 503, 'PAYMENT_UNCONFIRMED'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const failure = error(response.status === 401 || response.status === 403
      ? 'Clip no aceptó las credenciales. Revisa la Clave API y la verificación de tu cuenta.'
      : 'Clip no pudo procesar el pago. Verifica su estado antes de intentar nuevamente.', 502,
      response.status < 500 && [400, 401, 403, 422].includes(response.status) ? 'CLIP_PAYMENT_REJECTED' : 'PAYMENT_UNCONFIRMED');
    failure.definitiveRejection = failure.code === 'CLIP_PAYMENT_REJECTED';
    throw failure;
  }
  return data;
}

function verifiedTransparentStatus(payment, data) {
  if (!UUID.test(data?.id || '') || (payment.providerPaymentId && data.id !== payment.providerPaymentId) ||
      data.external_reference !== payment.id || !Number.isFinite(Number(data.amount)) ||
      Math.round(Number(data.amount) * 100) !== payment.amountCents || data.currency !== 'MXN' || Number(data.tip_amount || 0) !== 0) {
    throw error('No se pudo validar el importe y la referencia del pago.', 409, 'PAYMENT_MISMATCH');
  }
  const status = String(data.status || '').toLowerCase();
  if (status === 'approved' && Number(data.amount_refunded || 0) === 0) return 'SUCCEEDED';
  if (status === 'cancelled') return 'CANCELED';
  if (['rejected', 'refunded'].includes(status) || (status === 'approved' && Number(data.amount_refunded) > 0)) return 'FAILED';
  if (['pending', 'authorized'].includes(status)) return 'PENDING';
  throw error('Clip devolvió un estado de pago desconocido. Verifica nuevamente.', 502, 'PAYMENT_UNCONFIRMED');
}

function paymentAction(data) {
  if (data?.pending_action?.type !== 'open_modal') return null;
  try {
    const url = new URL(data.pending_action.url);
    return url.protocol === 'https:' && !url.username && !url.password ? { type: 'open_modal', url: url.href } : null;
  } catch { return null; }
}

function paymentCustomer(value) {
  const email = String(value?.email || '').trim();
  const phone = String(value?.phone || '').replace(/\D/g, '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || phone.length < 10 || phone.length > 15) {
    throw error('Escribe un correo válido y un teléfono de al menos 10 dígitos.', 400, 'INVALID_CUSTOMER');
  }
  const customer = { email, phone };
  const address = value?.address;
  if (address && ['postal_code', 'street', 'exterior_number'].some((key) => address[key])) {
    customer.address = {};
    for (const key of ['postal_code', 'street', 'exterior_number']) {
      const text = String(address[key] || '').trim();
      if (!text || text.length > 150) throw error('Completa código postal, calle y número de tu dirección de facturación.', 400, 'INVALID_CUSTOMER');
      customer.address[key] = text;
    }
  }
  return customer;
}

async function chargeTransparentPayment(client, model, payment, cardToken, customerValue, fetcher) {
  assertEnvironment(payment);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(String(cardToken || ''))) throw error('Token de tarjeta inválido.', 400, 'INVALID_CARD_TOKEN');
  const customer = paymentCustomer(customerValue);
  let webhook;
  try { webhook = new URL(`/api/payments/clip/transparent/webhook?payment=${encodeURIComponent(payment.id)}`, process.env.API_PUBLIC_URL); }
  catch { throw error('Falta configurar API_PUBLIC_URL en el backend.', 503, 'CLIP_NOT_CONFIGURED'); }
  if (webhook.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw error('La dirección pública del backend debe usar HTTPS.', 503);
  const claimed = await client[model].updateMany({ where: { id: payment.id, status: 'PENDING', clipFlow: 'TRANSPARENT',
    providerPaymentId: null, clipChargeStartedAt: null }, data: { clipChargeStartedAt: new Date() } });
  if (!claimed.count) return client[model].findUnique({ where: { id: payment.id } });
  try {
    const data = await paymentRequest('POST', null, {
      amount: payment.amountCents / 100, currency: 'MXN', capture_method: 'automatic', installments: 1, tip_amount: 0,
      description: model === 'recharge' ? 'Recarga de saldo AGUA/24' : `Premium mensual de ${payment.machineId}`,
      external_reference: payment.id, payment_method: { token: cardToken }, customer, webhook_url: webhook.href,
    }, fetcher);
    verifiedTransparentStatus(payment, data);
    // Save the provider ID before any wallet change. Subsequent attempts only consult this payment.
    await client[model].updateMany({ where: { id: payment.id, providerPaymentId: null }, data: { providerPaymentId: data.id } });
    const saved = await client[model].findUnique({ where: { id: payment.id } });
    if (saved) chargeProofs.set(saved, data);
    return saved;
  } catch (failure) {
    if (failure.definitiveRejection) await client[model].updateMany({ where: { id: payment.id, status: 'PENDING', providerPaymentId: null }, data: { status: 'FAILED' } });
    throw failure;
  }
}

async function transparentProof(payment, fetcher) {
  assertEnvironment(payment);
  const proof = chargeProofs.get(payment);
  if (proof) { chargeProofs.delete(payment); verifiedTransparentStatus(payment, proof); return proof; }
  return paymentRequest('GET', payment.providerPaymentId, null, fetcher);
}

module.exports = { transparentConfig, assertEnvironment, paymentRequest, verifiedTransparentStatus,
  paymentAction, paymentCustomer, chargeTransparentPayment, transparentProof };
