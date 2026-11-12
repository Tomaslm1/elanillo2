const { validateApiSpec, generateApiDocs } = require('../generators/apiDocs');
const { validateNavigationSpec, generateNavigationMap } = require('../generators/navigationMap');
const { validateArchitectureSpec, generateOperations } = require('../generators/operations');
const { validateDecisionsSpec, checkCoherence } = require('../generators/coherence');

const codes = (result) => result.issues.map((issue) => issue.code);
const status = (endpoint) => endpoint.responses.map((r) => r.status);

// ---------------- SCRUM-54: documentación de la API ----------------
describe('apiDocs: validación de la especificación', () => {
  const ep = (extra = {}) => ({ method: 'GET', path: '/api/x', ...extra });
  const bad = (endpoints) => validateApiSpec({ endpoints }).error;

  test('rechaza lista vacía, método y ruta inválidos', () => {
    expect(validateApiSpec({}).error).toBeTruthy();
    expect(bad([])).toMatch(/al menos un endpoint/);
    expect(bad([ep({ method: 'TRACE' })])).toMatch(/método/);
    expect(bad([ep({ path: 'sin-barra' })])).toMatch(/ruta/);
    expect(bad([ep({ path: '/con espacio' })])).toMatch(/ruta/);
  });

  test('rechaza endpoints repetidos (aunque cambie el método a minúsculas)', () => {
    expect(bad([ep(), ep({ method: 'get' })])).toMatch(/repetido/);
  });

  test('GET y DELETE no llevan cuerpo; roles obligatorios con auth por rol', () => {
    expect(bad([ep({ params: { body: [{ name: 'a', type: 'string' }] } })])).toMatch(/no llevan cuerpo/);
    expect(bad([ep({ auth: 'role' })])).toMatch(/al menos un rol/);
    expect(bad([ep({ auth: 'otro' })])).toMatch(/autenticación/);
  });

  test('valida parámetros: tipo, repetidos, ruta y campos únicos', () => {
    const post = (params, extra = {}) => ep({ method: 'POST', params, ...extra });
    expect(bad([post({ body: [{ name: 'a', type: 'inventado' }] })])).toMatch(/tipo/);
    expect(bad([post({ body: [{ name: 'a', type: 'string' }, { name: 'A', type: 'string' }] })])).toMatch(/repetido/);
    expect(bad([post({ path: [{ name: 'id', type: 'uuid' }] })])).toMatch(/no aparece en la ruta/);
    expect(bad([post({ body: [{ name: 'a', type: 'string' }] }, { uniqueFields: ['b'] })])).toMatch(/campo único/);
  });

  test('acepta los mismos tipos que el modelo de datos (incluido decimal)', () => {
    const ok = validateApiSpec({ endpoints: [{ method: 'POST', path: '/api/x', params: { body: [{ name: 'total', type: 'decimal' }] } }] });
    expect(ok.error).toBeUndefined();
  });

  test('completa los parámetros de ruta a partir de la ruta y normaliza valores', () => {
    const { data } = validateApiSpec({ endpoints: [{ method: 'put', path: '/api/pedidos/:id', params: { path: [{ name: 'id', type: 'uuid' }] } }] });
    expect(data.endpoints[0].method).toBe('PUT');
    expect(data.endpoints[0].params.path).toEqual([{ name: 'id', type: 'uuid', required: true, description: '' }]);
    const auto = validateApiSpec({ endpoints: [{ method: 'GET', path: '/api/a/:x/b/:y' }] }).data;
    expect(auto.endpoints[0].params.path.map((p) => `${p.name}:${p.type}`)).toEqual(['x:string', 'y:string']);
  });
});

