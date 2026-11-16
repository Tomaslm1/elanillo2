// Punto de entrada. La app está en src/app.js (se exporta para los tests).
require('dotenv').config({ quiet: true });
const app = require('./src/app');
const { logger } = require('./src/logger');

if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    logger.error('missing_config', { error: 'JWT_SECRET es obligatorio en producción' });
    process.exit(1);
  }
  const PORT = process.env.PORT || 3001;
  require('./src/jobs').failStaleJobs().catch((err) => logger.error('stale_jobs_error', { error: err.message }));
  const server = app.listen(PORT, () => logger.info('server_started', { port: Number(PORT) }));
  // Los turnos de IA corren en segundo plano, pero ?wait=true (scripts) puede esperar varios minutos.
  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 15 * 60 * 1000 + 1000;
}

module.exports = app;
