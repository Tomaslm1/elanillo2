require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const app = express();
const passwordResetTokens = new Map();
const resetTokenTtlMs = Number(process.env.RESET_TOKEN_TTL_MINUTES || 15) * 60 * 1000;

// --- Sesión: access token (corto, JWT) + refresh token (largo, opaco) ---
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const accessTokenTtlMs = Number(process.env.ACCESS_TOKEN_TTL_MINUTES || 15) * 60 * 1000;
const refreshTokenTtlMs = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
// hash del refresh token -> { userId, expiresAt }. Se guarda el hash, nunca el token en claro.
// En memoria igual que passwordResetTokens: se pierde al reiniciar. En producción va a la BD.
const refreshTokens = new Map();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, '../frontend')));

/**
 * Demo users store.
 * En producción reemplazar por consulta a BD (Prisma/u otro).
 * Aquí la contraseña en texto para generar el hash; en la repo se guarda el hash.
 */
const users = [
  {
    id: 1,
    username: 'test@example.com',
    name: 'Usuario Demo',
    passwordHash: bcrypt.hashSync('password123', 8),
    authProvider: 'local',
  },
];

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function findUserById(id) {
  return users.find((user) => String(user.id) === String(id));
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
function issueSession(res, user) {
  const accessToken = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: Math.floor(accessTokenTtlMs / 1000),
  });
  const refreshToken = crypto.randomBytes(48).toString('hex');
  refreshTokens.set(hashToken(refreshToken), { userId: user.id, expiresAt: Date.now() + refreshTokenTtlMs });

  res.cookie('token', accessToken, cookieOptions(accessTokenTtlMs));
  // path '/api': el navegador solo envía el refresh token a rutas de la API, no a archivos estáticos.
  res.cookie('refresh_token', refreshToken, cookieOptions(refreshTokenTtlMs, { path: '/api' }));
}

function clearSession(res) {
  const base = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' };
  res.clearCookie('token', base);
  res.clearCookie('refresh_token', { ...base, path: '/api' });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.post('/api/register', async (req, res) => {
  const { username, password, name } = req.body || {};
  const cleanUsername = String(username || '').trim();
  const cleanPassword = String(password || '').trim();
  const cleanName = String(name || '').trim();

  if (!cleanUsername || !cleanPassword || !cleanName) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  const existingUser = users.find((user) => user.username.toLowerCase() === cleanUsername.toLowerCase());
  if (existingUser) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }

  const newUser = {
    id: Date.now(),
    username: cleanUsername,
    name: cleanName,
    passwordHash: bcrypt.hashSync(cleanPassword, 8),
    authProvider: 'local',
  };

  users.push(newUser);

  return res.status(201).json({
    message: 'Usuario registrado correctamente',
    user: serializeUser(newUser),
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });

  const user = users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
  // Los usuarios creados por SSO no tienen contraseña: bcrypt.compare fallaría con null.
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'Credenciales inválidas' });

  const match = await bcrypt.compare(String(password), user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

  issueSession(res, user);

  return res.json({
    message: 'Autenticado',
    user: serializeUser(user),
  });
});

app.post('/api/request-password-reset', (req, res) => {
  const cleanUsername = String(req.body?.username || req.body?.email || '').trim();
  const response = {
    message: 'Si la cuenta existe, recibirás instrucciones para restablecer tu contraseña.',
  };

  if (!cleanUsername) {
    return res.status(400).json({ error: 'Ingresa un correo electrónico' });
  }

  const user = users.find((candidate) => candidate.username.toLowerCase() === cleanUsername.toLowerCase());
  if (!user) return res.json(response);

  const token = crypto.randomBytes(32).toString('hex');
  passwordResetTokens.set(hashToken(token), {
    userId: user.id,
    expiresAt: Date.now() + resetTokenTtlMs,
  });

  // Mientras no exista un proveedor de correo, se devuelve para completar el flujo en desarrollo.
  return res.json({ ...response, resetToken: token });
});

