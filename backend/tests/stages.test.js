// Pruebas funcionales del flujo de Ideator: etapas, preguntas bloqueantes, edición colaborativa,
// revisión final y exportación. El LLM se reemplaza por uno falso y determinístico.
const request = require('supertest');
const app = require('../server');
const { setLlm } = require('../src/llm');
const { CONTENTS, clone } = require('./helpers/fixtures');

const STAGE_BY_SCHEMA = {
  ideator_definition_turn: 'DEFINITION',
  ideator_data_model_turn: 'DATA_MODEL',
  ideator_api_turn: 'API',
  ideator_frontend_turn: 'FRONTEND',
  ideator_architecture_turn: 'ARCHITECTURE',
};

// LLM falso: devuelve el fixture de la etapa. Se pueden encolar preguntas/issues para el próximo llamado.
function createFakeLlm() {
  const fake = {
    calls: [],
    nextQuestions: [],
    reviewIssues: [],
    fail: false,
    async completeJson({ name, messages, system }) {
      fake.calls.push({ name, messages, system });
      if (fake.fail) {
        const { HttpError } = require('../src/http');
        throw new HttpError(502, 'El asistente de IA no respondió correctamente. Intenta de nuevo.', { code: 'LLM_ERROR' });
      }
      if (name === 'ideator_review') {
        const issues = fake.reviewIssues;
        fake.reviewIssues = [];
        return { issues, summary: issues.length ? 'Hay problemas' : 'Todo consistente' };
      }
      const stage = STAGE_BY_SCHEMA[name];
      const newQuestions = fake.nextQuestions;
      fake.nextQuestions = [];
      const content = clone(CONTENTS[stage]);
      if (fake.breakNext) {
        fake.breakNext(content);
        fake.breakNext = null;
      }
      return { reply: `Actualicé ${stage}`, content, newQuestions, resolvedQuestionIds: [] };
    },
  };
  return fake;
}

let llm;
beforeEach(() => {
  llm = createFakeLlm();
  setLlm(llm);
});
afterAll(() => setLlm(null));

function cookieHeader(res) {
  return res.headers['set-cookie'].map((cookie) => cookie.split(';')[0]).join('; ');
}

async function registerAndLogin(username, name = 'Usuario') {
  await request(app).post('/api/register').send({ username, name, password: 'Password123' });
  const res = await request(app).post('/api/login').send({ username, password: 'Password123' });
  expect(res.status).toBe(200);
  return cookieHeader(res);
}

function api(cookie) {
  const withCookie = (req) => (cookie ? req.set('Cookie', cookie) : req);
  return {
    get: (path) => withCookie(request(app).get(path)),
    // Las rutas de IA corren en segundo plano; con ?wait=true el test espera el resultado.
    post: (path, body = {}) => withCookie(request(app).post(/\/(messages|generate|answers|review)$/.test(path) ? `${path}?wait=true` : path)).send(body),
    postAsync: (path, body = {}) => withCookie(request(app).post(path)).send(body),
    put: (path, body = {}) => withCookie(request(app).put(path)).send(body),
    patch: (path, body = {}) => withCookie(request(app).patch(path)).send(body),
    delete: (path) => withCookie(request(app).delete(path)),
  };
}

async function createProject(client, name = 'GymBook') {
  const res = await client.post('/api/projects', { name, description: 'Reservas de gimnasio' });
  expect(res.status).toBe(201);
  return res.body.project.id;
}

