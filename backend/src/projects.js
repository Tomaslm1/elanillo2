// Rutas de proyectos. Toda ruta valida en el backend que el usuario autenticado sea miembro
// del proyecto y tenga el rol suficiente; la privacidad nunca depende de la interfaz.
//   404 -> el proyecto no existe o el usuario no es miembro (no se revela que existe)
//   403 -> es miembro pero su rol no alcanza
const express = require('express');
const { getPrisma } = require('./db');
const { HttpError, asyncHandler } = require('./http');
const { requireAuth, serializeUser, normalizeEmail } = require('./auth');
const engine = require('./stages/engine');
const { STAGES, CONTENT_STAGES, STAGE_LABELS } = require('./stages/schemas');
const { checkConsistency } = require('./stages/consistency');
const { erDiagram, navigationDiagram } = require('./stages/diagrams');
const { buildExports } = require('./stages/markdown');
const { ARCHITECTURES } = require('./stages/architectures');
const { respondWithJob, serializeJob } = require('./jobs');

const router = express.Router();
router.use(requireAuth);

const PROJECT_NAME_MAX = 80;
const PROJECT_DESCRIPTION_MAX = 300;
const MESSAGE_MAX = 8000;
const INVITABLE_ROLES = ['editor', 'viewer'];
const ROLE_RANK = { VIEWER: 1, EDITOR: 2, OWNER: 3 };
const toApiRole = (role) => role.toLowerCase();
const toDbRole = (role) => role.toUpperCase();

function serializeProject(project, role) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    role: toApiRole(role),
    memberCount: project._count?.members ?? project.members?.length ?? 0,
    currentStage: project.currentStage,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

const userSummary = (user) => (user ? { id: user.id, name: user.name, username: user.email } : null);

// Carga el proyecto verificando membresía y rol mínimo. Deja req.project y req.membership.
function projectAccess(minRole) {
  return asyncHandler(async (req, res, next) => {
    const membership = await getPrisma().projectMember.findUnique({
      where: { projectId_userId: { projectId: String(req.params.projectId), userId: req.user.id } },
      include: { project: true },
    });
    if (!membership) return res.status(404).json({ error: 'Proyecto no encontrado' });
    if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      const messages = {
        OWNER: 'Solo el propietario puede realizar esta acción',
        EDITOR: 'Tu rol en este proyecto es de solo lectura',
      };
      return res.status(403).json({ error: messages[minRole], code: 'FORBIDDEN' });
    }
    req.project = membership.project;
    req.membership = membership;
    return next();
  });
}

function parseStage(req) {
  const stage = String(req.params.stage || '').toUpperCase();
  if (!STAGES.includes(stage)) throw new HttpError(404, 'Etapa no encontrada', { code: 'STAGE_NOT_FOUND' });
  return stage;
}

// ---------- Proyectos ----------
router.get('/', asyncHandler(async (req, res) => {
  const memberships = await getPrisma().projectMember.findMany({
    where: { userId: req.user.id },
    include: { project: { include: { _count: { select: { members: true } } } } },
    orderBy: { project: { createdAt: 'desc' } },
  });
  return res.json({ projects: memberships.map((m) => serializeProject(m.project, m.role)) });
}));

function validateProjectFields(body, { partial = false } = {}) {
  const name = body?.name === undefined && partial ? undefined : String(body?.name || '').trim();
  const description = body?.description === undefined ? undefined : String(body.description || '').trim();
  if (name !== undefined) {
    if (!name) throw new HttpError(400, 'El nombre del proyecto es obligatorio');
    if (name.length > PROJECT_NAME_MAX) throw new HttpError(400, `El nombre no puede superar ${PROJECT_NAME_MAX} caracteres`);
  }
  if (description !== undefined && description.length > PROJECT_DESCRIPTION_MAX) {
    throw new HttpError(400, `La descripción no puede superar ${PROJECT_DESCRIPTION_MAX} caracteres`);
  }
  return { name, description };
}

router.post('/', asyncHandler(async (req, res) => {
  const { name, description } = validateProjectFields(req.body);
  const prisma = getPrisma();
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        name,
        description: description || '',
        createdById: req.user.id,
        members: { create: { userId: req.user.id, role: 'OWNER' } },
      },
      include: { _count: { select: { members: true } } },
    });
    await engine.createStages(tx, created.id);
    await tx.auditLog.create({ data: { projectId: created.id, userId: req.user.id, action: 'project.created', details: { name } } });
    return created;
  });
  return res.status(201).json({ project: serializeProject(project, 'OWNER') });
}));

