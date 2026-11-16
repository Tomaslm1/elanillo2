// Cliente Prisma único para toda la app (Prisma 7 exige driver adapter).
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

let prisma;

function getPrisma() {
  if (!prisma) {
    if (!process.env.DATABASE_URL) {
      throw new Error('Falta DATABASE_URL (ver backend/.env.example)');
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }
  return prisma;
}

async function disconnect() {
  if (prisma) await prisma.$disconnect();
  prisma = undefined;
}

module.exports = { getPrisma, disconnect };
