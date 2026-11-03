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

const base = (projectId) => `/api/projects/${projectId}/model`;
const userAttrs = [
  { name: 'id', type: 'uuid', primaryKey: true, required: true },
  { name: 'email', type: 'string', required: true },
];

async function addEntity(cookie, projectId, name = 'Usuario', attributes = userAttrs) {
  const res = await request(app).post(`${base(projectId)}/entities`).set('Cookie', cookie).send({ name, attributes });
  expect(res.status).toBe(201);
  return res.body.entity;
}

async function addRelation(cookie, projectId, from, to, type = 'one_to_many', name = '') {
  const res = await request(app).post(`${base(projectId)}/relations`).set('Cookie', cookie).send({ from, to, type, name });
  expect(res.status).toBe(201);
  return res.body.relation;
}

const getModel = (cookie, projectId, query = '') => request(app).get(`${base(projectId)}${query}`).set('Cookie', cookie);

describe('Modelo: permisos', () => {
  test('exigen sesión (401)', async () => {
    const { projectId } = await setup('mod-auth');
    expect((await request(app).get(base(projectId))).status).toBe(401);
    expect((await request(app).post(`${base(projectId)}/entities`).send({ name: 'X' })).status).toBe(401);
  });

  test('quien no es miembro recibe 404 en todas las rutas', async () => {
    const { owner, outsider, projectId } = await setup('mod-out');
    const a = await addEntity(owner, projectId, 'A');
    const b = await addEntity(owner, projectId, 'B');
    const rel = await addRelation(owner, projectId, a.id, b.id);
    const as = (req) => req.set('Cookie', outsider);
    expect((await as(request(app).get(base(projectId)))).status).toBe(404);
    expect((await as(request(app).post(`${base(projectId)}/entities`)).send({ name: 'X' })).status).toBe(404);
    expect((await as(request(app).put(`${base(projectId)}/entities/${a.id}`)).send({ name: 'X', version: 1 })).status).toBe(404);
    expect((await as(request(app).delete(`${base(projectId)}/entities/${a.id}?version=1`))).status).toBe(404);
    expect((await as(request(app).post(`${base(projectId)}/relations`)).send({ from: a.id, to: b.id, type: 'one_to_one' })).status).toBe(404);
    expect((await as(request(app).put(`${base(projectId)}/relations/${rel.id}`)).send({ from: a.id, to: b.id, type: 'one_to_one', version: 1 })).status).toBe(404);
    expect((await as(request(app).delete(`${base(projectId)}/relations/${rel.id}?version=1`))).status).toBe(404);
  });

  test('el viewer puede ver pero no crear, editar ni borrar (403)', async () => {
    const { owner, viewer, projectId } = await setup('mod-view');
    const a = await addEntity(owner, projectId, 'A');
    const b = await addEntity(owner, projectId, 'B');
    const rel = await addRelation(owner, projectId, a.id, b.id);
    const seen = await getModel(viewer, projectId);
    expect(seen.status).toBe(200);
    expect(seen.body.model.entities).toHaveLength(2);
    expect(seen.body.canEdit).toBe(false);
    const as = (req) => req.set('Cookie', viewer);
    expect((await as(request(app).post(`${base(projectId)}/entities`)).send({ name: 'X' })).status).toBe(403);
    expect((await as(request(app).put(`${base(projectId)}/entities/${a.id}`)).send({ name: 'X', version: 1 })).status).toBe(403);
    expect((await as(request(app).delete(`${base(projectId)}/entities/${a.id}?version=1`))).status).toBe(403);
    expect((await as(request(app).post(`${base(projectId)}/relations`)).send({ from: a.id, to: b.id, type: 'one_to_one' })).status).toBe(403);
    expect((await as(request(app).put(`${base(projectId)}/relations/${rel.id}`)).send({ from: a.id, to: b.id, type: 'one_to_one', version: 1 })).status).toBe(403);
    expect((await as(request(app).delete(`${base(projectId)}/relations/${rel.id}?version=1`))).status).toBe(403);
  });
});

