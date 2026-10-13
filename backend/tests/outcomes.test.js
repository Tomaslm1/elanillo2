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

// Crea un proyecto con un owner, un editor y un viewer. Devuelve las cookies de cada uno.
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

const url = (projectId, outcomeId = '') => `/api/projects/${projectId}/outcomes${outcomeId ? `/${outcomeId}` : ''}`;

async function addOutcome(cookie, projectId, body = { title: 'Aumentar ventas', metric: 'Ventas por mes', target: '+20%' }) {
  const res = await request(app).post(url(projectId)).set('Cookie', cookie).send(body);
  expect(res.status).toBe(201);
  return res.body.outcome;
}

describe('Resultados esperados: permisos', () => {
  test('exigen sesión (401)', async () => {
    expect((await request(app).get(url('x'))).status).toBe(401);
    expect((await request(app).post(url('x')).send({ title: 'a' })).status).toBe(401);
  });

  test('quien no es miembro recibe 404 en todas las rutas', async () => {
    const { owner, outsider, projectId } = await setup('perm1');
    const outcome = await addOutcome(owner, projectId);

    expect((await request(app).get(url(projectId)).set('Cookie', outsider)).status).toBe(404);
    expect((await request(app).post(url(projectId)).set('Cookie', outsider).send({ title: 'x' })).status).toBe(404);
    expect((await request(app).put(url(projectId, outcome.id)).set('Cookie', outsider).send({ title: 'x', version: 1 })).status).toBe(404);
    expect((await request(app).delete(`${url(projectId, outcome.id)}?version=1`).set('Cookie', outsider)).status).toBe(404);
  });

  test('el viewer puede ver pero no crear, editar ni borrar (403)', async () => {
    const { owner, viewer, projectId } = await setup('perm2');
    const outcome = await addOutcome(owner, projectId);

    const list = await request(app).get(url(projectId)).set('Cookie', viewer);
    expect(list.status).toBe(200);
    expect(list.body.canEdit).toBe(false);
    expect(list.body.outcomes).toHaveLength(1);

    expect((await request(app).post(url(projectId)).set('Cookie', viewer).send({ title: 'x' })).status).toBe(403);
    expect((await request(app).put(url(projectId, outcome.id)).set('Cookie', viewer).send({ title: 'x', version: 1 })).status).toBe(403);
    expect((await request(app).delete(`${url(projectId, outcome.id)}?version=1`).set('Cookie', viewer)).status).toBe(403);
  });

  test('owner y editor pueden crear (canEdit = true)', async () => {
    const { owner, editor, projectId } = await setup('perm3');

    await addOutcome(owner, projectId, { title: 'Del owner' });
    await addOutcome(editor, projectId, { title: 'Del editor' });

    const list = await request(app).get(url(projectId)).set('Cookie', editor);
    expect(list.body.canEdit).toBe(true);
    expect(list.body.outcomes.map((o) => o.title)).toEqual(['Del owner', 'Del editor']);
  });
});

describe('Resultados esperados: creación y validación', () => {
  test('crea con versión 1 y registra quién lo modificó', async () => {
    const { editor, projectId } = await setup('val1');

    const outcome = await addOutcome(editor, projectId, { title: '  Reducir errores ', metric: 'Errores/semana', target: '< 5' });

    expect(outcome).toMatchObject({ title: 'Reducir errores', metric: 'Errores/semana', target: '< 5', version: 1, updatedByName: 'Beto Editor' });
  });

  test('el título es obligatorio y se validan los largos máximos (400)', async () => {
    const { owner, projectId } = await setup('val2');

    const sinTitulo = await request(app).post(url(projectId)).set('Cookie', owner).send({ title: '  ', metric: 'm' });
    expect(sinTitulo.status).toBe(400);
    expect(sinTitulo.body.error).toBe('El resultado esperado es obligatorio');

    for (const body of [{ title: 'a'.repeat(121) }, { title: 'ok', metric: 'a'.repeat(161) }, { title: 'ok', target: 'a'.repeat(81) }]) {
      expect((await request(app).post(url(projectId)).set('Cookie', owner).send(body)).status).toBe(400);
    }
  });
});

