// Crea el usuario demo para desarrollo: test@example.com / password123
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { getPrisma, disconnect } = require('../src/db');

(async () => {
  const prisma = getPrisma();
  await prisma.user.upsert({
    where: { email: 'test@example.com' },
    update: {},
    create: { email: 'test@example.com', name: 'Usuario Demo', passwordHash: bcrypt.hashSync('password123', 10) },
  });
  console.log('Usuario demo listo: test@example.com / password123');
  await disconnect();
})();
