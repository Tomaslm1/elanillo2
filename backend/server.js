require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json());
app.use(cookieParser());

/**
 * Demo users store.
 * En producción reemplazar por consulta a BD (Prisma/u otro).
 * Aquí la contraseña en texto para generar el hash; en la repo se guarda el hash.
 */
const users = [
  {
    id: 1,
    username: 'test@example.com',
    // password: 'password123'
    passwordHash: bcrypt.hashSync('password123', 8),
  },
];

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });

  const user = users.find((u) => u.username === username);
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

  const match = await bcrypt.compare(password, user.passwordHash);
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

  return res.json({ message: 'Autenticado' });
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
