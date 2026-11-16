// Cada archivo de test parte con la base vacía + el usuario demo (test@example.com / password123).
const bcrypt = require('bcryptjs');
const { getPrisma, disconnect } = require('../../src/db');

const TABLES = ['ai_jobs', 'audit_logs', 'questions', 'messages', 'stage_versions', 'project_stages', 'project_members', 'projects', 'refresh_tokens', 'password_reset_tokens', 'users'];

async function resetDatabase() {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  await prisma.user.create({
    data: { email: 'test@example.com', name: 'Usuario Demo', passwordHash: bcrypt.hashSync('password123', 4), authProvider: 'LOCAL' },
  });
}

beforeAll(resetDatabase);
afterAll(disconnect);

module.exports = { resetDatabase };