async function getStage(client, projectId, stage) {
  const res = await client.get(`/api/projects/${projectId}/stages/${stage}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function approve(client, projectId, stage) {
  const { version } = await getStage(client, projectId, stage);
  return client.post(`/api/projects/${projectId}/stages/${stage}/approve`, { version });
}

// Lleva un proyecto hasta tener todas las etapas aprobadas.
async function completeAllStages(client, projectId) {
  expect((await client.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'Quiero una app de reservas' })).status).toBe(201);
  expect((await approve(client, projectId, 'DEFINITION')).status).toBe(200);
  for (const stage of ['DATA_MODEL', 'API', 'FRONTEND', 'ARCHITECTURE']) {
    expect((await client.post(`/api/projects/${projectId}/stages/${stage}/generate`)).status).toBe(201);
    const res = await approve(client, projectId, stage);
    expect(res.status).toBe(200);
  }
}

describe('Etapa 1: definición con preguntas bloqueantes', () => {
  test('la IA propone, deja preguntas bloqueantes y no se puede aprobar hasta resolverlas', async () => {
    const owner = api(await registerAndLogin('owner1@test.com', 'Owner'));
    const projectId = await createProject(owner);

    const project = await owner.get(`/api/projects/${projectId}`);
    expect(project.status).toBe(200);
    expect(project.body.stages.map((s) => s.stage)).toEqual(['DEFINITION', 'DATA_MODEL', 'API', 'FRONTEND', 'ARCHITECTURE', 'REVIEW']);
    expect(project.body.stages[0].status).toBe('DRAFT');

    llm.nextQuestions = [
      { text: '¿Los socios pagan dentro de la app?', reason: 'Cambia el modelo de datos', blocking: true },
      { text: '¿Qué color de marca?', reason: 'Estético', blocking: false },
    ];
    const turn = await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'Quiero una app de reservas para mi gimnasio' });
    expect(turn.status).toBe(201);
    expect(turn.body).toMatchObject({ reply: 'Actualicé DEFINITION', version: 1, newQuestions: 2 });

    const stage = await getStage(owner, projectId, 'DEFINITION');
    expect(stage.content.productName).toBe('GymBook');
    expect(stage.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stage.messages[0].author.username).toBe('owner1@test.com');
    expect(stage.updatedBy.username).toBe('owner1@test.com');
    const blocking = stage.questions.find((q) => q.blocking);
    expect(blocking.status).toBe('open');

    const denied = await owner.post(`/api/projects/${projectId}/stages/DEFINITION/approve`, { version: stage.version });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('BLOCKING_QUESTIONS');

    // Etapa siguiente bloqueada hasta aprobar la anterior.
    const early = await owner.post(`/api/projects/${projectId}/stages/DATA_MODEL/generate`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('PREVIOUS_STAGE_NOT_APPROVED');

    const answered = await owner.post(`/api/projects/${projectId}/questions/answers`, {
      answers: [{ questionId: blocking.id, answer: 'No, se paga en recepción' }],
    });
    expect(answered.status).toBe(201);
    expect(answered.body.turn.version).toBe(2);
    // La IA recibió la respuesta como parte de la conversación.
    expect(llm.calls.at(-1).messages.at(-1).content).toContain('No, se paga en recepción');

    // La pregunta no bloqueante no impide aprobar.
    const ok = await approve(owner, projectId, 'DEFINITION');
    expect(ok.status).toBe(200);
    const after = await owner.get(`/api/projects/${projectId}`);
    expect(after.body.project.currentStage).toBe('DATA_MODEL');
    expect(after.body.stages[0].status).toBe('APPROVED');
  });

  test('si el LLM falla responde 502 y la etapa no cambia', async () => {
    const owner = api(await registerAndLogin('owner2@test.com'));
    const projectId = await createProject(owner);
    llm.fail = true;
    const res = await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'hola' });
    expect(res.status).toBe(502);
    const stage = await getStage(owner, projectId, 'DEFINITION');
    expect(stage.version).toBe(0);
    expect(stage.content).toBeNull();
  });

  test('sin LLM configurado responde 503', async () => {
    setLlm(null);
    const owner = api(await registerAndLogin('owner3@test.com'));
    const projectId = await createProject(owner);
    const res = await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'hola' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('LLM_NOT_CONFIGURED');
  });

  test('valida el mensaje (400)', async () => {
    const owner = api(await registerAndLogin('owner4@test.com'));
    const projectId = await createProject(owner);
    expect((await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: '  ' })).status).toBe(400);
    expect((await owner.post(`/api/projects/${projectId}/stages/NOPE/messages`, { message: 'x' })).status).toBe(404);
  });
});

describe('Modelo de datos: edición colaborativa con control de versiones', () => {
  test('edición manual con versión vieja → 409, inválida → 422, inconsistente no se aprueba, historial con autor', async () => {
    const owner = api(await registerAndLogin('owner5@test.com', 'Owner'));
    const projectId = await createProject(owner);
    await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'idea' });
    await approve(owner, projectId, 'DEFINITION');

    expect((await owner.post(`/api/projects/${projectId}/stages/DATA_MODEL/generate`)).status).toBe(201);
    // La propuesta de la IA usa la definición aprobada como contexto.
    const call = llm.calls.at(-1);
    expect(call.name).toBe('ideator_data_model_turn');
    expect(call.messages[0].content).toContain('ETAPA APROBADA "Definición del producto"');
    expect(call.messages[0].content).toContain('GymBook');

    const stage = await getStage(owner, projectId, 'DATA_MODEL');
    expect(stage.diagrams.er).toMatch(/^erDiagram/);

    const edited = clone(stage.content);
    edited.entities[2].attributes[1].references.entity = 'Member'; // FK rota

    const stale = await owner.put(`/api/projects/${projectId}/stages/DATA_MODEL/content`, { content: edited, version: stage.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const invalid = await owner.put(`/api/projects/${projectId}/stages/DATA_MODEL/content`, { content: { entities: 'x' }, version: stage.version });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('INVALID_CONTENT');

    const saved = await owner.put(`/api/projects/${projectId}/stages/DATA_MODEL/content`, { content: edited, version: stage.version, note: 'FK a Member' });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(stage.version + 1);

    const blocked = await approve(owner, projectId, 'DATA_MODEL');
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('CONSISTENCY_ERRORS');
    expect(blocked.body.findings[0].message).toContain('Member');

    edited.entities[2].attributes[1].references.entity = 'User';
    const fixed = await owner.put(`/api/projects/${projectId}/stages/DATA_MODEL/content`, { content: edited, version: saved.body.version });
    expect(fixed.status).toBe(200);
    expect((await approve(owner, projectId, 'DATA_MODEL')).status).toBe(200);

    const versions = await owner.get(`/api/projects/${projectId}/stages/DATA_MODEL/versions`);
    expect(versions.body.versions.map((v) => v.source)).toEqual(['manual', 'manual', 'ai']);
    expect(versions.body.versions[1]).toMatchObject({ note: 'FK a Member', createdBy: { username: 'owner5@test.com' } });
  });
});

describe('Autocorrección de la IA', () => {
  test('si la propuesta es inconsistente se pide una corrección antes de guardarla', async () => {
    const owner = api(await registerAndLogin('owner7@test.com'));
    const projectId = await createProject(owner);
    await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'idea' });
    await approve(owner, projectId, 'DEFINITION');

    llm.breakNext = (content) => { content.entities[2].attributes[1].references.entity = 'Member'; };
    const callsBefore = llm.calls.length;
    expect((await owner.post(`/api/projects/${projectId}/stages/DATA_MODEL/generate`)).status).toBe(201);
    expect(llm.calls.length - callsBefore).toBe(2);
    expect(llm.calls.at(-1).messages.at(-1).content).toContain('"Member"');

    const stage = await getStage(owner, projectId, 'DATA_MODEL');
    expect(stage.content.entities[2].attributes[1].references.entity).toBe('User');
    expect(stage.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('Saneamiento de salidas degeneradas', () => {
  test('el flujo principal descarta pantallas inexistentes y repeticiones generadas por la IA', async () => {
    const owner = api(await registerAndLogin('owner8@test.com'));
    const projectId = await createProject(owner);
    await owner.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'idea' });
    await approve(owner, projectId, 'DEFINITION');
    for (const stage of ['DATA_MODEL', 'API']) {
      await owner.post(`/api/projects/${projectId}/stages/${stage}/generate`);
      await approve(owner, projectId, stage);
    }
    llm.breakNext = (content) => { content.mainFlow = ['S1', 'S1', 'S2', ...Array.from({ length: 150 }, (_, i) => `S${i + 3}`)]; };
    expect((await owner.post(`/api/projects/${projectId}/stages/FRONTEND/generate`)).status).toBe(201);
    const stage = await getStage(owner, projectId, 'FRONTEND');
    expect(stage.content.mainFlow).toEqual(['S1', 'S2']);
    expect(stage.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('Revisión final y documentos', () => {
  test('no exporta hasta aprobar todo y revisar; una contradicción reabre etapas; luego genera 2 Markdown', async () => {
    const owner = api(await registerAndLogin('owner6@test.com', 'Owner'));
    const projectId = await createProject(owner);

    const notReady = await owner.get(`/api/projects/${projectId}/export`);
    expect(notReady.status).toBe(409);
    expect(notReady.body.code).toBe('NOT_READY');

    const tooEarly = await owner.post(`/api/projects/${projectId}/review`);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.code).toBe('STAGES_NOT_APPROVED');

    await completeAllStages(owner, projectId);

    let review = await owner.get(`/api/projects/${projectId}/review`);
    expect(review.body.ready).toBe(false);
    expect(review.body.reasons).toEqual(['Falta ejecutar la revisión final con IA sobre la versión vigente.']);

    // La revisión con IA encuentra una contradicción bloqueante en la API.
    llm.reviewIssues = [{ description: 'E2 no define qué pasa si la clase está llena', stages: ['API'], blocking: true, suggestion: 'Agregar 409' }];
    const run = await owner.post(`/api/projects/${projectId}/review`);
    expect(run.status).toBe(201);
    review = await owner.get(`/api/projects/${projectId}/review`);
    expect(review.body.ready).toBe(false);
    expect(review.body.openBlocking).toHaveLength(1);
    expect(review.body.openBlocking[0].stage).toBe('API');
    expect((await owner.get(`/api/projects/${projectId}/export`)).status).toBe(409);

    // Resolverla actualiza la API: las etapas posteriores quedan desactualizadas.
    const answer = await owner.post(`/api/projects/${projectId}/questions/answers`, {
      answers: [{ questionId: review.body.openBlocking[0].id, answer: 'Responder 409 con "Clase llena"' }],
    });
    expect(answer.status).toBe(201);
    const project = await owner.get(`/api/projects/${projectId}`);
    const statuses = Object.fromEntries(project.body.stages.map((s) => [s.stage, s.status]));
    expect(statuses).toMatchObject({ DEFINITION: 'APPROVED', DATA_MODEL: 'APPROVED', API: 'DRAFT', FRONTEND: 'OUTDATED', ARCHITECTURE: 'OUTDATED' });

    for (const stage of ['API', 'FRONTEND', 'ARCHITECTURE']) {
      expect((await approve(owner, projectId, stage)).status).toBe(200);
    }
    expect((await owner.post(`/api/projects/${projectId}/review`)).status).toBe(201);
    review = await owner.get(`/api/projects/${projectId}/review`);
    expect(review.body).toMatchObject({ ready: true, reasons: [] });

    const exported = await owner.get(`/api/projects/${projectId}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body.files.map((f) => f.name)).toEqual(['producto.md', 'arquitectura.md']);
    expect(exported.body.files[0].content).toContain('Responder 409 con "Clase llena"'); // la decisión queda documentada

    const file = await owner.get(`/api/projects/${projectId}/export/arquitectura.md`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/markdown/);
    expect(file.headers['content-disposition']).toContain('arquitectura.md');

    const audit = await owner.get(`/api/projects/${projectId}/audit`);
    const actions = audit.body.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['project.created', 'stage.ai_update', 'stage.approved', 'review.run', 'questions.answered', 'export.generated']));
    expect(audit.body.entries[0].user.username).toBe('owner6@test.com');
  });
});

