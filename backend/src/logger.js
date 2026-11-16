// Logging estructurado en JSON (una línea por evento), apto para Docker/agregadores.
// En tests queda en silencio salvo que LOG_LEVEL lo pida.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function currentLevel() {
  const fallback = process.env.NODE_ENV === 'test' ? 'silent' : 'info';
  return LEVELS[process.env.LOG_LEVEL || fallback] ?? LEVELS.info;
}

function log(level, msg, fields = {}) {
  if (LEVELS[level] < currentLevel()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

const logger = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};

// Middleware: registra cada request con su duración y un id de correlación (X-Request-Id).
function requestLogger(req, res, next) {
  const started = process.hrtime.bigint();
  req.id = req.get('x-request-id') || require('crypto').randomUUID();
  res.set('X-Request-Id', req.id);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    metrics.requests += 1;
    if (res.statusCode >= 500) metrics.errors5xx += 1;
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.user?.id,
    });
  });
  next();
}

// Métricas básicas en memoria, expuestas en GET /metrics.
const metrics = { startedAt: Date.now(), requests: 0, errors5xx: 0, llmCalls: 0, llmErrors: 0 };

module.exports = { logger, requestLogger, metrics };
