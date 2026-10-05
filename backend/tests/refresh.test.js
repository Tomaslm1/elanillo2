const request = require('supertest');
const app = require('../server');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Cada archivo de test carga su propia copia de server.js, así que aquí
// el usuario demo todavía tiene la contraseña original (password123).
async function loginDemo() {
  const res = await request(app)
    .post('/api/login')
    .send({ username: 'test@example.com', password: 'password123' });
  expect(res.status).toBe(200);
  return res;
}

// Se arma el header Cookie a mano (en vez de usar request.agent) porque el agente
// descarta cookies vencidas usando Date.now(), que acá estamos adelantando con un mock.
function cookieHeader(res) {
  return res.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
}

function cookieNamed(res, name) {
  return res.headers['set-cookie'].find((cookie) => cookie.startsWith(`${name}=`));
}

// Adelanta el reloj para simular que pasó el tiempo.
function advanceTime(ms) {
  return jest.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Sesión: access token y refresh token', () => {
  test('POST /api/login entrega access y refresh token en cookies HttpOnly', async () => {
    const res = await loginDemo();

    expect(cookieNamed(res, 'token')).toMatch(/HttpOnly/);
    expect(cookieNamed(res, 'refresh_token')).toMatch(/HttpOnly/);
  });

  test('GET /api/me acepta un access token vigente', async () => {
    const login = await loginDemo();

    const res = await request(app).get('/api/me').set('Cookie', cookieHeader(login));

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'test@example.com' });
  });

  test('GET /api/me rechaza un access token expirado con 401', async () => {
    const login = await loginDemo();
    advanceTime(16 * MINUTE); // el access token dura 15 minutos

    const res = await request(app).get('/api/me').set('Cookie', cookieHeader(login));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('POST /api/refresh con refresh token válido emite un access token nuevo', async () => {
    const login = await loginDemo();

    const refresh = await request(app).post('/api/refresh').set('Cookie', cookieHeader(login));

    expect(refresh.status).toBe(200);
    expect(refresh.body.user).toMatchObject({ username: 'test@example.com' });
    expect(cookieNamed(refresh, 'token')).toBeDefined();
    // Rotación: el refresh token nuevo es distinto al anterior.
    expect(cookieNamed(refresh, 'refresh_token')).not.toBe(cookieNamed(login, 'refresh_token'));
  });

  test('flujo completo: el access token vence, se renueva y la sesión sigue activa', async () => {
    const login = await loginDemo();
    advanceTime(16 * MINUTE);

    const expired = await request(app).get('/api/me').set('Cookie', cookieHeader(login));
    expect(expired.status).toBe(401);

    const refresh = await request(app).post('/api/refresh').set('Cookie', cookieHeader(login));
    expect(refresh.status).toBe(200);

    const me = await request(app).get('/api/me').set('Cookie', cookieHeader(refresh));
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('test@example.com');
  });

  test('POST /api/refresh sin cookie responde 401', async () => {
    const res = await request(app).post('/api/refresh');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_REFRESH_TOKEN');
  });

  test('POST /api/refresh rechaza un refresh token inválido con 401', async () => {
    const res = await request(app).post('/api/refresh').set('Cookie', 'refresh_token=inventado');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  test('POST /api/refresh rechaza un refresh token expirado con 401', async () => {
    const login = await loginDemo();
    advanceTime(8 * DAY); // el refresh token dura 7 días

    const res = await request(app).post('/api/refresh').set('Cookie', cookieHeader(login));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REFRESH_TOKEN_EXPIRED');
  });

  test('el refresh token es de un solo uso', async () => {
    const login = await loginDemo();

    const first = await request(app).post('/api/refresh').set('Cookie', cookieHeader(login));
    const reused = await request(app).post('/api/refresh').set('Cookie', cookieHeader(login));

    expect(first.status).toBe(200);
    expect(reused.status).toBe(401);
  });

  test('POST /api/logout revoca el refresh token', async () => {
    const login = await loginDemo();

    const logout = await request(app).post('/api/logout').set('Cookie', cookieHeader(login));
    expect(logout.status).toBe(200);

    const refresh = await request(app).post('/api/refresh').set('Cookie', cookieHeader(login));
    expect(refresh.status).toBe(401);
  });
});
