// Aplica las migraciones a la base de datos de test una vez antes de toda la suite.
const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  const url = process.env.DATABASE_URL_TEST || 'postgresql://ideator:ideator@localhost:5433/ideator_test?schema=public';
  execSync('npx prisma migrate deploy', {
    cwd: path.join(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
};