describe('Colaboración y permisos (validados en el backend)', () => {
  let owner;
  let editor;
  let viewer;
  let stranger;
  let projectId;
  let viewerId;

  beforeAll(async () => {
    owner = api(await registerAndLogin('perm-owner@test.com', 'Owner'));
    editor = api(await registerAndLogin('perm-editor@test.com', 'Editor'));
    viewer = api(await registerAndLogin('perm-viewer@test.com', 'Viewer'));
    stranger = api(await registerAndLogin('perm-stranger@test.com', 'Stranger'));
    projectId = await createProject(owner);
    expect((await owner.post(`/api/projects/${projectId}/members`, { email: 'perm-editor@test.com', role: 'editor' })).status).toBe(201);
    const added = await owner.post(`/api/projects/${projectId}/members`, { email: 'perm-viewer@test.com', role: 'viewer' });
    viewerId = added.body.member.id;
  });

  test('sin sesión → 401; no miembro → 404 en todas las rutas del proyecto', async () => {
    const anonymous = api();
    expect((await anonymous.get(`/api/projects/${projectId}`)).status).toBe(401);
    expect((await anonymous.get(`/api/projects/${projectId}/stages/DEFINITION`)).status).toBe(401);
    for (const path of ['', '/stages/DEFINITION', '/members', '/review', '/export', '/audit', '/stages/DEFINITION/versions']) {
      expect((await stranger.get(`/api/projects/${projectId}${path}`)).status).toBe(404);
    }
    expect((await stranger.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'x' })).status).toBe(404);
  });

  test('el lector ve todo pero no puede modificar (403)', async () => {
    expect((await viewer.get(`/api/projects/${projectId}/stages/DEFINITION`)).status).toBe(200);
    const write = await viewer.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'x' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('FORBIDDEN');
    expect((await viewer.put(`/api/projects/${projectId}/stages/DEFINITION/content`, { content: {}, version: 0 })).status).toBe(403);
    expect((await viewer.post(`/api/projects/${projectId}/stages/DEFINITION/approve`)).status).toBe(403);
    expect((await viewer.post(`/api/projects/${projectId}/review`)).status).toBe(403);
    expect((await viewer.patch(`/api/projects/${projectId}`, { name: 'Otro' })).status).toBe(403);
  });

  test('el editor colabora y su aporte queda trazado; no puede gestionar miembros', async () => {
    const res = await editor.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'Agrego reglas' });
    expect(res.status).toBe(201);
    const stage = await getStage(owner, projectId, 'DEFINITION');
    expect(stage.updatedBy.username).toBe('perm-editor@test.com');
    expect((await editor.post(`/api/projects/${projectId}/members`, { email: 'perm-stranger@test.com', role: 'viewer' })).status).toBe(403);
    expect((await editor.delete(`/api/projects/${projectId}`)).status).toBe(403);
  });

  test('el owner cambia roles y quita miembros; no puede tocarse a sí mismo', async () => {
    const members = await viewer.get(`/api/projects/${projectId}/members`);
    expect(members.body.members.map((m) => m.role)).toEqual(['owner', 'editor', 'viewer']);
    const ownerId = members.body.members[0].id;

    expect((await owner.patch(`/api/projects/${projectId}/members/${viewerId}`, { role: 'owner' })).status).toBe(400);
    expect((await owner.patch(`/api/projects/${projectId}/members/${ownerId}`, { role: 'viewer' })).status).toBe(409);
    expect((await owner.patch(`/api/projects/${projectId}/members/${viewerId}`, { role: 'editor' })).status).toBe(200);
    expect((await viewer.post(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'ahora puedo' })).status).toBe(201);

    expect((await owner.delete(`/api/projects/${projectId}/members/${viewerId}`)).status).toBe(204);
    expect((await viewer.get(`/api/projects/${projectId}`)).status).toBe(404);
    expect((await owner.delete(`/api/projects/${projectId}/members/${viewerId}`)).status).toBe(404);
  });

  test('el owner puede renombrar y eliminar el proyecto', async () => {
    const renamed = await editor.patch(`/api/projects/${projectId}`, { name: 'GymBook v2' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project.name).toBe('GymBook v2');
    expect((await owner.patch(`/api/projects/${projectId}`, { name: '' })).status).toBe(400);
    expect((await owner.delete(`/api/projects/${projectId}`)).status).toBe(204);
    expect((await owner.get(`/api/projects/${projectId}`)).status).toBe(404);
  });
});

