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
  await request(app).post(`/api/projects/${projectId}/members`).set('Cookie', owner)
    .send({ email: `${prefix}-editor@ejemplo.com`, role: 'editor' });
  await request(app).post(`/api/projects/${projectId}/members`).set('Cookie', owner)
    .send({ email: `${prefix}-viewer@ejemplo.com`, role: 'viewer' });
  return { owner, editor, viewer, outsider, projectId };
}

const url = (projectId, id = '') => `/api/projects/${projectId}/requirements${id ? `/${id}` : ''}`;
const sample = { title: 'Login con correo', description: 'El usuario inicia sesión', category: 'functional' };

async function addRequirement(cookie, projectId, body = sample) {
  const res = await request(app).post(url(projectId)).set('Cookie', cookie).send(body);
  expect(res.status).toBe(201);
  return res.body.requirement;
}

describe('Requisitos: permisos', () => {
  test('exigen sesión (401)', async () => {
    const { projectId } = await setup('req-auth');
    expect((await request(app).get(url(projectId))).status).toBe(401);
    expect((await request(app).post(url(projectId)).send(sample)).status).toBe(401);
  });

  test('quien no es miembro recibe 404 en todas las rutas', async () => {
    const { owner, outsider, projectId } = await setup('req-out');
    const item = await addRequirement(owner, projectId);
    expect((await request(app).get(url(projectId)).set('Cookie', outsider)).status).toBe(404);
    expect((await request(app).post(url(projectId)).set('Cookie', outsider).send(sample)).status).toBe(404);
    expect((await request(app).put(url(projectId, item.id)).set('Cookie', outsider).send({ ...sample, version: 1 })).status).toBe(404);
    expect((await request(app).delete(`${url(projectId, item.id)}?version=1`).set('Cookie', outsider)).status).toBe(404);
  });

  test('el viewer puede ver pero no crear, editar ni borrar (403)', async () => {
    const { owner, viewer, projectId } = await setup('req-view');
    const item = await addRequirement(owner, projectId);
    const list = await request(app).get(url(projectId)).set('Cookie', viewer);
    expect(list.status).toBe(200);
    expect(list.body.requirements).toHaveLength(1);
    expect(list.body.canEdit).toBe(false);
    expect((await request(app).post(url(projectId)).set('Cookie', viewer).send(sample)).status).toBe(403);
    expect((await request(app).put(url(projectId, item.id)).set('Cookie', viewer).send({ ...sample, version: 1 })).status).toBe(403);
    expect((await request(app).delete(`${url(projectId, item.id)}?version=1`).set('Cookie', viewer)).status).toBe(403);
  });

  test('un colaborador ve lo que registró otro', async () => {
    const { owner, editor, projectId } = await setup('req-share');
    await addRequirement(editor, projectId);
    const list = await request(app).get(url(projectId)).set('Cookie', owner);
    expect(list.body.requirements[0]).toMatchObject({ title: 'Login con correo', updatedByName: 'Beto Editor', source: 'manual' });
  });
});

describe('Requisitos: creación, categorías y validación', () => {
  test('registra las tres categorías y se pueden filtrar', async () => {
    const { owner, projectId } = await setup('req-cat');
    await addRequirement(owner, projectId, { title: 'A', category: 'functional' });
    await addRequirement(owner, projectId, { title: 'B', category: 'business_rule' });
    await addRequirement(owner, projectId, { title: 'C', category: 'integration' });
    const all = await request(app).get(url(projectId)).set('Cookie', owner);
    expect(all.body.requirements).toHaveLength(3);
    const rules = await request(app).get(`${url(projectId)}?category=business_rule`).set('Cookie', owner);
    expect(rules.body.requirements.map((r) => r.title)).toEqual(['B']);
    expect(rules.body.requirements[0].categoryLabel).toBe('Regla de negocio');
  });

  test('título y categoría obligatorios; se validan largos y categoría (400)', async () => {
    const { owner, projectId } = await setup('req-val');
    const post = (body) => request(app).post(url(projectId)).set('Cookie', owner).send(body);
    expect((await post({ category: 'functional' })).status).toBe(400);
    expect((await post({ title: 'X' })).status).toBe(400);
    expect((await post({ title: 'X', category: 'otra' })).status).toBe(400);
    expect((await post({ title: 'x'.repeat(121), category: 'functional' })).status).toBe(400);
    expect((await post({ title: 'X', description: 'x'.repeat(501), category: 'functional' })).status).toBe(400);
    const filter = await request(app).get(`${url(projectId)}?category=otra`).set('Cookie', owner);
    expect(filter.status).toBe(400);
  });
});

describe('Requisitos: edición concurrente', () => {
  test('editar con la versión correcta guarda y sube la versión', async () => {
    const { owner, editor, projectId } = await setup('req-edit');
    const item = await addRequirement(owner, projectId);
    const res = await request(app).put(url(projectId, item.id)).set('Cookie', editor)
      .send({ ...sample, title: 'Login con Google', version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.requirement).toMatchObject({ title: 'Login con Google', version: 2, updatedByName: 'Beto Editor' });
  });

  test('con versión vieja responde 409, devuelve el actual y NO sobrescribe', async () => {
    const { owner, editor, projectId } = await setup('req-409');
    const item = await addRequirement(owner, projectId);
    await request(app).put(url(projectId, item.id)).set('Cookie', owner).send({ ...sample, title: 'Cambio de Ana', version: 1 });
    const res = await request(app).put(url(projectId, item.id)).set('Cookie', editor).send({ ...sample, title: 'Cambio de Beto', version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.current.title).toBe('Cambio de Ana');
    const list = await request(app).get(url(projectId)).set('Cookie', owner);
    expect(list.body.requirements[0].title).toBe('Cambio de Ana');
  });

  test('sin versión 400; inexistente 404', async () => {
    const { owner, projectId } = await setup('req-ver');
    const item = await addRequirement(owner, projectId);
    expect((await request(app).put(url(projectId, item.id)).set('Cookie', owner).send(sample)).status).toBe(400);
    expect((await request(app).put(url(projectId, 'no-existe')).set('Cookie', owner).send({ ...sample, version: 1 })).status).toBe(404);
  });

  test('eliminar: versión correcta borra; vieja 409; sin versión 400', async () => {
    const { owner, editor, projectId } = await setup('req-del');
    const item = await addRequirement(owner, projectId);
    await request(app).put(url(projectId, item.id)).set('Cookie', owner).send({ ...sample, title: 'Nuevo', version: 1 });
    expect((await request(app).delete(`${url(projectId, item.id)}?version=1`).set('Cookie', editor)).status).toBe(409);
    expect((await request(app).delete(url(projectId, item.id)).set('Cookie', editor)).status).toBe(400);
    expect((await request(app).delete(`${url(projectId, item.id)}?version=2`).set('Cookie', editor)).status).toBe(200);
    expect((await request(app).delete(`${url(projectId, item.id)}?version=2`).set('Cookie', editor)).status).toBe(404);
  });
});