describe('apiDocs: códigos de estado según el endpoint', () => {
  const docs = (endpoint) => {
    const parsed = validateApiSpec({ endpoints: [endpoint] });
    expect(parsed.error).toBeUndefined();
    return generateApiDocs(parsed.data).endpoints[0];
  };

  test('GET público: solo 200 y 500', () => {
    expect(status(docs({ method: 'GET', path: '/api/salud' }))).toEqual([200, 500]);
  });

  test('POST que crea: 201, 400 con los campos obligatorios, 401 y 500', () => {
    const d = docs({ method: 'POST', path: '/api/pedidos', auth: 'user', params: { body: [{ name: 'total', type: 'decimal', required: true }, { name: 'nota', type: 'string' }] } });
    expect(status(d)).toEqual([201, 400, 401, 500]);
    expect(d.responses[1].description).toMatch(/total/);
    expect(d.responses[1].description).not.toMatch(/nota/);
  });

  test('POST con creates:false responde 200 y no 201', () => {
    const d = docs({ method: 'POST', path: '/api/login', creates: false, params: { body: [{ name: 'a', type: 'string' }] } });
    expect(status(d)).toContain(200);
    expect(status(d)).not.toContain(201);
  });

  test('auth por rol agrega 403 con los roles; parámetros de ruta agregan 404', () => {
    const d = docs({ method: 'DELETE', path: '/api/usuarios/:id', auth: 'role', roles: ['admin'] });
    expect(status(d)).toEqual([200, 401, 403, 404, 500]);
    expect(d.responses.find((r) => r.status === 403).description).toMatch(/admin/);
  });

  test('un parámetro de ruta que no es texto agrega 400', () => {
    const d = docs({ method: 'GET', path: '/api/x/:id', params: { path: [{ name: 'id', type: 'integer' }] } });
    expect(status(d)).toEqual([200, 400, 404, 500]);
  });

  test('campos únicos y versionado agregan 409 y lo explican', () => {
    const d = docs({ method: 'PUT', path: '/api/x/:id', versioned: true, uniqueFields: ['email'], params: { body: [{ name: 'email', type: 'string', required: true }] } });
    const conflict = d.responses.find((r) => r.status === 409);
    expect(conflict.description).toMatch(/email/);
    expect(conflict.description).toMatch(/VERSION_CONFLICT/);
  });

  test('el cuerpo de éxito usa successFields si existen', () => {
    const d = docs({ method: 'GET', path: '/api/x', successFields: [{ name: 'id', type: 'uuid' }, { name: 'total', type: 'decimal' }] });
    expect(d.responses[0].body).toEqual({ id: 'uuid', total: 'decimal' });
  });

  test('las respuestas salen ordenadas y el resumen lista los códigos usados', () => {
    const result = generateApiDocs(validateApiSpec({
      endpoints: [
        { method: 'GET', path: '/api/a' },
        { method: 'DELETE', path: '/api/a/:id', auth: 'role', roles: ['admin'] },
      ],
    }).data);
    expect(result.statusCodes).toEqual([200, 401, 403, 404, 500]);
    result.endpoints.forEach((e) => expect(status(e)).toEqual([...status(e)].sort((a, b) => a - b)));
  });

  test('el Markdown incluye cada endpoint, su autenticación y sus códigos', () => {
    const parsed = validateApiSpec({
      endpoints: [{ method: 'POST', path: '/api/pedidos', summary: 'Crea un pedido', auth: 'user', params: { body: [{ name: 'total', type: 'decimal', required: true, description: 'Monto | total' }] } }],
    });
    expect(parsed.error).toBeUndefined();
    const { markdown } = generateApiDocs(parsed.data);
    expect(markdown).toContain('# Documentación de la API');
    expect(markdown).toContain('## `POST /api/pedidos`');
    expect(markdown).toContain('Crea un pedido');
    expect(markdown).toContain('Requiere sesión iniciada');
    expect(markdown).toContain('| 201 |');
    expect(markdown).toContain('| 401 |');
    expect(markdown).toContain('Monto \\| total'); // la barra no rompe la tabla
  });
});

