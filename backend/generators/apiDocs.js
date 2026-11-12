// SCRUM-54: documentación de respuestas y códigos de estado de la API de un proyecto.
// Entrada: la especificación de endpoints (ver docs/contratos-diseno.md). Salida: para cada endpoint,
// qué respuestas puede dar y cuándo, más una versión en Markdown. Es determinista: siempre las mismas
// reglas (sin IA), así el resultado es predecible y se puede probar.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTH_LEVELS = ['none', 'user', 'role'];
const PARAM_TYPES = ['string', 'integer', 'number', 'decimal', 'boolean', 'uuid', 'date', 'datetime', 'json', 'array', 'object'];
const LIMITS = { endpoints: 100, summary: 160, path: 200, name: 60, fields: 30, roles: 10 };

const text = (value) => String(value ?? '').trim();
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function parseFields(raw, label) {
  if (raw === undefined) return { fields: [] };
  if (!Array.isArray(raw)) return { error: `${label} debe ser una lista` };
  if (raw.length > LIMITS.fields) return { error: `${label} no puede tener más de ${LIMITS.fields} elementos` };
  const fields = [];
  for (const item of raw) {
    const name = text(item?.name);
    if (!name) return { error: `Cada elemento de ${label} necesita un nombre` };
    if (name.length > LIMITS.name) return { error: `El nombre "${name.slice(0, 20)}…" supera ${LIMITS.name} caracteres` };
    if (!PARAM_TYPES.includes(item?.type)) {
      return { error: `El tipo de "${name}" en ${label} debe ser uno de: ${PARAM_TYPES.join(', ')}` };
    }
    if (fields.some((field) => sameName(field.name, name))) return { error: `"${name}" está repetido en ${label}` };
    fields.push({ name, type: item.type, required: item?.required === true, description: text(item?.description) });
  }
  return { fields };
}

