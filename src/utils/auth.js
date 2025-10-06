// src/utils/auth.js
const { verifyToken } = require('@clerk/backend');

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    // Verifica el token emitido por Clerk
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY, // usa tu clave de Clerk (server)
      // Recomendado (si creas una plantilla de JWT):
      // audience: 'aquaqr-api',
    });

    req.auth = { userId: payload.sub };
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { requireAuth };
