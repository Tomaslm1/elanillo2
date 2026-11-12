// SCRUM-67: coherencia entre la arquitectura elegida y las decisiones previas (base de datos,
// backend y frontend), más lo que ya se definió en el modelo de datos. Señala incompatibilidades:
// no las corrige, las explica y sugiere qué hacer. Determinista: sin IA.
const { databaseFamily, backendFamily, frontendFamily } = require('./tech');

const text = (value) => String(value ?? '').trim();

function parseArea(raw, label, keys) {
  if (raw === undefined) return { area: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: `"${label}" debe ser un objeto` };
  const area = {};
  for (const key of keys) {
    const value = text(raw[key]);
    if (value.length > 80) return { error: `"${label}.${key}" supera 80 caracteres` };
    if (value) area[key] = value;
  }
  if (Object.keys(area).length === 0) return { error: `"${label}" necesita al menos uno de: ${keys.join(', ')}` };
  return { area };
}

function validateDecisionsSpec(data) {
  const database = parseArea(data?.database, 'database', ['engine']);
  if (database.error) return { error: database.error };
  const backend = parseArea(data?.backend, 'backend', ['runtime', 'framework']);
  if (backend.error) return { error: backend.error };
  const frontend = parseArea(data?.frontend, 'frontend', ['framework']);
  if (frontend.error) return { error: frontend.error };
  if (!database.area && !backend.area && !frontend.area) return { error: 'Define al menos una decisión: database, backend o frontend' };
  return { data: { database: database.area, backend: backend.area, frontend: frontend.area } };
}

function checkCoherence({ architecture, decisions, model }) {
  const issues = [];
  const add = (level, code, message, suggestion) => issues.push({ level, code, message, suggestion });
  const components = architecture.components;
  const byRole = (role) => components.filter((c) => c.role === role);
  const checked = [];

  // Compara una decisión previa contra el componente de la arquitectura que cumple ese rol.
  // Devuelve la familia tecnológica si coinciden (la usan las reglas de más abajo).
  const compare = (area, label, decided, role, familyOf, mismatchCode, missingCode) => {
    if (!decided) return null;
    checked.push(area);
    const found = byRole(role);
    if (found.length === 0) {
      add('error', missingCode, `Ya se decidió ${label} (${decided}), pero la arquitectura no tiene un componente de ese tipo.`, `Agrega a la arquitectura un componente "${role}" con esa tecnología.`);
      return null;
    }
    const decidedFamily = familyOf(decided);
    const archFamilies = found.map((c) => familyOf(c.tech));
    if (!decidedFamily || archFamilies.every((f) => !f)) {
      add('warning', 'UNRECOGNIZED_TECH', `No se pudo comparar ${label}: "${decided}" frente a "${found.map((c) => c.tech).join(', ')}".`, 'Revisa a mano que ambas se refieran a la misma tecnología.');
      return null;
    }
    if (!archFamilies.includes(decidedFamily)) {
      add('error', mismatchCode, `Se decidió ${label} con ${decided}, pero la arquitectura usa ${found.map((c) => c.tech).join(', ')}.`, 'Cambia la arquitectura para usar lo ya decidido, o actualiza la decisión previa si el cambio es intencional.');
      return null;
    }
    return decidedFamily;
  };

  const decidedDb = decisions?.database ? decisions.database.engine : null;
  const decidedBackend = decisions?.backend ? [decisions.backend.runtime, decisions.backend.framework].filter(Boolean).join(' ') : null;
  const decidedFrontend = decisions?.frontend ? decisions.frontend.framework : null;

  const dbFamily = compare('database', 'la base de datos', decidedDb, 'database', databaseFamily, 'DATABASE_MISMATCH', 'DATABASE_MISSING');
  compare('backend', 'el backend', decidedBackend, 'backend', backendFamily, 'BACKEND_MISMATCH', 'BACKEND_MISSING');
  compare('frontend', 'el frontend', decidedFrontend, 'frontend', frontendFamily, 'FRONTEND_MISMATCH', 'FRONTEND_MISSING');

  if (!decidedDb && !decidedBackend && !decidedFrontend) {
    add('warning', 'NO_DECISIONS', 'Todavía no hay decisiones previas contra las que comparar la arquitectura.', 'Define la base de datos, el backend y el frontend antes de validar la arquitectura.');
  }

  // Reglas que dependen de la propia arquitectura (y del modelo de datos, si existe).
  const archDbFamilies = byRole('database').map((c) => databaseFamily(c.tech)).filter(Boolean);
  const families = new Set([...(dbFamily ? [dbFamily] : []), ...archDbFamilies]);
  const relations = model?.relations?.length || 0;
  const manyToMany = (model?.relations || []).some((r) => r.type === 'many_to_many');

  if (families.has('mongodb') && relations > 0) {
    add('warning', 'RELATIONAL_MODEL_ON_DOCUMENT_DB', `El modelo de datos tiene ${relations} relación${relations === 1 ? '' : 'es'} y la base es MongoDB, pensada para documentos.`, 'Considera una base relacional (PostgreSQL, MySQL), o define cómo se resolverán las relaciones (documentos embebidos o referencias).');
  }
  for (const family of ['redis', 'dynamodb', 'firestore']) {
    if (families.has(family) && manyToMany) {
      add('error', 'MANY_TO_MANY_ON_KEY_VALUE', `El modelo tiene relaciones muchos a muchos y la base (${family}) no las resuelve de forma natural.`, 'Usa una base relacional para los datos principales (Redis sirve como caché, no como base principal).');
    }
  }
  if (families.has('sqlite')) {
    if (architecture.deployment === 'serverless') {
      add('error', 'SQLITE_ON_SERVERLESS', 'SQLite guarda los datos en un archivo, y en serverless el disco se pierde entre ejecuciones.', 'Usa una base administrada (PostgreSQL o MySQL) para este tipo de despliegue.');
    } else if (architecture.deployment === 'containers' || architecture.deployment === 'managed_paas') {
      add('warning', 'SQLITE_MULTI_INSTANCE', 'SQLite no soporta bien varias instancias escribiendo a la vez, y los contenedores o la plataforma pueden crear varias.', 'Usa una sola instancia con volumen persistente, o cambia a PostgreSQL o MySQL.');
    }
  }
  if (architecture.deployment === 'serverless' && (families.has('postgresql') || families.has('mysql') || families.has('sqlserver'))) {
    add('warning', 'SERVERLESS_CONNECTION_POOLING', 'Las funciones serverless abren muchas conexiones cortas y pueden agotar las de la base de datos.', 'Usa un pool de conexiones administrado delante de la base (por ejemplo, un proxy de conexiones).');
  }
  if (byRole('ai').length > 0 && byRole('backend').length === 0) {
    add('error', 'AI_WITHOUT_BACKEND', 'La arquitectura usa un servicio de IA pero no tiene backend: la clave de la IA quedaría expuesta en el navegador.', 'Agrega un backend que haga las llamadas a la IA y guarde la clave como secreto.');
  }
  if (byRole('frontend').length > 0 && byRole('backend').length === 0 && byRole('database').length > 0) {
    add('error', 'DATABASE_WITHOUT_BACKEND', 'El frontend no puede conectarse directo a la base de datos de forma segura: falta un backend.', 'Agrega un backend entre el frontend y la base de datos.');
  }

  return { coherent: !issues.some((i) => i.level === 'error'), issues, checked };
}

module.exports = { validateDecisionsSpec, checkCoherence };