describe('Modelo: los cambios de un colaborador los ven los demás', () => {
  test('lo que crea un editor lo ve el owner (con quién lo hizo)', async () => {
    const { owner, editor, projectId } = await setup('mod-share');
    await addEntity(editor, projectId, 'Pedido');
    const seen = await getModel(owner, projectId);
    expect(seen.body.model.entities[0]).toMatchObject({ name: 'Pedido', updatedByName: 'Beto Editor', version: 1 });
    expect(seen.body.canEdit).toBe(true);
  });

  test('?since=<revisión> responde solo si hubo cambios', async () => {
    const { owner, editor, projectId } = await setup('mod-since');
    const first = await getModel(owner, projectId);
    expect(first.body.model.revision).toBe(0);
    const same = await getModel(owner, projectId, '?since=0');
    expect(same.body).toEqual({ changed: false, revision: 0 });

    await addEntity(editor, projectId, 'Producto');
    const after = await getModel(owner, projectId, '?since=0');
    expect(after.body.changed).toBe(true);
    expect(after.body.model.revision).toBe(1);
    expect(after.body.model.entities).toHaveLength(1);
  });

  test('la revisión sube con cada cambio exitoso y no con los rechazados', async () => {
    const { owner, projectId } = await setup('mod-rev');
    const entity = await addEntity(owner, projectId, 'A');
    await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send({ name: '' }); // 400
    await request(app).put(`${base(projectId)}/entities/${entity.id}`).set('Cookie', owner).send({ name: 'A2', version: 9 }); // 409
    const model = (await getModel(owner, projectId)).body.model;
    expect(model.revision).toBe(1);
  });
});

describe('Modelo: entidades y validación de entrada (se rechaza con 400)', () => {
  test('crea una entidad con atributos y devuelve ids, versión y revisión', async () => {
    const { owner, projectId } = await setup('mod-ent');
    const res = await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner)
      .send({ name: '  Usuario ', attributes: userAttrs });
    expect(res.status).toBe(201);
    expect(res.body.entity).toMatchObject({ name: 'Usuario', version: 1 });
    expect(res.body.entity.attributes).toHaveLength(2);
    expect(res.body.entity.attributes[0]).toMatchObject({ name: 'id', type: 'uuid', primaryKey: true, required: true });
    expect(res.body.entity.attributes[0].id).toEqual(expect.any(String));
    expect(res.body.revision).toBe(1);
  });

  test('nombre obligatorio y de máximo 60 caracteres', async () => {
    const { owner, projectId } = await setup('mod-name');
    const post = (body) => request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send(body);
    expect((await post({})).status).toBe(400);
    expect((await post({ name: '   ' })).status).toBe(400);
    expect((await post({ name: 'x'.repeat(61) })).status).toBe(400);
  });

  test('valida los atributos: lista, nombre, tipo, repetidos y máximo', async () => {
    const { owner, projectId } = await setup('mod-attr');
    const post = (attributes) => request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send({ name: 'E', attributes });
    expect((await post('no-es-lista')).status).toBe(400);
    expect((await post([{ name: '', type: 'string' }])).status).toBe(400);
    expect((await post([{ name: 'a', type: 'inventado' }])).status).toBe(400);
    expect((await post([{ name: 'a', type: 'string' }, { name: 'A', type: 'integer' }])).status).toBe(400);
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `campo${i}`, type: 'string' }));
    expect((await post(many)).status).toBe(400);
    const model = (await getModel(owner, projectId)).body.model;
    expect(model.entities).toHaveLength(0); // nada se guardó
  });

  test('no permite dos entidades con el mismo nombre (sin importar mayúsculas): 409', async () => {
    const { owner, projectId } = await setup('mod-dup');
    await addEntity(owner, projectId, 'Cliente');
    const res = await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send({ name: 'cliente' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_NAME');
  });
});

