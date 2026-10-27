// Cliente único de Prisma 7 (con el adaptador de PostgreSQL). Se crea una sola vez y se reutiliza.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

let prisma;

function getPrisma() {
  if (!prisma) {
    if (!process.env.DATABASE_URL) {
      throw new Error('Falta DATABASE_URL en backend/.env (copia el ejemplo de .env.example)');
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }
  return prisma;
}

async function disconnect() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

module.exports = { getPrisma, disconnect };
