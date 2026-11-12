const request = require('supertest');
const app = require('../server');

function cookieHeader(res) {
  return res.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
}

async function registerAndLogin(username, name = 'Usuario Test') {
  const reg = await request(app).post('/api/register').send({ username, name, password: 'Password123' });
  expect(reg.status).toBe(201);
  const res = await request(app).post('/api/login').send({ username, password: 'Password123' });
  expect(res.status).toBe(200);
  return cookieHeader(res);
}

async function setup(prefix) {
  const owner = await registerAndLogin(`${prefix}-owner@ejemplo.com`, 'Ana Owner');
  const editor = await registerAndLogin(`${prefix}-editor@ejemplo.com`, 'Beto Editor');
  const viewer = await registerAndLogin(`${prefix}-viewer@ejemplo.com`, 'Vale Viewer');
  const outsider = await registerAndLogin(`${prefix}-fuera@ejemplo.com`, 'Fuera');
  const created = await request(app).post('/api/projects').set('Cookie', owner).send({ name: 'Proyecto' });
  const projectId = created.body.project.id;
  await request(app).post(`/api/projects/${projectId}/members`).set('Cookie', owner).send({ email: `${prefix}-editor@ejemplo.com`, role: 'editor' });
  await request(app).post(`/api/projects/${projectId}/members`).set('Cookie', owner).send({ email: `${prefix}-viewer@ejemplo.com`, role: 'viewer' });
  return { owner, editor, viewer, outsider, projectId };
}

const url = (projectId, path) => `/api/projects/${projectId}/${path}`;
const putSpec = (cookie, projectId, name, body) => request(app).put(url(projectId, `specs/${name}`)).set('Cookie', cookie).send(body);
const get = (cookie, projectId, path) => request(app).get(url(projectId, path)).set('Cookie', cookie);

const apiData = { endpoints: [{ method: 'POST', path: '/api/pedidos', auth: 'user', params: { body: [{ name: 'total', type: 'decimal', required: true }] } }] };
const navData = {
  screens: [{ id: 'inicio', name: 'Inicio' }, { id: 'lista', name: 'Lista' }],
  mainFlow: ['inicio', 'lista'],
};
const archData = {
  name: 'Monolito',
  deployment: 'containers',
  components: [
    { name: 'API', role: 'backend', tech: 'Node.js Express' },
    { name: 'DB', role: 'database', tech: 'PostgreSQL' },
  ],
};

describe('Especificaciones: permisos', () => {
  test('exigen sesión (401)', async () => {
    const { projectId } = await setup('dz-auth');
    expect((await request(app).get(url(projectId, 'specs'))).status).toBe(401);
    expect((await request(app).put(url(projectId, 'specs/api')).send({ data: apiData })).status).toBe(401);
    expect((await request(app).get(url(projectId, 'api-docs'))).status).toBe(401);
  });

  test('quien no es miembro recibe 404 en especificaciones y motores', async () => {
    const { owner, outsider, projectId } = await setup('dz-out');
    await putSpec(owner, projectId, 'api', { data: apiData });
    for (const path of ['specs', 'specs/api', 'api-docs', 'navigation-map', 'operations', 'coherence']) {
      expect((await get(outsider, projectId, path)).status).toBe(404);
    }
    expect((await putSpec(outsider, projectId, 'api', { data: apiData })).status).toBe(404);
  });

  test('el viewer puede leer especificaciones y motores, pero no guardar (403)', async () => {
    const { owner, viewer, projectId } = await setup('dz-view');
    await putSpec(owner, projectId, 'api', { data: apiData });
    const list = await get(viewer, projectId, 'specs');
    expect(list.status).toBe(200);
    expect(list.body.canEdit).toBe(false);
    expect((await get(viewer, projectId, 'api-docs')).status).toBe(200);
    expect((await putSpec(viewer, projectId, 'api', { data: apiData, version: 1 })).status).toBe(403);
  });
});