// ---------------- SCRUM-60: mapa de navegación ----------------
describe('navigationMap: validación', () => {
  const screens = [{ id: 'inicio', name: 'Inicio' }, { id: 'lista', name: 'Lista' }];
  const bad = (data) => validateNavigationSpec(data).error;

  test('rechaza pantallas faltantes, ids inválidos o repetidos y nombres vacíos', () => {
    expect(bad({})).toMatch(/al menos una pantalla/);
    expect(bad({ screens: [{ id: 'Mayúscula', name: 'X' }] })).toMatch(/id de pantalla/);
    expect(bad({ screens: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] })).toMatch(/repetido/);
    expect(bad({ screens: [{ id: 'a', name: '' }] })).toMatch(/nombre/);
  });

  test('rechaza recorrido y transiciones hacia pantallas que no existen', () => {
    expect(bad({ screens, mainFlow: ['inicio', 'fantasma'] })).toMatch(/no existe/);
    expect(bad({ screens, transitions: [{ from: 'inicio', to: 'fantasma' }] })).toMatch(/no existe/);
    expect(bad({ screens, mainFlow: 'no-lista' })).toMatch(/lista/);
  });
});

describe('navigationMap: generación', () => {
  const build = (data) => {
    const parsed = validateNavigationSpec(data);
    expect(parsed.error).toBeUndefined();
    return generateNavigationMap(parsed.data);
  };
  const screens = [
    { id: 'inicio', name: 'Inicio' },
    { id: 'lista', name: 'Lista' },
    { id: 'detalle', name: 'Detalle' },
    { id: 'ajustes', name: 'Ajustes' },
  ];

  test('el recorrido principal une pantallas consecutivas y marca el inicio', () => {
    const map = build({ screens, mainFlow: ['inicio', 'lista', 'detalle'], transitions: [{ from: 'inicio', to: 'ajustes', label: 'abrir' }] });
    expect(map.edges.filter((e) => e.kind === 'main').map((e) => `${e.from}>${e.to}`)).toEqual(['inicio>lista', 'lista>detalle']);
    expect(map.edges.find((e) => e.to === 'ajustes')).toMatchObject({ kind: 'secondary', label: 'abrir' });
    expect(map.start).toBe('inicio');
    expect(map.nodes.find((n) => n.id === 'inicio').isStart).toBe(true);
  });

  test('una transición repetida no duplica la conexión y conserva "main" completando la etiqueta', () => {
    const map = build({ screens, mainFlow: ['inicio', 'lista'], transitions: [{ from: 'inicio', to: 'lista', label: 'ver' }, { from: 'inicio', to: 'lista' }] });
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]).toMatchObject({ kind: 'main', label: 'ver' });
  });

  test('posiciona por niveles: más lejos del inicio, más a la derecha', () => {
    const map = build({ screens, mainFlow: ['inicio', 'lista', 'detalle'] });
    const x = (id) => map.nodes.find((n) => n.id === id).x;
    expect(x('inicio')).toBeLessThan(x('lista'));
    expect(x('lista')).toBeLessThan(x('detalle'));
  });

  test('avisa de pantallas inalcanzables, callejones sin salida y falta de recorrido', () => {
    const map = build({ screens, mainFlow: ['inicio', 'lista', 'detalle'], transitions: [{ from: 'inicio', to: 'ajustes' }] });
    expect(codes(map)).toEqual(['DEAD_END']); // ajustes no lleva a ningún lado
    expect(map.issues[0].screenId).toBe('ajustes');

    const lonely = build({ screens, mainFlow: ['inicio', 'lista'] });
    const unreachable = lonely.issues.filter((i) => i.code === 'UNREACHABLE_SCREEN').map((i) => i.screenId);
    expect(unreachable.sort()).toEqual(['ajustes', 'detalle']);
    expect(lonely.nodes.find((n) => n.id === 'ajustes').reachable).toBe(false);

    const noFlow = build({ screens: [{ id: 'unica', name: 'Única' }] });
    expect(codes(noFlow)).toContain('NO_MAIN_FLOW');
  });

  test('genera Mermaid: línea gruesa en el recorrido, etiquetas, y quita las comillas', () => {
    const map = build({ screens: [{ id: 'a', name: 'Pantalla "A"' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], mainFlow: ['a', 'b'], transitions: [{ from: 'b', to: 'c', label: 'ir "a" C' }] });
    expect(map.mermaid.startsWith('flowchart LR')).toBe(true);
    expect(map.mermaid).toContain('s_a["Pantalla  A"]');
    expect(map.mermaid).toContain('s_a ==> s_b');
    expect(map.mermaid).toContain('s_b -->|ir  a  C| s_c');
    // ninguna línea tiene comillas de más (romperían el diagrama)
    map.mermaid.split('\n').forEach((line) => expect((line.match(/"/g) || []).length % 2).toBe(0));
  });
});

// ---------------- SCRUM-66: aspectos operacionales ----------------
describe('operations: validación', () => {
  const comp = (extra = {}) => ({ name: 'API', role: 'backend', tech: 'Node.js', ...extra });
  const bad = (data) => validateArchitectureSpec(data).error;

  test('rechaza nombre, despliegue, componentes y roles inválidos', () => {
    expect(bad({ deployment: 'containers', components: [comp()] })).toMatch(/nombre/);
    expect(bad({ name: 'A', deployment: 'nube', components: [comp()] })).toMatch(/deployment/);
    expect(bad({ name: 'A', deployment: 'containers', components: [] })).toMatch(/al menos un componente/);
    expect(bad({ name: 'A', deployment: 'containers', components: [comp({ role: 'otro' })] })).toMatch(/rol/);
    expect(bad({ name: 'A', deployment: 'containers', components: [comp({ tech: '' })] })).toMatch(/tecnología/);
    expect(bad({ name: 'A', deployment: 'containers', components: [comp(), comp({ name: 'api' })] })).toMatch(/repetido/);
  });
});

describe('operations: lo que aparece depende de los componentes', () => {
  const ops = (components, deployment = 'containers') => {
    const parsed = validateArchitectureSpec({ name: 'Arq', deployment, components });
    expect(parsed.error).toBeUndefined();
    return generateOperations(parsed.data);
  };
  const full = [
    { name: 'API', role: 'backend', tech: 'Node.js Express' },
    { name: 'Base', role: 'database', tech: 'PostgreSQL' },
    { name: 'Web', role: 'frontend', tech: 'React' },
    { name: 'IA', role: 'ai', tech: 'Claude' },
  ];
  const varNames = (result) => result.environmentVariables.map((v) => v.name);

  test('arquitectura completa: Docker, variables, ambientes y observabilidad', () => {
    const result = ops(full);
    expect(result.docker.services.map((s) => s.name)).toEqual(['base', 'api', 'web']);
    expect(result.docker.composeYaml).toContain('image: postgres:16');
    expect(result.docker.composeYaml).toMatch(/api:[\s\S]*depends_on:\s*- base/);
    expect(varNames(result)).toEqual(expect.arrayContaining(['APP_ENV', 'DATABASE_URL', 'AI_API_KEY', 'AI_MONTHLY_TOKEN_BUDGET', 'API_BASE_URL']));
    expect(result.environmentVariables.find((v) => v.name === 'DATABASE_URL').secret).toBe(true);
    expect(result.environmentVariables.find((v) => v.name === 'AI_API_KEY').secret).toBe(true);
    expect(result.environments.map((e) => e.name)).toEqual(['desarrollo', 'pruebas', 'produccion']);
    expect(result.observability.healthChecks.join(' ')).toMatch(/\/health/);
    expect(result.observability.alerts.join(' ')).toMatch(/AI_MONTHLY_TOKEN_BUDGET/);
    expect(result.observability.alerts.join(' ')).toMatch(/respaldo/);
  });

  test('sin IA no hay variables ni alertas de tokens; sin base de datos no hay respaldos', () => {
    const result = ops([{ name: 'API', role: 'backend', tech: 'Node.js' }]);
    expect(varNames(result).some((n) => n.startsWith('AI_'))).toBe(false);
    expect(varNames(result)).not.toContain('DATABASE_URL');
    expect(result.observability.alerts.join(' ')).not.toMatch(/token|respaldo/i);
    expect(result.environments.find((e) => e.name === 'produccion').differences.join(' ')).not.toMatch(/respaldo/i);
  });

  test('en una sola máquina virtual no hay ambiente de pruebas', () => {
    expect(ops(full, 'single_vm').environments.map((e) => e.name)).toEqual(['desarrollo', 'produccion']);
  });

  test('cada estilo de despliegue trae sus propios pasos', () => {
    const first = (deployment) => ops(full, deployment).deployment.steps[0];
    expect(new Set(['containers', 'single_vm', 'serverless', 'managed_paas'].map(first)).size).toBe(4);
    expect(ops(full, 'serverless').deployment.steps.join(' ')).toMatch(/pool de conexiones/);
  });

  test('SQLite no genera contenedor y avisa; una tecnología desconocida también avisa', () => {
    const sqlite = ops([{ name: 'API', role: 'backend', tech: 'Node' }, { name: 'Datos', role: 'database', tech: 'SQLite' }]);
    expect(sqlite.docker.services.map((s) => s.name)).toEqual(['api']);
    expect(sqlite.docker.notes.join(' ')).toMatch(/SQLite/);

    const unknown = ops([{ name: 'API', role: 'backend', tech: 'Zig' }, { name: 'Datos', role: 'database', tech: 'BaseRara' }]);
    expect(unknown.docker.notes.length).toBe(2);
  });

  test('el Markdown tiene todas las secciones', () => {
    const { markdown } = ops(full);
    ['# Aspectos operacionales: Arq', '## Docker', '## Despliegue (containers)', '## Variables de entorno', '## Ambientes', '## Observabilidad', '```yaml'].forEach((part) => expect(markdown).toContain(part));
  });
});

// ---------------- SCRUM-67: coherencia ----------------
describe('coherence: decisiones previas', () => {
  test('exige al menos una decisión y valida cada área', () => {
    expect(validateDecisionsSpec({}).error).toMatch(/al menos una decisión/);
    expect(validateDecisionsSpec({ database: 'x' }).error).toMatch(/objeto/);
    expect(validateDecisionsSpec({ database: {} }).error).toMatch(/al menos uno de/);
    expect(validateDecisionsSpec({ backend: { runtime: 'Node.js' } }).data.backend).toEqual({ runtime: 'Node.js' });
  });
});

describe('coherence: incompatibilidades', () => {
  const arch = (components, deployment = 'containers') => ({ name: 'A', deployment, components });
  const full = arch([
    { name: 'API', role: 'backend', tech: 'Node.js Express' },
    { name: 'DB', role: 'database', tech: 'PostgreSQL' },
    { name: 'Web', role: 'frontend', tech: 'React' },
  ]);
  const decisions = { database: { engine: 'PostgreSQL' }, backend: { runtime: 'Node.js', framework: 'Express' }, frontend: { framework: 'React' } };
  // Sin decisiones se pasa `null` (con `undefined` JavaScript usaría el valor por defecto).
  const check = (architecture, d, model) => checkCoherence({ architecture, decisions: d, model });

  test('todo coincide: coherente y sin avisos', () => {
    const result = check(full, decisions);
    expect(result).toMatchObject({ coherent: true, issues: [], checked: ['database', 'backend', 'frontend'] });
  });

  test('la base, el backend o el frontend no coinciden con lo decidido: error', () => {
    const result = check(arch([
      { name: 'API', role: 'backend', tech: 'Django' },
      { name: 'DB', role: 'database', tech: 'MongoDB' },
      { name: 'Web', role: 'frontend', tech: 'Vue' },
    ]), decisions);
    expect(result.coherent).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining(['DATABASE_MISMATCH', 'BACKEND_MISMATCH', 'FRONTEND_MISMATCH']));
  });

  test('un componente decidido que falta en la arquitectura es error', () => {
    const result = check(arch([{ name: 'API', role: 'backend', tech: 'Node' }]), decisions);
    expect(codes(result)).toEqual(expect.arrayContaining(['DATABASE_MISSING', 'FRONTEND_MISSING']));
  });

  test('tecnología no reconocida: avisa en vez de dar error', () => {
    const result = check(arch([{ name: 'DB', role: 'database', tech: 'BaseRara' }]), { database: { engine: 'OtraRara' } });
    expect(codes(result)).toContain('UNRECOGNIZED_TECH');
    expect(result.coherent).toBe(true);
  });

  test('sin decisiones previas avisa y no compara', () => {
    const result = check(full, null);
    expect(codes(result)).toContain('NO_DECISIONS');
    expect(result.checked).toEqual([]);
  });

  test('usa el modelo de datos: relaciones sobre MongoDB avisan; muchos a muchos sobre Redis es error', () => {
    const mongo = arch([{ name: 'API', role: 'backend', tech: 'Node' }, { name: 'DB', role: 'database', tech: 'MongoDB' }]);
    expect(codes(check(mongo, null, { relations: [{ type: 'one_to_many' }] }))).toContain('RELATIONAL_MODEL_ON_DOCUMENT_DB');
    expect(codes(check(mongo, null, { relations: [] }))).not.toContain('RELATIONAL_MODEL_ON_DOCUMENT_DB');

    const redis = arch([{ name: 'API', role: 'backend', tech: 'Node' }, { name: 'DB', role: 'database', tech: 'Redis' }]);
    expect(codes(check(redis, null, { relations: [{ type: 'many_to_many' }] }))).toContain('MANY_TO_MANY_ON_KEY_VALUE');
    expect(codes(check(redis, null, { relations: [{ type: 'one_to_many' }] }))).not.toContain('MANY_TO_MANY_ON_KEY_VALUE');
  });

  test('SQLite: error en serverless, aviso con contenedores, nada en una sola máquina', () => {
    const sqlite = (deployment) => arch([{ name: 'API', role: 'backend', tech: 'Node' }, { name: 'DB', role: 'database', tech: 'SQLite' }], deployment);
    expect(codes(check(sqlite('serverless'), null))).toContain('SQLITE_ON_SERVERLESS');
    expect(check(sqlite('serverless'), null).coherent).toBe(false);
    expect(codes(check(sqlite('containers'), null))).toContain('SQLITE_MULTI_INSTANCE');
    expect(check(sqlite('containers'), null).coherent).toBe(true);
    expect(codes(check(sqlite('single_vm'), null))).not.toContain('SQLITE_MULTI_INSTANCE');
  });

  test('serverless con base relacional avisa del pool de conexiones', () => {
    const result = check(arch([{ name: 'API', role: 'backend', tech: 'Node' }, { name: 'DB', role: 'database', tech: 'PostgreSQL' }], 'serverless'), null);
    expect(codes(result)).toContain('SERVERLESS_CONNECTION_POOLING');
  });

  test('IA o base de datos sin backend detrás del frontend es error (seguridad)', () => {
    const ai = check(arch([{ name: 'Web', role: 'frontend', tech: 'React' }, { name: 'IA', role: 'ai', tech: 'Claude' }]), null);
    expect(codes(ai)).toContain('AI_WITHOUT_BACKEND');
    const direct = check(arch([{ name: 'Web', role: 'frontend', tech: 'React' }, { name: 'DB', role: 'database', tech: 'PostgreSQL' }]), null);
    expect(codes(direct)).toContain('DATABASE_WITHOUT_BACKEND');
    expect(direct.coherent).toBe(false);
  });

  test('cada incidencia trae una sugerencia', () => {
    const result = check(arch([{ name: 'DB', role: 'database', tech: 'MongoDB' }]), decisions);
    expect(result.issues.length).toBeGreaterThan(0);
    result.issues.forEach((issue) => expect(issue.suggestion).toEqual(expect.any(String)));
  });
});
