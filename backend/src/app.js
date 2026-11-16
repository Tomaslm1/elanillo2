// Configuración de Express: middlewares, rutas, health/metrics y manejo centralizado de errores.
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { getPrisma } = require('./db');
const { HttpError } = require('./http');
const { logger, requestLogger, metrics } = require('./logger');
const auth = require('./auth');
const projects = require('./projects');

const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '../../frontend');

function allowedOrigins() {
  return (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const app = express();
app.disable('x-powered-by');
app.use(requestLogger);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
// Solo los orígenes configurados pueden hacer requests con cookies (antes se aceptaba cualquiera).
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.static(FRONTEND_DIR));

app.get('/', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// Liveness + readiness (verifica conexión a la base de datos).
app.get('/health', async (req, res) => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return res.json({ status: 'ok', db: 'ok', uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000) });
  } catch (err) {
    logger.error('health_db_error', { error: err.message });
    return res.status(503).json({ status: 'degraded', db: 'unavailable' });
  }
});

app.get('/metrics', (req, res) => res.json({ ...metrics, uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000) }));

app.use('/api', auth.router);
app.use('/api/projects', projects.router);

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'El contenido es demasiado grande' });
  logger.error('unhandled_error', { requestId: req.id, error: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Error interno del servidor', requestId: req.id });
});

module.exports = app;