describe('Especificaciones: guardar con versionado', () => {
  test('lista las cuatro especificaciones, todas sin definir al comienzo', async () => {
    const { owner, projectId } = await setup('dz-list');
    const res = await get(owner, projectId, 'specs');
    expect(res.body.specs.map((s) => s.name)).toEqual(['api', 'navigation', 'architecture', 'decisions']);
    expect(res.body.specs.every((s) => s.defined === false && s.data === null && s.version === null)).toBe(true);
  });

  test('la primera vez se guarda sin versión (201); después se ve con su autor', async () => {
    const { owner, editor, projectId } = await setup('dz-first');
    const res = await putSpec(editor, projectId, 'navigation', { data: navData });
    expect(res.status).toBe(201);
    expect(res.body.spec).toMatchObject({ name: 'navigation', defined: true, version: 1, updatedByName: 'Beto Editor' });
    const seen = await get(owner, projectId, 'specs/navigation');
    expect(seen.body.spec.data.screens).toHaveLength(2);
  });

  test('editar con la versión correcta sube la versión (200)', async () => {
    const { owner, projectId } = await setup('dz-edit');
    await putSpec(owner, projectId, 'api', { data: apiData });
    const res = await putSpec(owner, projectId, 'api', { data: apiData, version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.spec.version).toBe(2);
  });

  test('con versión vieja responde 409, devuelve el actual y NO sobrescribe', async () => {
    const { owner, editor, projectId } = await setup('dz-409');
    await putSpec(owner, projectId, 'architecture', { data: archData });
    await putSpec(owner, projectId, 'architecture', { data: { ...archData, name: 'Cambio de Ana' }, version: 1 });
    const res = await putSpec(editor, projectId, 'architecture', { data: { ...archData, name: 'Cambio de Beto' }, version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.current.data.name).toBe('Cambio de Ana');
    expect((await get(owner, projectId, 'specs/architecture')).body.spec.data.name).toBe('Cambio de Ana');
  });

  test('si ya existe y no se envía versión: 409 ALREADY_DEFINED; si no existe y se envía: 409 NOT_DEFINED', async () => {
    const { owner, editor, projectId } = await setup('dz-race');
    await putSpec(owner, projectId, 'api', { data: apiData });
    const second = await putSpec(editor, projectId, 'api', { data: apiData });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_DEFINED');
    const premature = await putSpec(owner, projectId, 'navigation', { data: navData, version: 1 });
    expect(premature.status).toBe(409);
    expect(premature.body.code).toBe('NOT_DEFINED');
  });

  test('versión inválida 400; especificación desconocida 404 (incluidos nombres internos de JavaScript)', async () => {
    const { owner, projectId } = await setup('dz-bad');
    expect((await putSpec(owner, projectId, 'api', { data: apiData, version: 'abc' })).status).toBe(400);
    expect((await putSpec(owner, projectId, 'inventada', { data: apiData })).status).toBe(404);
    expect((await putSpec(owner, projectId, 'constructor', { data: apiData })).status).toBe(404);
    expect((await get(owner, projectId, 'specs/__proto__')).status).toBe(404);
  });

  test('los datos inválidos se rechazan con 400 y no se guarda nada', async () => {
    const { owner, projectId } = await setup('dz-invalid');
    expect((await putSpec(owner, projectId, 'api', { data: { endpoints: [{ method: 'GET', path: 'mal' }] } })).status).toBe(400);
    expect((await putSpec(owner, projectId, 'navigation', { data: { screens: [] } })).status).toBe(400);
    expect((await putSpec(owner, projectId, 'architecture', { data: { name: 'x' } })).status).toBe(400);
    expect((await putSpec(owner, projectId, 'decisions', { data: {} })).status).toBe(400);
    expect((await putSpec(owner, projectId, 'api', {})).status).toBe(400);
    const list = await get(owner, projectId, 'specs');
    expect(list.body.specs.some((s) => s.defined)).toBe(false);
  });
});

describe('Motores: precondiciones', () => {
  test('sin la especificación que necesitan responden 409 SPEC_MISSING', async () => {
    const { owner, projectId } = await setup('dz-missing');
    const cases = { 'api-docs': 'api', 'navigation-map': 'navigation', operations: 'architecture', coherence: 'architecture' };
    for (const [path, missing] of Object.entries(cases)) {
      const res = await get(owner, projectId, path);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SPEC_MISSING', missing });
    }
  });
});

describe('SCRUM-54: documentación de la API', () => {
  test('devuelve los endpoints con sus respuestas y la versión de la especificación usada', async () => {
    const { owner, projectId } = await setup('dz-54');
    await putSpec(owner, projectId, 'api', { data: apiData });
    const res = await get(owner, projectId, 'api-docs');
    expect(res.status).toBe(200);
    expect(res.body.specVersion).toBe(1);
    expect(res.body.statusCodes).toEqual([201, 400, 401, 500]);
    expect(res.body.endpoints[0].responses.map((r) => r.status)).toEqual([201, 400, 401, 500]);
  });

  test('?format=markdown devuelve el documento como texto Markdown', async () => {
    const { owner, projectId } = await setup('dz-54md');
    await putSpec(owner, projectId, 'api', { data: apiData });
    const res = await get(owner, projectId, 'api-docs?format=markdown');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.text).toContain('## `POST /api/pedidos`');
  });

  test('al cambiar la especificación, la documentación se actualiza', async () => {
    const { owner, projectId } = await setup('dz-54up');
    await putSpec(owner, projectId, 'api', { data: apiData });
    await putSpec(owner, projectId, 'api', { version: 1, data: { endpoints: [{ method: 'GET', path: '/api/salud' }] } });
    const res = await get(owner, projectId, 'api-docs');
    expect(res.body.specVersion).toBe(2);
    expect(res.body.endpoints).toHaveLength(1);
  });
});

describe('SCRUM-60: mapa de navegación', () => {
  test('devuelve nodos, conexiones y avisos; ?format=mermaid devuelve el diagrama', async () => {
    const { owner, projectId } = await setup('dz-60');
    await putSpec(owner, projectId, 'navigation', { data: { ...navData, screens: [...navData.screens, { id: 'suelta', name: 'Suelta' }] } });
    const res = await get(owner, projectId, 'navigation-map');
    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(3);
    expect(res.body.edges).toEqual([{ from: 'inicio', to: 'lista', label: '', kind: 'main' }]);
    expect(res.body.issues.map((i) => i.code)).toContain('UNREACHABLE_SCREEN');

    const mermaid = await get(owner, projectId, 'navigation-map?format=mermaid');
    expect(mermaid.headers['content-type']).toMatch(/text\/plain/);
    expect(mermaid.text.startsWith('flowchart LR')).toBe(true);
  });
});

describe('SCRUM-66: aspectos operacionales', () => {
  test('devuelve Docker, despliegue, variables, ambientes y observabilidad; ?format=markdown', async () => {
    const { owner, projectId } = await setup('dz-66');
    await putSpec(owner, projectId, 'architecture', { data: archData });
    const res = await get(owner, projectId, 'operations');
    expect(res.status).toBe(200);
    expect(res.body.docker.services.map((s) => s.name)).toEqual(['db', 'api']);
    expect(res.body.environmentVariables.map((v) => v.name)).toContain('DATABASE_URL');
    expect(res.body.environments).toHaveLength(3);

    const md = await get(owner, projectId, 'operations?format=markdown');
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.text).toContain('# Aspectos operacionales: Monolito');
  });
});