app.post('/api/reset-password', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const newPassword = String(req.body?.password || '');

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'El token y la nueva contraseña son obligatorios' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  const tokenHash = hashToken(token);
  const resetRequest = passwordResetTokens.get(tokenHash);
  if (!resetRequest) return res.status(400).json({ error: 'El enlace de recuperación no es válido' });
  if (resetRequest.expiresAt <= Date.now()) {
    passwordResetTokens.delete(tokenHash);
    return res.status(400).json({ error: 'El enlace de recuperación expiró' });
  }

  const user = users.find((candidate) => candidate.id === resetRequest.userId);
  if (!user) {
    passwordResetTokens.delete(tokenHash);
    return res.status(400).json({ error: 'El enlace de recuperación no es válido' });
  }

  user.passwordHash = await bcrypt.hash(newPassword, 8);
  passwordResetTokens.delete(tokenHash);
  return res.json({ message: 'Contraseña actualizada correctamente' });
});

// Devuelve el usuario de la sesión actual.
// Si el access token venció responde 401 (con code) y el frontend llama a /api/refresh.
app.get('/api/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autenticado', code: 'NO_TOKEN' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
    return res.json({ user: serializeUser(user) });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
  }
});

// Cambia un refresh token válido por un access token nuevo.
// Rotación: el refresh token es de un solo uso; se entrega uno nuevo en cada llamada.
app.post('/api/refresh', (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    return res.status(401).json({ error: 'No hay sesión para renovar', code: 'NO_REFRESH_TOKEN' });
  }

  const key = hashToken(refreshToken);
  const stored = refreshTokens.get(key);
  if (!stored) {
    clearSession(res);
    return res.status(401).json({ error: 'Refresh token inválido', code: 'INVALID_REFRESH_TOKEN' });
  }

  refreshTokens.delete(key); // se consume siempre, esté vencido o no
  if (stored.expiresAt <= Date.now()) {
    clearSession(res);
    return res.status(401).json({ error: 'La sesión expiró, inicia sesión de nuevo', code: 'REFRESH_TOKEN_EXPIRED' });
  }

  const user = findUserById(stored.userId);
  if (!user) {
    clearSession(res);
    return res.status(401).json({ error: 'Refresh token inválido', code: 'INVALID_REFRESH_TOKEN' });
  }

  issueSession(res, user);
  return res.json({ message: 'Sesión renovada', user: serializeUser(user) });
});

// Cierra sesión: revoca el refresh token en el servidor y borra las cookies.
app.post('/api/logout', (req, res) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) refreshTokens.delete(hashToken(refreshToken));
  clearSession(res);
  return res.json({ message: 'Sesión cerrada' });
});

// --- SSO con Google (OAuth 2.0 / OpenID Connect, flujo "authorization code") ---
// Flujo: botón -> GET /api/auth/google -> Google -> GET /api/auth/google/callback -> redirect al frontend.
// Variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (opcional), FRONTEND_URL (opcional).
// Se leen dentro de las funciones (no al cargar el módulo) para poder cambiarlas en tests.
const ssoCookiePath = '/api/auth';

function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      `http://localhost:${process.env.PORT || 3001}/api/auth/google/callback`,
  };
}

// El callback es una navegación del navegador, no un fetch: no se puede responder JSON.
// Por eso se redirige al frontend con ?sso=success o ?sso_error=<codigo>.
function redirectToFrontend(res, params) {
  const url = new URL(process.env.FRONTEND_URL || 'http://localhost:3001');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return res.redirect(url.toString());
}

app.get('/api/auth/google', (req, res) => {
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

app.get('/api/auth/google/callback', async (req, res) => {
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
    const email = String(profile.email).toLowerCase();
    let user = users.find((candidate) => candidate.username.toLowerCase() === email);

    // No se vincula automáticamente a una cuenta con contraseña: este backend no verifica
    // correos al registrarse, así que alguien podría haber creado esa cuenta con el correo de otra persona.
    if (user && user.authProvider !== 'google') {
      return redirectToFrontend(res, { sso_error: 'account_exists' });
    }
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        username: email,
        name: profile.name || email,
        passwordHash: null,
        authProvider: 'google',
        providerId: profile.sub,
      };
      users.push(user);
    }

    // 4) Misma sesión que el login normal (access + refresh en cookies).
    issueSession(res, user);
    return redirectToFrontend(res, { sso: 'success' });
  } catch (err) {
    return redirectToFrontend(res, { sso_error: 'sso_failed' });
  }
});

// Start server si se ejecuta directamente
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}

module.exports = app;
