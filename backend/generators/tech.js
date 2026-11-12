// Reconocimiento de tecnologías por palabra clave, compartido por operaciones (66) y coherencia (67).
// Devuelve una "familia" (postgresql, node, react...) o null si no se reconoce.
const has = (tech, ...words) => words.some((word) => tech.includes(word));

function databaseFamily(raw) {
  const tech = String(raw || '').toLowerCase();
  if (has(tech, 'postgres')) return 'postgresql';
  if (has(tech, 'mysql', 'mariadb')) return 'mysql';
  if (has(tech, 'mongo')) return 'mongodb';
  if (has(tech, 'sqlite')) return 'sqlite';
  if (has(tech, 'sql server', 'sqlserver', 'mssql')) return 'sqlserver';
  if (has(tech, 'dynamo')) return 'dynamodb';
  if (has(tech, 'firestore', 'firebase')) return 'firestore';
  if (has(tech, 'redis')) return 'redis';
  return null;
}

function backendFamily(raw) {
  const tech = String(raw || '').toLowerCase();
  if (has(tech, 'python', 'django', 'flask', 'fastapi')) return 'python';
  if (has(tech, 'node', 'express', 'nest', 'fastify')) return 'node';
  if (has(tech, 'java', 'spring', 'kotlin')) return 'java';
  if (has(tech, '.net', 'dotnet', 'c#', 'asp')) return 'dotnet';
  if (has(tech, 'php', 'laravel')) return 'php';
  if (has(tech, 'ruby', 'rails')) return 'ruby';
  if (/\bgo(lang)?\b/.test(tech) || has(tech, 'gin')) return 'go';
  return null;
}

function frontendFamily(raw) {
  const tech = String(raw || '').toLowerCase();
  if (has(tech, 'react', 'next')) return 'react';
  if (has(tech, 'vue', 'nuxt')) return 'vue';
  if (has(tech, 'angular')) return 'angular';
  if (has(tech, 'svelte')) return 'svelte';
  if (has(tech, 'html', 'vanilla')) return 'vanilla';
  return null;
}

module.exports = { databaseFamily, backendFamily, frontendFamily };