router.get('/:projectId', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const [project, stages, members, openQuestions, activeJob] = await Promise.all([
    prisma.project.findUnique({ where: { id: req.project.id }, include: { createdBy: true, _count: { select: { members: true } } } }),
    engine.getStages(req.project.id),
    prisma.projectMember.findMany({ where: { projectId: req.project.id }, include: { user: true }, orderBy: { createdAt: 'asc' } }),
    prisma.question.groupBy({ by: ['stage', 'blocking'], where: { projectId: req.project.id, status: 'OPEN' }, _count: true }),
    prisma.aiJob.findFirst({ where: { projectId: req.project.id, status: 'running' } }),
  ]);
  const countFor = (stage, blocking) => openQuestions.find((q) => q.stage === stage && q.blocking === blocking)?._count || 0;
  return res.json({
    project: {
      ...serializeProject(project, req.membership.role),
      createdBy: userSummary(project.createdBy),
    },
    stages: STAGES.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      status: stages[stage]?.status,
      version: stages[stage]?.version,
      updatedAt: stages[stage]?.updatedAt,
      openBlocking: countFor(stage, true),
      openNonBlocking: countFor(stage, false),
    })),
    members: members.map((m) => ({ ...serializeUser(m.user), role: toApiRole(m.role), joinedAt: m.createdAt })),
    activeJob: activeJob ? serializeJob(activeJob) : null,
  });
}));

router.patch('/:projectId', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  const { name, description } = validateProjectFields(req.body, { partial: true });
  const data = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  const prisma = getPrisma();
  const project = await prisma.project.update({ where: { id: req.project.id }, data, include: { _count: { select: { members: true } } } });
  await prisma.auditLog.create({ data: { projectId: project.id, userId: req.user.id, action: 'project.updated', details: data } });
  return res.json({ project: serializeProject(project, req.membership.role) });
}));

router.delete('/:projectId', projectAccess('OWNER'), asyncHandler(async (req, res) => {
  await getPrisma().project.delete({ where: { id: req.project.id } });
  return res.status(204).end();
}));

// ---------- Miembros ----------
router.get('/:projectId/members', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const members = await getPrisma().projectMember.findMany({
    where: { projectId: req.project.id },
    include: { user: true, invitedBy: true },
    orderBy: { createdAt: 'asc' },
  });
  return res.json({
    members: members.map((m) => ({ ...serializeUser(m.user), role: toApiRole(m.role), joinedAt: m.createdAt, invitedBy: userSummary(m.invitedBy) })),
  });
}));

// Invitar colaborador: body { email, role }. Solo el owner.
//   400 datos inválidos · 404 el correo no pertenece a un usuario · 409 ya es miembro
router.post('/:projectId/members', projectAccess('OWNER'), asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const role = String(req.body?.role || '').trim();
  if (!email) return res.status(400).json({ error: 'Ingresa el correo del colaborador' });
  if (!INVITABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `El rol debe ser uno de: ${INVITABLE_ROLES.join(', ')}` });
  }

  const prisma = getPrisma();
  const invitedUser = await prisma.user.findUnique({ where: { email } });
  if (!invitedUser) return res.status(404).json({ error: 'No existe un usuario registrado con ese correo' });

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: req.project.id, userId: invitedUser.id } },
  });
  if (existing) return res.status(409).json({ error: 'El usuario ya es miembro del proyecto' });

  await prisma.$transaction([
    prisma.projectMember.create({ data: { projectId: req.project.id, userId: invitedUser.id, role: toDbRole(role), invitedById: req.user.id } }),
    prisma.auditLog.create({ data: { projectId: req.project.id, userId: req.user.id, action: 'member.added', details: { email, role } } }),
  ]);
  return res.status(201).json({ message: 'Colaborador agregado', member: { ...serializeUser(invitedUser), role } });
}));

async function findOtherMember(req) {
  const membership = await getPrisma().projectMember.findUnique({
    where: { projectId_userId: { projectId: req.project.id, userId: String(req.params.userId) } },
    include: { user: true },
  });
  if (!membership) throw new HttpError(404, 'Ese usuario no es miembro del proyecto');
  if (membership.role === 'OWNER') throw new HttpError(409, 'No se puede cambiar ni quitar al propietario del proyecto', { code: 'OWNER_IMMUTABLE' });
  return membership;
}

