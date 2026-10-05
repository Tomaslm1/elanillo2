const request = require('supertest');
const app = require('../server');

// Devuelve el header Cookie listo para usar en las siguientes peticiones.
function cookieHeader(res) {
  return res.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
}

async function login(username, password) {
  const res = await request(app).post('/api/login').send({ username, password });
  expect(res.status).toBe(200);
  return cookieHeader(res);
}

async function registerAndLogin(username, name = 'Usuario Test') {
  const reg = await request(app).post('/api/register').send({ username, name, password: 'Password123' });
  expect(reg.status).toBe(201);
  return login(username, 'Password123');
}

async function createProject(cookie, name = 'Proyecto A', description = '') {
  const res = await request(app).post('/api/projects').set('Cookie', cookie).send({ name, description });
  expect(res.status).toBe(201);
  return res.body.project;
}

function invite(cookie, projectId, body) {
  return request(app).post(`/api/projects/${projectId}/members`).set('Cookie', cookie).send(body);
}

describe('Proyectos: creación y listado', () => {
  test('exigen sesión (401 sin cookie)', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).post('/api/projects').send({ name: 'X' })).status).toBe(401);
  });

  test('POST /api/projects crea el proyecto y deja al creador como owner', async () => {
    const cookie = await login('test@example.com', 'password123');

    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: '  Mi proyecto  ', description: 'Descripción' });

    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({
      name: 'Mi proyecto', // se recorta con trim
      description: 'Descripción',
      role: 'owner',
      memberCount: 1,
    });
  });

  test('POST /api/projects valida nombre obligatorio y largos máximos', async () => {
    const cookie = await login('test@example.com', 'password123');

    const sinNombre = await request(app).post('/api/projects').set('Cookie', cookie).send({ name: '   ' });
    expect(sinNombre.status).toBe(400);
    expect(sinNombre.body.error).toBe('El nombre del proyecto es obligatorio');

    const nombreLargo = await request(app).post('/api/projects').set('Cookie', cookie).send({ name: 'a'.repeat(81) });
    expect(nombreLargo.status).toBe(400);

    const descLarga = await request(app)
      .post('/api/projects')
      .set('Cookie', cookie)
      .send({ name: 'ok', description: 'a'.repeat(301) });
    expect(descLarga.status).toBe(400);
  });

  test('GET /api/projects lista solo los proyectos del usuario', async () => {
    const owner = await registerAndLogin('lista-owner@ejemplo.com');
    const other = await registerAndLogin('lista-otro@ejemplo.com');
    const project = await createProject(owner, 'Solo del owner');

    const ownerList = await request(app).get('/api/projects').set('Cookie', owner);
    const otherList = await request(app).get('/api/projects').set('Cookie', other);

    expect(ownerList.body.projects.map((p) => p.id)).toContain(project.id);
    expect(otherList.body.projects.map((p) => p.id)).not.toContain(project.id);
  });
});

describe('Proyectos: invitar colaborador', () => {
  test('el owner agrega a un usuario existente con el rol indicado (201)', async () => {
    const owner = await registerAndLogin('inv-owner@ejemplo.com');
    const guest = await registerAndLogin('inv-guest@ejemplo.com', 'Invitado');
    const project = await createProject(owner);

    const res = await invite(owner, project.id, { email: 'Inv-Guest@Ejemplo.com', role: 'editor' });

    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ username: 'inv-guest@ejemplo.com', role: 'editor' });

    // El invitado ahora ve el proyecto con su rol, y el contador de miembros subió.
    const guestList = await request(app).get('/api/projects').set('Cookie', guest);
    expect(guestList.body.projects.find((p) => p.id === project.id)).toMatchObject({
      role: 'editor',
      memberCount: 2,
    });
  });

  test('rechaza con 409 si el usuario ya es miembro', async () => {
    const owner = await registerAndLogin('dup-owner@ejemplo.com');
    await registerAndLogin('dup-guest@ejemplo.com');
    const project = await createProject(owner);

    const first = await invite(owner, project.id, { email: 'dup-guest@ejemplo.com', role: 'viewer' });
    const second = await invite(owner, project.id, { email: 'dup-guest@ejemplo.com', role: 'editor' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('El usuario ya es miembro del proyecto');
  });

  test('rechaza con 409 si el owner se invita a sí mismo', async () => {
    const owner = await registerAndLogin('self-owner@ejemplo.com');
    const project = await createProject(owner);

    const res = await invite(owner, project.id, { email: 'self-owner@ejemplo.com', role: 'viewer' });

    expect(res.status).toBe(409);
  });

  test('rechaza con 403 si quien invita es miembro pero no owner', async () => {
    const owner = await registerAndLogin('perm-owner@ejemplo.com');
    const editor = await registerAndLogin('perm-editor@ejemplo.com');
    await registerAndLogin('perm-tercero@ejemplo.com');
    const project = await createProject(owner);
    await invite(owner, project.id, { email: 'perm-editor@ejemplo.com', role: 'editor' });

    const res = await invite(editor, project.id, { email: 'perm-tercero@ejemplo.com', role: 'viewer' });

    expect(res.status).toBe(403);
  });

  test('responde 404 si el proyecto no existe o quien invita no es miembro', async () => {
    const owner = await registerAndLogin('nf-owner@ejemplo.com');
    const stranger = await registerAndLogin('nf-extrano@ejemplo.com');
    const project = await createProject(owner);

    const noExiste = await invite(owner, 'id-que-no-existe', { email: 'x@y.com', role: 'viewer' });
    const ajeno = await invite(stranger, project.id, { email: 'nf-extrano@ejemplo.com', role: 'viewer' });

    expect(noExiste.status).toBe(404);
    expect(ajeno.status).toBe(404); // no se revela que el proyecto existe
  });

  test('valida el rol (no se puede invitar como owner) y el correo', async () => {
    const owner = await registerAndLogin('val-owner@ejemplo.com');
    await registerAndLogin('val-guest@ejemplo.com');
    const project = await createProject(owner);

    const rolOwner = await invite(owner, project.id, { email: 'val-guest@ejemplo.com', role: 'owner' });
    const sinRol = await invite(owner, project.id, { email: 'val-guest@ejemplo.com' });
    const sinEmail = await invite(owner, project.id, { role: 'viewer' });

    expect(rolOwner.status).toBe(400);
    expect(sinRol.status).toBe(400);
    expect(sinEmail.status).toBe(400);
  });

  test('responde 404 si el correo no pertenece a un usuario registrado', async () => {
    const owner = await registerAndLogin('nouser-owner@ejemplo.com');
    const project = await createProject(owner);

    const res = await invite(owner, project.id, { email: 'fantasma@ejemplo.com', role: 'viewer' });

    expect(res.status).toBe(404);
  });

  test('exige sesión (401 sin cookie)', async () => {
    const res = await request(app).post('/api/projects/cualquiera/members').send({ email: 'a@b.com', role: 'viewer' });

    expect(res.status).toBe(401);
  });
});
