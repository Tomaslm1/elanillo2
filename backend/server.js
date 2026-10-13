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

// Middleware: exige un access token válido y deja el usuario en req.user.
// Lo usan /api/me y todas las rutas de proyectos.
// Si el access token venció responde 401 (con code) y el frontend llama a /api/refresh.
function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autenticado', code: 'NO_TOKEN' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
    req.user = user;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token inválido', code: 'INVALID_TOKEN' });
  }
}

// Devuelve el usuario de la sesión actual.
app.get('/api/me', requireAuth, (req, res) => {
  return res.json({ user: serializeUser(req.user) });
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

// --- Proyectos y colaboradores ---
// En memoria igual que users. Cada proyecto guarda sus miembros con un rol:
//   owner  -> creó el proyecto; es el único que puede invitar (se asigna solo al crear)
//   editor / viewer -> roles que se pueden asignar al invitar
// El owner también está en `members`, así "ya es miembro" cubre también el caso de invitarse a sí mismo.
const projects = [];
const INVITABLE_ROLES = ['editor', 'viewer'];
const PROJECT_NAME_MAX = 80;
const PROJECT_DESCRIPTION_MAX = 300;

function sameId(a, b) {
  return String(a) === String(b);
}

function findMembership(project, userId) {
  return project.members.find((member) => sameId(member.userId, userId));
}

// Un proyecto visto desde un usuario concreto: incluye el rol que ese usuario tiene en él.
function serializeProject(project, userId) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    role: findMembership(project, userId)?.role,
    memberCount: project.members.length,
    createdAt: project.createdAt,
  };
}

