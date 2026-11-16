// Autenticación: registro, login local, recuperación de contraseña, sesión (access + refresh) y SSO con Google.
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getPrisma } = require('./db');
const { asyncHandler } = require('./http');
const { logger } = require('./logger');

const BCRYPT_ROUNDS = process.env.NODE_ENV === 'test' ? 4 : 10;
const PASSWORD_MIN = 6;

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET es obligatorio en producción');
    return 'dev-secret-solo-para-desarrollo';
  }
  return secret;
}

const accessTokenTtlMs = () => Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15) * 60 * 1000;
const refreshTokenTtlMs = () => Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
const resetTokenTtlMs = () => Number(process.env.RESET_TOKEN_TTL_MINUTES || 15) * 60 * 1000;

// La API expone `username` (= email) por compatibilidad con el frontend existente.
function serializeUser(user) {
  return { id: user.id, username: user.email, name: user.name };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cookieOptions(maxAge, extra = {}) {
  return {
    httpOnly: true, // no accesible desde JS
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge,
    ...extra,
  };
}

// Emite access token + refresh token y los deja en cookies HttpOnly.
// Lo usan login, refresh y SSO, así la sesión se crea siempre igual.
async function issueSession(res, user) {
  const accessTtl = accessTokenTtlMs();
  const refreshTtl = refreshTokenTtlMs();
  const accessToken = jwt.sign({ sub: user.id, username: user.email }, jwtSecret(), {
    expiresIn: Math.floor(accessTtl / 1000),
  });
  const refreshToken = crypto.randomBytes(48).toString('hex');
  await getPrisma().refreshToken.create({
    data: { tokenHash: hashToken(refreshToken), userId: user.id, expiresAt: new Date(Date.now() + refreshTtl) },
  });

  res.cookie('token', accessToken, cookieOptions(accessTtl));
  // path '/api': el navegador solo envía el refresh token a rutas de la API, no a archivos estáticos.
  res.cookie('refresh_token', refreshToken, cookieOptions(refreshTtl, { path: '/api' }));
}

function clearSession(res) {
  const base = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' };
  res.clearCookie('token', base);
  res.clearCookie('refresh_token', { ...base, path: '/api' });
}

// Middleware: exige un access token válido y deja el usuario en req.user.
// 401 = no hay identidad válida (autenticación). Los 403/404 de permisos se resuelven en cada ruta (autorización).
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autenticado', code: 'NO_TOKEN' });
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
  }
  const user = await getPrisma().user.findUnique({ where: { id: String(payload.sub) } });
  if (!user || !user.isActive) return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
  req.user = user;
  return next();
});

const router = express.Router();

router.post('/register', asyncHandler(async (req, res) => {
  const { username, password, name } = req.body || {};
  const email = normalizeEmail(username);
  const cleanPassword = String(password || '').trim();
  const cleanName = String(name || '').trim();

  if (!email || !cleanPassword || !cleanName) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }
  if (cleanPassword.length < PASSWORD_MIN) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres` });
  }

  const prisma = getPrisma();
  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }

  const newUser = await prisma.user.create({
    data: { email, name: cleanName, passwordHash: await bcrypt.hash(cleanPassword, BCRYPT_ROUNDS), authProvider: 'LOCAL' },
  });

  return res.status(201).json({ message: 'Usuario registrado correctamente', user: serializeUser(newUser) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { email: normalizeEmail(username) } });
  // Los usuarios creados por SSO no tienen contraseña: bcrypt.compare fallaría con null.
  if (!user || !user.passwordHash || !user.isActive) return res.status(401).json({ error: 'Credenciales inválidas' });

  const match = await bcrypt.compare(String(password), user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await issueSession(res, user);
  return res.json({ message: 'Autenticado', user: serializeUser(user) });
}));

router.post('/request-password-reset', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.username || req.body?.email);
  const response = { message: 'Si la cuenta existe, recibirás instrucciones para restablecer tu contraseña.' };

  if (!email) return res.status(400).json({ error: 'Ingresa un correo electrónico' });

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.json(response);

  const token = crypto.randomBytes(32).toString('hex');
  await prisma.passwordResetToken.create({
    data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + resetTokenTtlMs()) },
  });

  // Mientras no exista un proveedor de correo, en desarrollo se devuelve el token para completar el flujo.
  if (process.env.NODE_ENV === 'production') return res.json(response);
  return res.json({ ...response, resetToken: token });
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const newPassword = String(req.body?.password || '');

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'El token y la nueva contraseña son obligatorios' });
  }
  if (newPassword.length < PASSWORD_MIN) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres` });
  }

  const prisma = getPrisma();
  const tokenHash = hashToken(token);
  const resetRequest = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!resetRequest) return res.status(400).json({ error: 'El enlace de recuperación no es válido' });
  if (resetRequest.expiresAt.getTime() <= Date.now()) {
    await prisma.passwordResetToken.delete({ where: { tokenHash } });
    return res.status(400).json({ error: 'El enlace de recuperación expiró' });
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetRequest.userId },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
    }),
    prisma.passwordResetToken.delete({ where: { tokenHash } }),
    // Cambiar la contraseña cierra todas las sesiones abiertas.
    prisma.refreshToken.deleteMany({ where: { userId: resetRequest.userId } }),
  ]);
  return res.json({ message: 'Contraseña actualizada correctamente' });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: serializeUser(req.user) }));

