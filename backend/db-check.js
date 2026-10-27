// Comprueba la conexión con la base:  npm run db:check
const { getPrisma, disconnect } = require('./db');

(async () => {
  try {
    const tables = await getPrisma().$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    console.log('Conexión OK. Tablas en la base:', tables.map((t) => t.table_name).join(', ') || '(ninguna todavía)');
  } catch (err) {
    console.log('FALLO la conexión:', err.code || err.name, '-', String(err.message).split('\n')[0]);
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
})();