describe('Modelo: edición concurrente de entidades', () => {
  test('editar con la versión correcta guarda, sube la versión y conserva los ids de atributos', async () => {
    const { owner, editor, projectId } = await setup('mod-edit');
    const entity = await addEntity(owner, projectId);
    const attrs = entity.attributes.concat({ name: 'nombre', type: 'string' });
    const res = await request(app).put(`${base(projectId)}/entities/${entity.id}`).set('Cookie', editor)
      .send({ name: 'Cuenta', attributes: attrs, version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.entity).toMatchObject({ name: 'Cuenta', version: 2, updatedByName: 'Beto Editor' });
    expect(res.body.entity.attributes).toHaveLength(3);
    expect(res.body.entity.attributes[0].id).toBe(entity.attributes[0].id);
  });

  test('si no envía atributos, se conservan los que tenía', async () => {
    const { owner, projectId } = await setup('mod-keep');
    const entity = await addEntity(owner, projectId);
    const res = await request(app).put(`${base(projectId)}/entities/${entity.id}`).set('Cookie', owner).send({ name: 'Otro', version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.entity.attributes).toHaveLength(2);
  });

  test('con versión vieja responde 409, devuelve el actual y NO sobrescribe', async () => {
    const { owner, editor, projectId } = await setup('mod-409');
    const entity = await addEntity(owner, projectId, 'Original');
    await request(app).put(`${base(projectId)}/entities/${entity.id}`).set('Cookie', owner).send({ name: 'Cambio de Ana', version: 1 });
    const res = await request(app).put(`${base(projectId)}/entities/${entity.id}`).set('Cookie', editor).send({ name: 'Cambio de Beto', version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.current.name).toBe('Cambio de Ana');
    expect((await getModel(owner, projectId)).body.model.entities[0].name).toBe('Cambio de Ana');
  });

  test('dos personas editando entidades DISTINTAS no se bloquean entre sí', async () => {
    const { owner, editor, projectId } = await setup('mod-parallel');
    const a = await addEntity(owner, projectId, 'A');
    const b = await addEntity(owner, projectId, 'B');
    const one = await request(app).put(`${base(projectId)}/entities/${a.id}`).set('Cookie', owner).send({ name: 'A editada', version: 1 });
    const two = await request(app).put(`${base(projectId)}/entities/${b.id}`).set('Cookie', editor).send({ name: 'B editada', version: 1 });
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
  });

  test('renombrar a un nombre que ya usa otra entidad da 409; sin versión 400; inexistente 404', async () => {
    const { owner, projectId } = await setup('mod-rename');
    await addEntity(owner, projectId, 'A');
    const b = await addEntity(owner, projectId, 'B');
    const put = (id, body) => request(app).put(`${base(projectId)}/entities/${id}`).set('Cookie', owner).send(body);
    const clash = await put(b.id, { name: 'a', version: 1 });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('DUPLICATE_NAME');
    expect((await put(b.id, { name: 'B2' })).status).toBe(400);
    expect((await put('no-existe', { name: 'X', version: 1 })).status).toBe(404);
  });

  test('eliminar: versión correcta borra; vieja 409; sin versión 400', async () => {
    const { owner, editor, projectId } = await setup('mod-del');
    const entity = await addEntity(owner, projectId, 'A');
    await request(app).put(`${base(projectId)}/entities/${entity.id}`).set('Cookie', owner).send({ name: 'A2', version: 1 });
    const del = (query) => request(app).delete(`${base(projectId)}/entities/${entity.id}${query}`).set('Cookie', editor);
    expect((await del('?version=1')).status).toBe(409);
    expect((await del('')).status).toBe(400);
    expect((await del('?version=2')).status).toBe(200);
    expect((await del('?version=2')).status).toBe(404);
  });

  test('al eliminar una entidad se eliminan sus relaciones y la respuesta las informa', async () => {
    const { owner, projectId } = await setup('mod-cascade');
    const a = await addEntity(owner, projectId, 'A');
    const b = await addEntity(owner, projectId, 'B');
    const c = await addEntity(owner, projectId, 'C');
    const ab = await addRelation(owner, projectId, a.id, b.id);
    await addRelation(owner, projectId, b.id, c.id);
    const res = await request(app).delete(`${base(projectId)}/entities/${a.id}?version=1`).set('Cookie', owner);
    expect(res.status).toBe(200);
    expect(res.body.removedRelations.map((r) => r.id)).toEqual([ab.id]);
    const model = (await getModel(owner, projectId)).body.model;
    expect(model.entities.map((e) => e.name)).toEqual(['B', 'C']);
    expect(model.relations).toHaveLength(1);
    expect(res.body.validation.valid).toBe(true);
  });
});

describe('Modelo: relaciones', () => {
  test('crea, edita y elimina una relación con versionado', async () => {
    const { owner, editor, projectId } = await setup('mod-rel');
    const a = await addEntity(owner, projectId, 'Cliente');
    const b = await addEntity(owner, projectId, 'Pedido');
    const rel = await addRelation(owner, projectId, a.id, b.id, 'one_to_many', 'realiza');
    expect(rel).toMatchObject({ from: a.id, to: b.id, type: 'one_to_many', name: 'realiza', version: 1 });

    const put = await request(app).put(`${base(projectId)}/relations/${rel.id}`).set('Cookie', editor)
      .send({ from: a.id, to: b.id, type: 'one_to_one', name: 'realiza', version: 1 });
    expect(put.status).toBe(200);
    expect(put.body.relation).toMatchObject({ type: 'one_to_one', version: 2 });

    const stale = await request(app).put(`${base(projectId)}/relations/${rel.id}`).set('Cookie', owner)
      .send({ from: a.id, to: b.id, type: 'many_to_many', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.type).toBe('one_to_one');

    expect((await request(app).delete(`${base(projectId)}/relations/${rel.id}?version=1`).set('Cookie', owner)).status).toBe(409);
    expect((await request(app).delete(`${base(projectId)}/relations/${rel.id}`).set('Cookie', owner)).status).toBe(400);
    expect((await request(app).delete(`${base(projectId)}/relations/${rel.id}?version=2`).set('Cookie', owner)).status).toBe(200);
    expect((await getModel(owner, projectId)).body.model.relations).toHaveLength(0);
  });

  test('rechaza entidades inexistentes, tipo inválido y nombre demasiado largo (400)', async () => {
    const { owner, projectId } = await setup('mod-relval');
    const a = await addEntity(owner, projectId, 'A');
    const post = (body) => request(app).post(`${base(projectId)}/relations`).set('Cookie', owner).send(body);
    expect((await post({ from: a.id, to: 'no-existe', type: 'one_to_one' })).status).toBe(400);
    expect((await post({ from: 'no-existe', to: a.id, type: 'one_to_one' })).status).toBe(400);
    expect((await post({ from: a.id, to: a.id, type: 'uno_a_uno' })).status).toBe(400);
    expect((await post({ from: a.id, to: a.id, type: 'one_to_one', name: 'x'.repeat(61) })).status).toBe(400);
    expect((await getModel(owner, projectId)).body.model.relations).toHaveLength(0);
  });

  test('permite relación de una entidad consigo misma, y rechaza duplicados exactos (409)', async () => {
    const { owner, projectId } = await setup('mod-self');
    const a = await addEntity(owner, projectId, 'Empleado');
    await addRelation(owner, projectId, a.id, a.id, 'one_to_many', 'jefe de');
    const dup = await request(app).post(`${base(projectId)}/relations`).set('Cookie', owner)
      .send({ from: a.id, to: a.id, type: 'one_to_many', name: 'JEFE DE' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_RELATION');
  });

  test('editar una relación que se eliminó junto con su entidad da 404', async () => {
    const { owner, projectId } = await setup('mod-gone');
    const a = await addEntity(owner, projectId, 'A');
    const b = await addEntity(owner, projectId, 'B');
    const rel = await addRelation(owner, projectId, a.id, b.id);
    await request(app).delete(`${base(projectId)}/entities/${b.id}?version=1`).set('Cookie', owner);
    const res = await request(app).put(`${base(projectId)}/relations/${rel.id}`).set('Cookie', owner)
      .send({ from: a.id, to: b.id, type: 'one_to_one', version: 1 });
    expect(res.status).toBe(404); // la relación se eliminó junto con B
  });
});

describe('Modelo: validación de estructura tras cada edición', () => {
  const codes = (res) => res.body.validation.issues.map((issue) => issue.code);

  test('avisa si la entidad no tiene atributos ni claves, pero igual guarda', async () => {
    const { owner, projectId } = await setup('mod-warn');
    const empty = await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send({ name: 'Vacia' });
    expect(empty.status).toBe(201);
    expect(codes(empty)).toContain('ENTITY_WITHOUT_ATTRIBUTES');
    expect(empty.body.validation.valid).toBe(true); // los avisos no invalidan el modelo

    const noPk = await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner)
      .send({ name: 'SinPk', attributes: [{ name: 'nombre', type: 'string' }] });
    expect(codes(noPk)).toContain('ENTITY_WITHOUT_PRIMARY_KEY');
  });

  test('avisa de entidades sin relaciones y lo deja de avisar al relacionarlas', async () => {
    const { owner, projectId } = await setup('mod-iso');
    const a = await addEntity(owner, projectId, 'A');
    const created = await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send({ name: 'B', attributes: userAttrs });
    expect(codes(created)).toContain('ENTITY_WITHOUT_RELATIONS');

    const rel = await request(app).post(`${base(projectId)}/relations`).set('Cookie', owner)
      .send({ from: a.id, to: created.body.entity.id, type: 'one_to_one' });
    expect(codes(rel)).not.toContain('ENTITY_WITHOUT_RELATIONS');
    expect(rel.body.validation).toEqual({ valid: true, issues: [] });
  });

  test('GET devuelve la validación actual del modelo', async () => {
    const { owner, projectId } = await setup('mod-get');
    await request(app).post(`${base(projectId)}/entities`).set('Cookie', owner).send({ name: 'Sola' });
    const res = await getModel(owner, projectId);
    expect(res.body.validation.issues.map((i) => i.code)).toContain('ENTITY_WITHOUT_ATTRIBUTES');
    expect(res.body.attributeTypes).toContain('uuid');
    expect(res.body.relationTypes).toEqual(['one_to_one', 'one_to_many', 'many_to_many']);
  });
});