describe('Resultados esperados: edición concurrente (versionado)', () => {
  test('editar con la versión correcta guarda y sube la versión', async () => {
    const { owner, editor, projectId } = await setup('ver1');
    const outcome = await addOutcome(owner, projectId);

    const res = await request(app).put(url(projectId, outcome.id)).set('Cookie', editor)
      .send({ title: 'Nuevo título', metric: 'm', target: 't', version: 1 });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toMatchObject({ title: 'Nuevo título', version: 2, updatedByName: 'Beto Editor' });
  });

  test('los cambios de un colaborador son visibles para los demás', async () => {
    const { owner, editor, viewer, projectId } = await setup('ver2');
    const outcome = await addOutcome(owner, projectId);
    await request(app).put(url(projectId, outcome.id)).set('Cookie', editor).send({ title: 'Cambio del editor', version: 1 });

    for (const cookie of [owner, viewer]) {
      const list = await request(app).get(url(projectId)).set('Cookie', cookie);
      expect(list.body.outcomes[0]).toMatchObject({ title: 'Cambio del editor', version: 2, updatedByName: 'Beto Editor' });
    }
  });

  test('con una versión vieja responde 409, devuelve el valor actual y NO sobrescribe', async () => {
    const { owner, editor, projectId } = await setup('ver3');
    const outcome = await addOutcome(owner, projectId);

    // El editor guarda primero (versión 1 -> 2).
    await request(app).put(url(projectId, outcome.id)).set('Cookie', editor).send({ title: 'Primero en guardar', version: 1 });
    // El owner todavía tenía la versión 1 abierta.
    const stale = await request(app).put(url(projectId, outcome.id)).set('Cookie', owner).send({ title: 'Cambio atrasado', version: 1 });

    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.current).toMatchObject({ title: 'Primero en guardar', version: 2, updatedByName: 'Beto Editor' });

    const list = await request(app).get(url(projectId)).set('Cookie', owner);
    expect(list.body.outcomes[0].title).toBe('Primero en guardar');
  });

  test('tras un 409, reintentar con la versión actual sí guarda (decisión explícita)', async () => {
    const { owner, editor, projectId } = await setup('ver4');
    const outcome = await addOutcome(owner, projectId);
    await request(app).put(url(projectId, outcome.id)).set('Cookie', editor).send({ title: 'Editor', version: 1 });
    const stale = await request(app).put(url(projectId, outcome.id)).set('Cookie', owner).send({ title: 'Owner', version: 1 });

    const retry = await request(app).put(url(projectId, outcome.id)).set('Cookie', owner)
      .send({ title: 'Owner', version: stale.body.current.version });

    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toMatchObject({ title: 'Owner', version: 3 });
  });

  test('editar sin versión (o inválida) responde 400', async () => {
    const { owner, projectId } = await setup('ver5');
    const outcome = await addOutcome(owner, projectId);

    for (const version of [undefined, null, '', 0, -1, 1.5, 'abc']) {
      const res = await request(app).put(url(projectId, outcome.id)).set('Cookie', owner).send({ title: 'x', version });
      expect(res.status).toBe(400);
    }
  });

  test('editar un resultado que ya no existe responde 404', async () => {
    const { owner, projectId } = await setup('ver6');

    const res = await request(app).put(url(projectId, 'no-existe')).set('Cookie', owner).send({ title: 'x', version: 1 });

    expect(res.status).toBe(404);
  });
});

describe('Resultados esperados: eliminar', () => {
  test('elimina con la versión correcta', async () => {
    const { owner, projectId } = await setup('del1');
    const outcome = await addOutcome(owner, projectId);

    const res = await request(app).delete(`${url(projectId, outcome.id)}?version=1`).set('Cookie', owner);

    expect(res.status).toBe(200);
    const list = await request(app).get(url(projectId)).set('Cookie', owner);
    expect(list.body.outcomes).toHaveLength(0);
  });

  test('con versión vieja responde 409 y no borra (descartaría el cambio de otra persona)', async () => {
    const { owner, editor, projectId } = await setup('del2');
    const outcome = await addOutcome(owner, projectId);
    await request(app).put(url(projectId, outcome.id)).set('Cookie', editor).send({ title: 'Editado', version: 1 });

    const res = await request(app).delete(`${url(projectId, outcome.id)}?version=1`).set('Cookie', owner);

    expect(res.status).toBe(409);
    const list = await request(app).get(url(projectId)).set('Cookie', owner);
    expect(list.body.outcomes).toHaveLength(1);
  });

  test('sin versión responde 400; si ya no existe, 404', async () => {
    const { owner, projectId } = await setup('del3');
    const outcome = await addOutcome(owner, projectId);

    expect((await request(app).delete(url(projectId, outcome.id)).set('Cookie', owner)).status).toBe(400);
    expect((await request(app).delete(`${url(projectId, 'no-existe')}?version=1`).set('Cookie', owner)).status).toBe(404);
  });
});