describe('SCRUM-67: coherencia', () => {
  test('sin decisiones previas avisa; con decisiones que no coinciden da error', async () => {
    const { owner, projectId } = await setup('dz-67');
    await putSpec(owner, projectId, 'architecture', { data: archData });
    const first = await get(owner, projectId, 'coherence');
    expect(first.status).toBe(200);
    expect(first.body.decisionsVersion).toBeNull();
    expect(first.body.issues.map((i) => i.code)).toContain('NO_DECISIONS');

    await putSpec(owner, projectId, 'decisions', { data: { database: { engine: 'MySQL' }, backend: { runtime: 'Node.js' } } });
    const second = await get(owner, projectId, 'coherence');
    expect(second.body.coherent).toBe(false);
    expect(second.body.issues.map((i) => i.code)).toEqual(['DATABASE_MISMATCH']);
    expect(second.body.checked).toEqual(['database', 'backend']);
    expect(second.body.decisionsVersion).toBe(1);
  });

  test('cuando coincide todo, es coherente', async () => {
    const { owner, projectId } = await setup('dz-67ok');
    await putSpec(owner, projectId, 'architecture', { data: archData });
    await putSpec(owner, projectId, 'decisions', { data: { database: { engine: 'PostgreSQL' }, backend: { runtime: 'Node.js', framework: 'Express' } } });
    const res = await get(owner, projectId, 'coherence');
    expect(res.body).toMatchObject({ coherent: true, issues: [] });
  });

  test('usa el modelo de datos del proyecto (SCRUM-48): muchos a muchos sobre Redis es error', async () => {
    const { owner, projectId } = await setup('dz-67model');
    const model = (path, body) => request(app).post(url(projectId, `model/${path}`)).set('Cookie', owner).send(body);
    const a = (await model('entities', { name: 'Alumno' })).body.entity;
    const b = (await model('entities', { name: 'Curso' })).body.entity;
    await model('relations', { from: a.id, to: b.id, type: 'many_to_many' });
    await putSpec(owner, projectId, 'architecture', {
      data: { name: 'Raro', deployment: 'single_vm', components: [{ name: 'API', role: 'backend', tech: 'Node' }, { name: 'Datos', role: 'database', tech: 'Redis' }] },
    });
    const res = await get(owner, projectId, 'coherence');
    expect(res.body.coherent).toBe(false);
    expect(res.body.issues.map((i) => i.code)).toContain('MANY_TO_MANY_ON_KEY_VALUE');
  });
});