router.patch('/:projectId/members/:userId', projectAccess('OWNER'), asyncHandler(async (req, res) => {
  const role = String(req.body?.role || '').trim();
  if (!INVITABLE_ROLES.includes(role)) return res.status(400).json({ error: `El rol debe ser uno de: ${INVITABLE_ROLES.join(', ')}` });
  const membership = await findOtherMember(req);
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.projectMember.update({
      where: { projectId_userId: { projectId: req.project.id, userId: membership.userId } },
      data: { role: toDbRole(role) },
    }),
    prisma.auditLog.create({ data: { projectId: req.project.id, userId: req.user.id, action: 'member.role_changed', details: { email: membership.user.email, from: toApiRole(membership.role), to: role } } }),
  ]);
  return res.json({ member: { ...serializeUser(membership.user), role } });
}));

router.delete('/:projectId/members/:userId', projectAccess('OWNER'), asyncHandler(async (req, res) => {
  const membership = await findOtherMember(req);
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.projectMember.delete({ where: { projectId_userId: { projectId: req.project.id, userId: membership.userId } } }),
    prisma.auditLog.create({ data: { projectId: req.project.id, userId: req.user.id, action: 'member.removed', details: { email: membership.user.email } } }),
  ]);
  return res.status(204).end();
}));

// ---------- Etapas ----------
router.get('/:projectId/stages/:stage', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const stage = parseStage(req);
  const prisma = getPrisma();
  const stages = await engine.getStages(req.project.id);
  const row = stages[stage];
  const [messages, questions, users] = await Promise.all([
    prisma.message.findMany({ where: { projectId: req.project.id, stage }, include: { author: true }, orderBy: { createdAt: 'asc' } }),
    prisma.question.findMany({
      where: stage === 'REVIEW' ? { projectId: req.project.id, source: 'review' } : { projectId: req.project.id, stage },
      include: { answeredBy: true },
      orderBy: [{ status: 'asc' }, { blocking: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.user.findMany({ where: { id: { in: [row.updatedById, row.approvedById].filter(Boolean) } } }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const contents = engine.contentsOf(stages);
  const findings = checkConsistency(contents).filter((f) => stage === 'REVIEW' || f.stage === stage);

  return res.json({
    stage,
    label: STAGE_LABELS[stage],
    status: row.status,
    version: row.version,
    content: row.content,
    updatedAt: row.updatedAt,
    updatedBy: userSummary(userById.get(row.updatedById)),
    approvedBy: userSummary(userById.get(row.approvedById)),
    approvedAt: row.approvedAt,
    previousApproved: engine.stageIndex(stage) === 0 || stages[STAGES[engine.stageIndex(stage) - 1]].status === 'APPROVED',
    messages: messages.map((m) => ({ id: m.id, role: m.role.toLowerCase(), content: m.content, author: userSummary(m.author), createdAt: m.createdAt })),
    questions: questions.map((q) => ({
      id: q.id,
      stage: q.stage,
      text: q.text,
      reason: q.reason,
      options: q.options,
      blocking: q.blocking,
      source: q.source,
      status: q.status.toLowerCase(),
      answer: q.answer,
      answeredBy: userSummary(q.answeredBy),
      answeredAt: q.answeredAt,
    })),
    findings,
    diagrams: {
      er: stage === 'DATA_MODEL' ? erDiagram(row.content) : '',
      navigation: stage === 'FRONTEND' ? navigationDiagram(row.content) : '',
    },
    architectures: stage === 'ARCHITECTURE' ? ARCHITECTURES : undefined,
  });
}));

router.post('/:projectId/stages/:stage/messages', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  const stage = parseStage(req);
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
  if (message.length > MESSAGE_MAX) return res.status(400).json({ error: `El mensaje no puede superar ${MESSAGE_MAX} caracteres` });
  await engine.precheckTurn(req.project.id, stage);
  return respondWithJob(req, res, {
    project: req.project, user: req.user, stage, kind: 'turn',
    run: () => engine.runTurn({ project: req.project, stage, user: req.user, message }),
  });
}));

router.post('/:projectId/stages/:stage/generate', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  const stage = parseStage(req);
  await engine.precheckTurn(req.project.id, stage);
  return respondWithJob(req, res, {
    project: req.project, user: req.user, stage, kind: 'generate',
    run: () => engine.generateProposal({ project: req.project, stage, user: req.user }),
  });
}));

router.put('/:projectId/stages/:stage/content', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  const stage = parseStage(req);
  const version = await engine.saveManualContent({
    project: req.project,
    stage,
    user: req.user,
    content: req.body?.content,
    version: req.body?.version,
    note: req.body?.note,
  });
  return res.json({ version });
}));