function validateApiSpec(data) {
  if (!Array.isArray(data?.endpoints)) return { error: 'La especificación debe tener una lista "endpoints"' };
  if (data.endpoints.length === 0) return { error: 'Define al menos un endpoint' };
  if (data.endpoints.length > LIMITS.endpoints) return { error: `No puede haber más de ${LIMITS.endpoints} endpoints` };

  const endpoints = [];
  for (const item of data.endpoints) {
    const method = text(item?.method).toUpperCase();
    const path = text(item?.path);
    if (!METHODS.includes(method)) return { error: `El método debe ser uno de: ${METHODS.join(', ')}` };
    if (!/^\/[A-Za-z0-9_\-/:.]*$/.test(path) || path.length > LIMITS.path) {
      return { error: `La ruta "${path.slice(0, 40)}" no es válida (debe empezar con / y usar :nombre para parámetros)` };
    }
    const label = `${method} ${path}`;
    if (endpoints.some((e) => e.method === method && e.path === path)) return { error: `El endpoint ${label} está repetido` };

    const summary = text(item?.summary);
    if (summary.length > LIMITS.summary) return { error: `El resumen de ${label} supera ${LIMITS.summary} caracteres` };

    const auth = item?.auth ?? 'none';
    if (!AUTH_LEVELS.includes(auth)) return { error: `La autenticación de ${label} debe ser: ${AUTH_LEVELS.join(', ')}` };
    let roles = [];
    if (auth === 'role') {
      roles = Array.isArray(item?.roles) ? item.roles.map(text).filter(Boolean) : [];
      if (roles.length === 0) return { error: `${label} usa autenticación por rol: indica al menos un rol en "roles"` };
      if (roles.length > LIMITS.roles) return { error: `${label} no puede tener más de ${LIMITS.roles} roles` };
    }

    const pathParams = parseFields(item?.params?.path, `params.path de ${label}`);
    if (pathParams.error) return { error: pathParams.error };
    const query = parseFields(item?.params?.query, `params.query de ${label}`);
    if (query.error) return { error: query.error };
    const body = parseFields(item?.params?.body, `params.body de ${label}`);
    if (body.error) return { error: body.error };
    const successFields = parseFields(item?.successFields, `successFields de ${label}`);
    if (successFields.error) return { error: successFields.error };

    // Los parámetros de ruta salen de la propia ruta (:id). Los declarados solo les ponen tipo.
    const inPath = [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
    for (const declared of pathParams.fields) {
      if (!inPath.includes(declared.name)) return { error: `${label}: el parámetro de ruta "${declared.name}" no aparece en la ruta` };
    }
    const completePathParams = inPath.map(
      (name) => ({ ...(pathParams.fields.find((f) => f.name === name) || { name, type: 'string', description: '' }), required: true }),
    );

    if ((method === 'GET' || method === 'DELETE') && body.fields.length > 0) {
      return { error: `${label}: GET y DELETE no llevan cuerpo (params.body)` };
    }

    const uniqueFields = Array.isArray(item?.uniqueFields) ? item.uniqueFields.map(text).filter(Boolean) : [];
    for (const name of uniqueFields) {
      if (!body.fields.some((field) => sameName(field.name, name))) {
        return { error: `${label}: el campo único "${name}" no está en params.body` };
      }
    }

    endpoints.push({
      method,
      path,
      summary,
      auth,
      roles,
      params: { path: completePathParams, query: query.fields, body: body.fields },
      successFields: successFields.fields,
      creates: typeof item?.creates === 'boolean' ? item.creates : method === 'POST',
      uniqueFields,
      versioned: item?.versioned === true,
    });
  }
  return { data: { endpoints } };
}

// ---- Generación ----
const ERROR_SHAPE = { error: 'string', code: 'string (opcional)' };

function describeResponses(endpoint) {
  const { method, params, successFields, creates, uniqueFields, versioned, auth, roles } = endpoint;
  const responses = [];

  const successStatus = method === 'POST' && creates ? 201 : 200;
  const successBody = successFields.length
    ? Object.fromEntries(successFields.map((field) => [field.name, field.type]))
    : method === 'GET'
      ? { data: 'object' }
      : { message: 'string' };
  responses.push({
    status: successStatus,
    description: successStatus === 201 ? 'Recurso creado correctamente' : 'Operación realizada correctamente',
    body: successBody,
  });

  const requiredBody = params.body.filter((field) => field.required).map((field) => field.name);
  const requiredQuery = params.query.filter((field) => field.required).map((field) => field.name);
  const typedPathParams = params.path.filter((field) => field.type !== 'string').map((field) => field.name);
  const checks = [];
  if (['POST', 'PUT', 'PATCH'].includes(method) && params.body.length > 0) {
    checks.push(requiredBody.length ? `faltan o son inválidos los campos obligatorios (${requiredBody.join(', ')})` : 'el cuerpo tiene datos inválidos');
  }
  if (requiredQuery.length) checks.push(`falta algún parámetro de consulta obligatorio (${requiredQuery.join(', ')})`);
  if (typedPathParams.length) checks.push(`el formato de ${typedPathParams.join(', ')} en la ruta no es válido`);
  if (checks.length) responses.push({ status: 400, description: `Datos inválidos: ${checks.join('; ')}`, body: ERROR_SHAPE });

  if (auth !== 'none') {
    responses.push({ status: 401, description: 'No hay sesión iniciada o la sesión venció', body: { ...ERROR_SHAPE, code: 'string (NO_TOKEN, TOKEN_EXPIRED, INVALID_TOKEN)' } });
  }
  if (auth === 'role') {
    responses.push({ status: 403, description: `El usuario no tiene el rol necesario (${roles.join(', ')})`, body: ERROR_SHAPE });
  }
  if (params.path.length > 0) {
    responses.push({ status: 404, description: `No existe el recurso indicado en la ruta (${params.path.map((p) => p.name).join(', ')})`, body: ERROR_SHAPE });
  }
  const conflicts = [];
  if (uniqueFields.length) conflicts.push(`ya existe un registro con el mismo valor de ${uniqueFields.join(', ')}`);
  if (versioned) conflicts.push('otra persona modificó el recurso antes (VERSION_CONFLICT; la respuesta trae el valor actual en "current")');
  if (conflicts.length) {
    responses.push({ status: 409, description: `Conflicto: ${conflicts.join('; ')}`, body: { ...ERROR_SHAPE, current: 'object (solo en VERSION_CONFLICT)' } });
  }
  responses.push({ status: 500, description: 'Error interno del servidor', body: { error: 'string' } });

  return responses.sort((a, b) => a.status - b.status);
}

function authText(endpoint) {
  if (endpoint.auth === 'none') return 'Pública (no requiere sesión)';
  if (endpoint.auth === 'user') return 'Requiere sesión iniciada';
  return `Requiere sesión y uno de estos roles: ${endpoint.roles.join(', ')}`;
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const jsonInline = (value) => `\`${JSON.stringify(value)}\``;

function paramTable(title, fields) {
  if (fields.length === 0) return '';
  const rows = fields.map((f) => `| ${cell(f.name)} | ${f.type} | ${f.required ? 'Sí' : 'No'} | ${cell(f.description)} |`);
  return `**${title}**\n\n| Nombre | Tipo | Obligatorio | Descripción |\n|---|---|---|---|\n${rows.join('\n')}\n\n`;
}

function toMarkdown(endpoints) {
  let md = '# Documentación de la API\n\n';
  md += `Esta API tiene ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}. `;
  md += 'Todos los errores responden con JSON `{ "error": "mensaje", "code": "CODIGO" }` (el campo `code` solo cuando hay un código específico).\n\n';
  for (const endpoint of endpoints) {
    md += `## \`${endpoint.method} ${endpoint.path}\`\n\n`;
    if (endpoint.summary) md += `${endpoint.summary}\n\n`;
    md += `**Autenticación:** ${authText(endpoint)}\n\n`;
    md += paramTable('Parámetros de ruta', endpoint.params.path);
    md += paramTable('Parámetros de consulta', endpoint.params.query);
    md += paramTable('Cuerpo de la petición', endpoint.params.body);
    md += '**Respuestas**\n\n| Código | Cuándo | Cuerpo |\n|---|---|---|\n';
    md += endpoint.responses.map((r) => `| ${r.status} | ${cell(r.description)} | ${jsonInline(r.body)} |`).join('\n');
    md += '\n\n';
  }
  return md.trimEnd() + '\n';
}

function generateApiDocs(spec) {
  const endpoints = spec.endpoints.map((endpoint) => ({ ...endpoint, responses: describeResponses(endpoint) }));
  const statusCodes = [...new Set(endpoints.flatMap((e) => e.responses.map((r) => r.status)))].sort((a, b) => a - b);
  return { endpoints, statusCodes, markdown: toMarkdown(endpoints) };
}

module.exports = { validateApiSpec, generateApiDocs, METHODS, AUTH_LEVELS, PARAM_TYPES };