// Cambia un refresh token válido por un access token nuevo.
// Rotación: el refresh token es de un solo uso; se entrega uno nuevo en cada llamada.
router.post('/refresh', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ error: 'No hay sesión para renovar', code: 'NO_REFRESH_TOKEN' });
  }

  const prisma = getPrisma();
  const tokenHash = hashToken(refreshToken);
  // deleteMany + count evita que dos renovaciones simultáneas usen el mismo token.
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
  const { count } = await prisma.refreshToken.deleteMany({ where: { tokenHash } });
  if (!stored || count === 0) {
    clearSession(res);
    return res.status(401).json({ error: 'Refresh token inválido', code: 'INVALID_REFRESH_TOKEN' });
  }
  if (stored.expiresAt.getTime() <= Date.now()) {
    clearSession(res);
    return res.status(401).json({ error: 'La sesión expiró, inicia sesión de nuevo', code: 'REFRESH_TOKEN_EXPIRED' });
  }
  if (!stored.user || !stored.user.isActive) {
    clearSession(res);
    return res.status(401).json({ error: 'Refresh token inválido', code: 'INVALID_REFRESH_TOKEN' });
  }

  await issueSession(res, stored.user);
  return res.json({ message: 'Sesión renovada', user: serializeUser(stored.user) });
}));

// Cierra sesión: revoca el refresh token en el servidor y borra las cookies.
router.post('/logout', asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) await getPrisma().refreshToken.deleteMany({ where: { tokenHash: hashToken(refreshToken) } });
  clearSession(res);
  return res.json({ message: 'Sesión cerrada' });
}));

// --- SSO con Google (OAuth 2.0 / OpenID Connect, flujo "authorization code") ---
// Flujo: botón -> GET /api/auth/google -> Google -> GET /api/auth/google/callback -> redirect al frontend.
// Las variables se leen dentro de las funciones (no al cargar el módulo) para poder cambiarlas en tests.
const ssoCookiePath = '/api/auth';

function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/auth/google/callback`,
  };
}

// El callback es una navegación del navegador, no un fetch: no se puede responder JSON.
function redirectToFrontend(res, params) {
  const url = new URL(process.env.FRONTEND_URL || 'http://localhost:3001');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return res.redirect(url.toString());
}

router.get('/auth/google', (req, res) => {
  const { clientId, clientSecret, redirectUri } = googleConfig();
  if (!clientId || !clientSecret) return redirectToFrontend(res, { sso_error: 'sso_not_configured' });

  // "state" protege contra CSRF: se guarda en una cookie y Google lo devuelve en el callback.
  const state = crypto.randomBytes(24).toString('hex');
  res.cookie('sso_state', state, cookieOptions(10 * 60 * 1000, { path: ssoCookiePath }));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const savedState = req.cookies?.sso_state;
  res.clearCookie('sso_state', { httpOnly: true, sameSite: 'lax', path: ssoCookiePath });

  if (error) {
    return redirectToFrontend(res, { sso_error: error === 'access_denied' ? 'access_denied' : 'sso_failed' });
  }
  if (!code || !state || !savedState || state !== savedState) {
    return redirectToFrontend(res, { sso_error: 'invalid_state' });
  }

  const { clientId, clientSecret, redirectUri } = googleConfig();
  try {
    // 1) Cambiar el "code" por un access token de Google (llamada servidor a servidor).
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok) return redirectToFrontend(res, { sso_error: 'sso_failed' });
    const { access_token: googleToken } = await tokenResponse.json();

    // 2) Pedir el perfil a Google.
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${googleToken}` },
    });
    if (!profileResponse.ok) return redirectToFrontend(res, { sso_error: 'sso_failed' });
    const profile = await profileResponse.json();

    if (!profile.email || !profile.email_verified) {
      return redirectToFrontend(res, { sso_error: 'email_not_verified' });
    }

    // 3) Buscar o crear el usuario local.
    const prisma = getPrisma();
    const email = normalizeEmail(profile.email);
    let user = await prisma.user.findUnique({ where: { email } });

    // No se vincula automáticamente a una cuenta con contraseña: este backend no verifica
    // correos al registrarse, así que alguien podría haber creado esa cuenta con el correo de otra persona.
    if (user && user.authProvider !== 'GOOGLE') {
      return redirectToFrontend(res, { sso_error: 'account_exists' });
    }
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: profile.name || email,
          passwordHash: null,
          authProvider: 'GOOGLE',
          providerId: profile.sub ? String(profile.sub) : null,
          emailVerified: true,
        },
      });
    }

    // 4) Misma sesión que el login normal (access + refresh en cookies).
    await issueSession(res, user);
    return redirectToFrontend(res, { sso: 'success' });
  } catch (err) {
    logger.error('sso_error', { error: err.message });
    return redirectToFrontend(res, { sso_error: 'sso_failed' });
  }
});

module.exports = { router, requireAuth, serializeUser, normalizeEmail };