router.post('/:projectId/stages/:stage/approve', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  const stage = parseStage(req);
  const result = await engine.approveStage({ project: req.project, stage, user: req.user, version: req.body?.version });
  return res.json(result);
}));

router.get('/:projectId/stages/:stage/versions', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const stage = parseStage(req);
  const prisma = getPrisma();
  const row = await prisma.projectStage.findUnique({ where: { projectId_stage: { projectId: req.project.id, stage } } });
  const versions = await prisma.stageVersion.findMany({
    where: { projectStageId: row.id },
    include: { createdBy: true },
    orderBy: { version: 'desc' },
  });
  return res.json({
    versions: versions.map((v) => ({ version: v.version, source: v.source, note: v.note, createdBy: userSummary(v.createdBy), createdAt: v.createdAt, content: v.content })),
  });
}));

// ---------- Preguntas ----------
// body: { answers: [{ questionId, answer, dismiss? }] } — todas de la misma etapa.
// Las respuestas se registran de inmediato; la IA las incorpora en un trabajo en segundo plano.
router.post('/:projectId/questions/answers', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  const { stage, message } = await engine.recordAnswers({ project: req.project, user: req.user, answers: req.body?.answers });
  if (!message) return res.json({ stage, turn: null, job: null });
  return respondWithJob(req, res, {
    project: req.project, user: req.user, stage, kind: 'answers',
    run: async () => ({ stage, turn: await engine.runTurn({ project: req.project, stage, user: req.user, message }) }),
  });
}));

// ---------- Revisión, exportación y auditoría ----------
router.get('/:projectId/review', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const result = await engine.readiness(req.project.id);
  return res.json({
    ...result,
    openBlocking: result.openBlocking.map((q) => ({ id: q.id, stage: q.stage, text: q.text, reason: q.reason, source: q.source })),
  });
}));

router.post('/:projectId/review', projectAccess('EDITOR'), asyncHandler(async (req, res) => {
  await engine.precheckReview(req.project.id);
  return respondWithJob(req, res, {
    project: req.project, user: req.user, stage: 'REVIEW', kind: 'review',
    run: () => engine.runReview({ project: req.project, user: req.user }),
  });
}));

router.get('/:projectId/jobs/:jobId', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const job = await getPrisma().aiJob.findFirst({ where: { id: String(req.params.jobId), projectId: req.project.id } });
  if (!job) return res.status(404).json({ error: 'Trabajo no encontrado' });
  return res.json({ job: serializeJob(job) });
}));

async function buildProjectExports(project) {
  const status = await engine.readiness(project.id);
  if (!status.ready) {
    throw new HttpError(409, 'El proyecto todavía no puede generar los documentos finales.', { code: 'NOT_READY', reasons: status.reasons });
  }
  const prisma = getPrisma();
  const stages = await engine.getStages(project.id);
  const contents = engine.contentsOf(stages);
  const decisions = await prisma.question.findMany({
    where: { projectId: project.id, status: { in: ['ANSWERED', 'DISMISSED'] }, NOT: { answer: 'Reemplazada por una revisión más reciente' } },
    orderBy: { createdAt: 'asc' },
  });
  const openNonBlocking = await prisma.question.findMany({ where: { projectId: project.id, status: 'OPEN', blocking: false } });
  const openItems = [...(contents.DEFINITION.openItems || []), ...openNonBlocking.map((q) => q.text)];
  return buildExports({ project, contents, decisions, openItems });
}

router.get('/:projectId/export', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const files = await buildProjectExports(req.project);
  await getPrisma().auditLog.create({ data: { projectId: req.project.id, userId: req.user.id, action: 'export.generated', details: {} } });
  return res.json({ files });
}));

router.get('/:projectId/export/:file', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const files = await buildProjectExports(req.project);
  const file = files.find((f) => f.name === req.params.file);
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.set('Content-Type', 'text/markdown; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${file.name}"`);
  return res.send(file.content);
}));

router.get('/:projectId/audit', projectAccess('VIEWER'), asyncHandler(async (req, res) => {
  const logs = await getPrisma().auditLog.findMany({
    where: { projectId: req.project.id },
    include: { user: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return res.json({ entries: logs.map((l) => ({ id: l.id, action: l.action, details: l.details, user: userSummary(l.user), createdAt: l.createdAt })) });
}));

module.exports = { router, CONTENT_STAGES };
