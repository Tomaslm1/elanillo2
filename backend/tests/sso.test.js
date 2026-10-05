const request = require('supertest');
const app = require('../server');

const originalFetch = global.fetch;

function setGoogleEnv() {
  process.env.GOOGLE_CLIENT_ID = 'client-id-test';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret-test';
  process.env.FRONTEND_URL = 'http://localhost:3001';
}

// Simula las dos llamadas a Google (token y perfil) sin salir a internet.
function mockGoogle(profile) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'google-access-token' }) };
    }
    return { ok: true, json: async () => profile };
  });
}

function redirectParams(res) {
  return new URL(res.headers.location).searchParams;
}

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.FRONTEND_URL;
});

describe('SSO con Google', () => {
  test('GET /api/auth/google avisa si el servidor no está configurado', async () => {
    const res = await request(app).get('/api/auth/google');

    expect(res.status).toBe(302);
    expect(redirectParams(res).get('sso_error')).toBe('sso_not_configured');
  });

  test('GET /api/auth/google redirige a Google con state y guarda el state en cookie', async () => {
    setGoogleEnv();

    const res = await request(app).get('/api/auth/google');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    const state = redirectParams(res).get('state');
    expect(state).toEqual(expect.any(String));
    expect(res.headers['set-cookie'].join(';')).toContain(`sso_state=${state}`);
  });

  test('callback rechaza un state que no coincide', async () => {
    setGoogleEnv();

    const res = await request(app)
      .get('/api/auth/google/callback?code=abc&state=falso')
      .set('Cookie', 'sso_state=otro');

    expect(redirectParams(res).get('sso_error')).toBe('invalid_state');
  });

  test('callback informa cuando el usuario cancela en Google', async () => {
    setGoogleEnv();

    const res = await request(app).get('/api/auth/google/callback?error=access_denied');

    expect(redirectParams(res).get('sso_error')).toBe('access_denied');
  });

  test('callback exitoso crea el usuario e inicia sesión', async () => {
    setGoogleEnv();
    mockGoogle({ sub: 'g-123', email: 'Nuevo@Gmail.com', email_verified: true, name: 'Nuevo SSO' });

    const res = await request(app)
      .get('/api/auth/google/callback?code=abc&state=s1')
      .set('Cookie', 'sso_state=s1');

    expect(res.status).toBe(302);
    expect(redirectParams(res).get('sso')).toBe('success');

    const cookies = res.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
    const me = await request(app).get('/api/me').set('Cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ username: 'nuevo@gmail.com', name: 'Nuevo SSO' });
  });

  test('callback rechaza correos no verificados por Google', async () => {
    setGoogleEnv();
    mockGoogle({ sub: 'g-456', email: 'sinverificar@gmail.com', email_verified: false, name: 'X' });

    const res = await request(app)
      .get('/api/auth/google/callback?code=abc&state=s1')
      .set('Cookie', 'sso_state=s1');

    expect(redirectParams(res).get('sso_error')).toBe('email_not_verified');
  });

  test('callback no vincula una cuenta existente con contraseña', async () => {
    setGoogleEnv();
    mockGoogle({ sub: 'g-789', email: 'test@example.com', email_verified: true, name: 'Demo' });

    const res = await request(app)
      .get('/api/auth/google/callback?code=abc&state=s1')
      .set('Cookie', 'sso_state=s1');

    expect(redirectParams(res).get('sso_error')).toBe('account_exists');
    expect((res.headers['set-cookie'] || []).join(';')).not.toContain('refresh_token=');
  });

  test('un usuario SSO no puede entrar por /api/login (no tiene contraseña)', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'nuevo@gmail.com', password: 'cualquiera' });

    expect(res.status).toBe(401);
  });
});