// Lista solo los proyectos donde el usuario es miembro (como owner o invitado).
app.get('/api/projects', requireAuth, (req, res) => {
  const mine = projects
    .filter((project) => findMembership(project, req.user.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((project) => serializeProject(project, req.user.id));
  return res.json({ projects: mine });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();

  if (!name) return res.status(400).json({ error: 'El nombre del proyecto es obligatorio' });
  if (name.length > PROJECT_NAME_MAX) {
    return res.status(400).json({ error: `El nombre no puede superar ${PROJECT_NAME_MAX} caracteres` });
  }
  if (description.length > PROJECT_DESCRIPTION_MAX) {
    return res.status(400).json({ error: `La descripción no puede superar ${PROJECT_DESCRIPTION_MAX} caracteres` });
  }

  const project = {
    id: crypto.randomUUID(),
    name,
    description,
    createdAt: Date.now(),
    members: [{ userId: req.user.id, role: 'owner' }],
    outcomes: [], // resultados esperados del producto (ver más abajo)
  };
  projects.push(project);

  return res.status(201).json({ project: serializeProject(project, req.user.id) });
});

// Invitar colaborador: body { email, role }. Solo el owner puede hacerlo.
// El orden de las validaciones importa:
//   404 -> el proyecto no existe, o existe pero quien pregunta no es miembro (no se revela que existe)
//   403 -> es miembro pero no owner
//   400 -> datos inválidos (recién acá, para no dar detalles a quien no tiene permiso)
//   404 -> el correo no pertenece a ningún usuario
//   409 -> ya es miembro
app.post('/api/projects/:projectId/members', requireAuth, (req, res) => {
  const project = projects.find((candidate) => candidate.id === req.params.projectId);
  const requesterMembership = project && findMembership(project, req.user.id);
  if (!requesterMembership) return res.status(404).json({ error: 'Proyecto no encontrado' });
  if (requesterMembership.role !== 'owner') {
    return res.status(403).json({ error: 'Solo el propietario puede invitar colaboradores' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = String(req.body?.role || '').trim();
  if (!email) return res.status(400).json({ error: 'Ingresa el correo del colaborador' });
  if (!INVITABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `El rol debe ser uno de: ${INVITABLE_ROLES.join(', ')}` });
  }

  const invitedUser = users.find((candidate) => candidate.username.toLowerCase() === email);
  if (!invitedUser) return res.status(404).json({ error: 'No existe un usuario registrado con ese correo' });

  if (findMembership(project, invitedUser.id)) {
    return res.status(409).json({ error: 'El usuario ya es miembro del proyecto' });
  }

  project.members.push({ userId: invitedUser.id, role });
  return res.status(201).json({
    message: 'Colaborador agregado',
    member: { ...serializeUser(invitedUser), role },
  });
});

// --- Edición concurrente: versionado optimista ---
// Cada elemento editable (resultado, funcionalidad, respuesta...) tiene un número `version`
// que empieza en 1 y sube con cada cambio. Para modificarlo o borrarlo, el cliente envía la
// versión que vio. Si no coincide, alguien más lo cambió antes: se responde 409 con el valor actual
// y NO se guarda nada, así nadie pisa el trabajo de otro sin enterarse.
// Node ejecuta cada petición de corrido (sin await en medio), por eso "comprobar + guardar" es atómico.
function parseVersion(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const version = Number(raw);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

// --- Permisos dentro de un proyecto ---
// owner y editor pueden modificar contenido; viewer solo lee.
const EDITOR_ROLES = ['owner', 'editor'];

// Carga el proyecto y comprueba que quien pregunta es miembro.
// Si no lo es responde 404 (no se revela que el proyecto existe) y devuelve null.
function loadProjectForMember(req, res) {
  const project = projects.find((candidate) => candidate.id === req.params.projectId);
  const membership = project && findMembership(project, req.user.id);
  if (!membership) {
    res.status(404).json({ error: 'Proyecto no encontrado' });
    return null;
  }
  return { project, membership };
}

function requireEditor(membership, res) {
  if (EDITOR_ROLES.includes(membership.role)) return true;
  res.status(403).json({ error: 'No tienes permiso para editar este proyecto' });
  return false;
}

// --- Resultados esperados del producto ---
// Cada resultado: qué se espera lograr (title), cómo se mide (metric) y la meta (target).
const OUTCOME_LIMITS = {
  title: { label: 'El resultado esperado', max: 120 },
  metric: { label: 'La métrica', max: 160 },
  target: { label: 'La meta', max: 80 },
};

function parseOutcomeFields(body) {
  const fields = {};
  for (const [key, { label, max }] of Object.entries(OUTCOME_LIMITS)) {
    fields[key] = String(body?.[key] ?? '').trim();
    if (fields[key].length > max) return { error: `${label} no puede superar ${max} caracteres` };
  }
  if (!fields.title) return { error: 'El resultado esperado es obligatorio' };
  return { fields };
}

function serializeOutcome(outcome) {
  const author = findUserById(outcome.updatedBy);
  return {
    id: outcome.id,
    title: outcome.title,
    metric: outcome.metric,
    target: outcome.target,
    version: outcome.version,
    updatedAt: outcome.updatedAt,
    updatedByName: author?.name || author?.username || null, // para mostrar "modificado por ..."
  };
}

function conflictResponse(res, outcome) {
  return res.status(409).json({
    error: 'Otra persona modificó este resultado mientras lo editabas',
    code: 'VERSION_CONFLICT',
    current: serializeOutcome(outcome),
  });
}

// Cualquier miembro (también viewer) puede ver. `canEdit` le dice al frontend si mostrar los controles.
app.get('/api/projects/:projectId/outcomes', requireAuth, (req, res) => {
  const ctx = loadProjectForMember(req, res);
  if (!ctx) return;
  return res.json({
    outcomes: ctx.project.outcomes.map(serializeOutcome),
    canEdit: EDITOR_ROLES.includes(ctx.membership.role),
  });
});

app.post('/api/projects/:projectId/outcomes', requireAuth, (req, res) => {
  const ctx = loadProjectForMember(req, res);
  if (!ctx || !requireEditor(ctx.membership, res)) return;

  const { fields, error } = parseOutcomeFields(req.body);
  if (error) return res.status(400).json({ error });

  const outcome = {
    id: crypto.randomUUID(),
    ...fields,
    version: 1,
    updatedBy: req.user.id,
    updatedAt: Date.now(),
  };
  ctx.project.outcomes.push(outcome);
  return res.status(201).json({ outcome: serializeOutcome(outcome) });
});

// Editar: body { title, metric, target, version }. `version` es obligatoria (la que el cliente vio).
app.put('/api/projects/:projectId/outcomes/:outcomeId', requireAuth, (req, res) => {
  const ctx = loadProjectForMember(req, res);
  if (!ctx || !requireEditor(ctx.membership, res)) return;

  const outcome = ctx.project.outcomes.find((candidate) => candidate.id === req.params.outcomeId);
  if (!outcome) return res.status(404).json({ error: 'El resultado ya no existe' });

  const version = parseVersion(req.body?.version);
  if (!version) return res.status(400).json({ error: 'Falta la versión que estás editando' });

  const { fields, error } = parseOutcomeFields(req.body);
  if (error) return res.status(400).json({ error });

  if (version !== outcome.version) return conflictResponse(res, outcome);

  Object.assign(outcome, fields, { version: outcome.version + 1, updatedBy: req.user.id, updatedAt: Date.now() });
  return res.json({ outcome: serializeOutcome(outcome) });
});

// Eliminar: la versión va en la URL (?version=N). Si alguien editó el resultado mientras tanto,
// también responde 409: borrarlo descartaría en silencio el cambio de esa persona.
app.delete('/api/projects/:projectId/outcomes/:outcomeId', requireAuth, (req, res) => {
  const ctx = loadProjectForMember(req, res);
  if (!ctx || !requireEditor(ctx.membership, res)) return;

  const index = ctx.project.outcomes.findIndex((candidate) => candidate.id === req.params.outcomeId);
  if (index === -1) return res.status(404).json({ error: 'El resultado ya no existe' });
  const outcome = ctx.project.outcomes[index];

  const version = parseVersion(req.query.version);
  if (!version) return res.status(400).json({ error: 'Falta la versión que estás eliminando' });
  if (version !== outcome.version) return conflictResponse(res, outcome);

  ctx.project.outcomes.splice(index, 1);
  return res.json({ message: 'Resultado eliminado' });
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
