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

  test('POST /api/request-password-reset genera un token temporal', async () => {
    const res = await request(app)
      .post('/api/request-password-reset')
      .send({ username: 'test@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Si la cuenta existe');
    expect(res.body.resetToken).toEqual(expect.any(String));
  });

  test('POST /api/request-password-reset no revela si el correo existe', async () => {
    const res = await request(app)
      .post('/api/request-password-reset')
      .send({ username: 'no-existe@ejemplo.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Si la cuenta existe');
    expect(res.body.resetToken).toBeUndefined();
  });

  test('POST /api/reset-password cambia la contraseña y consume el token', async () => {
    const tokenResponse = await request(app)
      .post('/api/request-password-reset')
      .send({ username: 'test@example.com' });

    const resetResponse = await request(app)
      .post('/api/reset-password')
      .send({ token: tokenResponse.body.resetToken, password: 'nuevaClave123' });

    expect(resetResponse.status).toBe(200);
    expect(resetResponse.body.message).toBe('Contraseña actualizada correctamente');

    const loginResponse = await request(app)
      .post('/api/login')
      .send({ username: 'test@example.com', password: 'nuevaClave123' });
    expect(loginResponse.status).toBe(200);

    const reusedTokenResponse = await request(app)
      .post('/api/reset-password')
      .send({ token: tokenResponse.body.resetToken, password: 'otraClave123' });
    expect(reusedTokenResponse.status).toBe(400);
  });

  test('POST /api/reset-password rechaza un token inválido', async () => {
    const res = await request(app)
      .post('/api/reset-password')
      .send({ token: 'token-invalido', password: 'nuevaClave123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El enlace de recuperación no es válido');
  });

  test('POST /api/reset-password rechaza un token expirado', async () => {
    const tokenResponse = await request(app)
      .post('/api/request-password-reset')
      .send({ username: 'test@example.com' });
    const currentTime = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(currentTime + 16 * 60 * 1000);

    const res = await request(app)
      .post('/api/reset-password')
      .send({ token: tokenResponse.body.resetToken, password: 'nuevaClave123' });

    nowSpy.mockRestore();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('El enlace de recuperación expiró');
  });
});
