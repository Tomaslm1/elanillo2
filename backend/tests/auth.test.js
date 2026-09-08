const request = require('supertest');
const app = require('../server');

describe('Auth endpoints', () => {
  test('POST /api/register crea un usuario nuevo', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({
        username: 'nuevo@ejemplo.com',
        password: 'Password123',
        name: 'Nuevo Usuario',
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Usuario registrado correctamente');
    expect(res.body.user).toMatchObject({
      username: 'nuevo@ejemplo.com',
      name: 'Nuevo Usuario',
    });
  });

  test('POST /api/register rechaza usuarios duplicados', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({
        username: 'test@example.com',
        password: 'Password123',
        name: 'Usuario duplicado',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('El usuario ya existe');
  });

  test('POST /api/register valida campos requeridos', async () => {
    const res = await request(app)
      .post('/api/register')
      .send({ username: 'sinpassword@test.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Faltan datos requeridos');
  });
});
