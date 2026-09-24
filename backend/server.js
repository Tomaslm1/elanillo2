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
  },
];

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
  };
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
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
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

  const match = await bcrypt.compare(String(password), user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = jwt.sign({ sub: user.id, username: user.username }, process.env.JWT_SECRET || 'dev-secret', {
    expiresIn: '1h',
  });

  // Set cookie HttpOnly (no accesible desde JS). Frontend debe enviar credentials: 'include'.
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000, // 1 hora en ms
  });

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
  passwordResetTokens.set(hashResetToken(token), {
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

  const tokenHash = hashResetToken(token);
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

// Optional: route para comprobar token (ejemplo de dashboard)
app.get('/api/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    return res.json({ user: payload });
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
  }
});

// Start server si se ejecuta directamente
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}

module.exports = app;