describe('Trabajos de IA en segundo plano', () => {
  test('responde 202 con el trabajo, impide uno simultáneo (409) y se consulta hasta terminar', async () => {
    const owner = api(await registerAndLogin('owner9@test.com'));
    const projectId = await createProject(owner);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = llm.completeJson;
    llm.completeJson = async (args) => { await gate; return original(args); };

    const started = await owner.postAsync(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'idea' });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ kind: 'turn', stage: 'DEFINITION', status: 'running' });
    const jobId = started.body.job.id;

    const busy = await owner.postAsync(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'otra' });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: 'JOB_IN_PROGRESS', jobId });
    expect((await owner.get(`/api/projects/${projectId}`)).body.activeJob.id).toBe(jobId);

    release();
    let job;
    for (let i = 0; i < 50; i += 1) {
      job = (await owner.get(`/api/projects/${projectId}/jobs/${jobId}`)).body.job;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(job.status).toBe('succeeded');
    expect(job.result).toMatchObject({ reply: 'Actualicé DEFINITION', version: 1 });
    expect((await owner.get(`/api/projects/${projectId}`)).body.activeJob).toBeNull();
  });

  test('un trabajo fallido guarda el error y las validaciones previas responden de inmediato', async () => {
    const owner = api(await registerAndLogin('owner10@test.com'));
    const projectId = await createProject(owner);
    const early = await owner.postAsync(`/api/projects/${projectId}/stages/API/generate`);
    expect(early.status).toBe(409); // etapa anterior sin aprobar: no se crea trabajo
    expect(early.body.code).toBe('PREVIOUS_STAGE_NOT_APPROVED');

    llm.fail = true;
    const started = await owner.postAsync(`/api/projects/${projectId}/stages/DEFINITION/messages`, { message: 'idea' });
    expect(started.status).toBe(202);
    let job;
    for (let i = 0; i < 50; i += 1) {
      job = (await owner.get(`/api/projects/${projectId}/jobs/${started.body.job.id}`)).body.job;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ status: 502, code: 'LLM_ERROR' });
  });
});

describe('Operación', () => {
  test('GET /health verifica la base de datos y /metrics expone contadores', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', db: 'ok' });
    const metrics = await request(app).get('/metrics');
    expect(metrics.body.requests).toBeGreaterThan(0);
    expect(health.headers['x-request-id']).toBeDefined();
  });

  test('CORS solo acepta el origen configurado', async () => {
    const allowed = await request(app).get('/health').set('Origin', 'http://localhost:3001');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('el registro exige contraseña de al menos 6 caracteres', async () => {
    const res = await request(app).post('/api/register').send({ username: 'corta@test.com', name: 'X', password: '123' });
    expect(res.status).toBe(400);
  });
});
