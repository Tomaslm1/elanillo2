// Motor de etapas: conversación con el LLM, ediciones manuales, aprobación, revisión y readiness para exportar.
const { getPrisma } = require('../db');
const { HttpError } = require('../http');
const { completeJson } = require('../llm');
const { STAGES, CONTENT_STAGES, STAGE_LABELS, STAGE_SCHEMAS, turnSchema, reviewSchema, validate } = require('./schemas');
const { COMMON, STAGE_PROMPTS, REVIEW_PROMPT } = require('./prompts');
const { checkConsistency } = require('./consistency');

const HISTORY_LIMIT = 24;
const MAX_NEW_QUESTIONS = 8;

const stageIndex = (stage) => STAGES.indexOf(stage);
const previousStage = (stage) => STAGES[stageIndex(stage) - 1];
const nextStage = (stage) => STAGES[stageIndex(stage) + 1];

async function audit(tx, projectId, userId, action, details = {}) {
  await tx.auditLog.create({ data: { projectId, userId, action, details } });
}

async function createStages(tx, projectId) {
  await tx.projectStage.createMany({
    data: STAGES.map((stage) => ({ projectId, stage, status: stage === 'DEFINITION' ? 'DRAFT' : 'NOT_STARTED' })),
  });
}

async function getStages(projectId) {
  const rows = await getPrisma().projectStage.findMany({ where: { projectId } });
  return Object.fromEntries(rows.map((row) => [row.stage, row]));
}

function contentsOf(stages) {
  return Object.fromEntries(CONTENT_STAGES.map((stage) => [stage, stages[stage]?.content ?? null]));
}

function assertPreviousApproved(stages, stage) {
  const prev = previousStage(stage);
  if (prev && stages[prev]?.status !== 'APPROVED') {
    throw new HttpError(409, `Primero hay que aprobar la etapa "${STAGE_LABELS[prev]}".`, { code: 'PREVIOUS_STAGE_NOT_APPROVED' });
  }
}

function assertContentStage(stage) {
  if (!CONTENT_STAGES.includes(stage)) throw new HttpError(400, 'Esta etapa no tiene contenido editable', { code: 'INVALID_STAGE' });
}

// Cuando cambia una etapa, las posteriores que ya estaban aprobadas quedan desactualizadas.
async function markLaterStagesOutdated(tx, projectId, stage) {
  const later = STAGES.slice(stageIndex(stage) + 1);
  await tx.projectStage.updateMany({
    where: { projectId, stage: { in: later }, status: 'APPROVED' },
    data: { status: 'OUTDATED' },
  });
  await tx.project.update({ where: { id: projectId }, data: { currentStage: stage } });
}

// Guarda un nuevo contenido con bloqueo optimista: falla con 409 si alguien cambió la etapa desde `expectedVersion`.
async function writeContent(tx, { projectStage, expectedVersion, content, userId, source, note }) {
  const newVersion = expectedVersion + 1;
  const { count } = await tx.projectStage.updateMany({
    where: { id: projectStage.id, version: expectedVersion },
    data: { content, version: newVersion, status: 'DRAFT', updatedById: userId, approvedById: null, approvedAt: null },
  });
  if (count === 0) {
    throw new HttpError(409, 'Otro integrante modificó esta etapa. Recarga para ver la versión vigente y vuelve a intentar.', {
      code: 'VERSION_CONFLICT',
    });
  }
  await tx.stageVersion.create({
    data: { projectStageId: projectStage.id, version: newVersion, content, source, note, createdById: userId },
  });
  await markLaterStagesOutdated(tx, projectStage.projectId, projectStage.stage);
  return newVersion;
}

// ---------- Contexto para el LLM ----------
async function buildContextMessage(project, stage, stages) {
  const prisma = getPrisma();
  const [answered, open] = await Promise.all([
    prisma.question.findMany({
      where: { projectId: project.id, status: { in: ['ANSWERED', 'DISMISSED'] } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.question.findMany({ where: { projectId: project.id, stage, status: 'OPEN' }, orderBy: { createdAt: 'asc' } }),
  ]);

  const parts = [
    `PROYECTO: ${project.name}${project.description ? ` — ${project.description}` : ''}`,
    `ETAPA ACTUAL: ${STAGE_LABELS[stage]}`,
  ];
  STAGES.slice(0, stageIndex(stage)).forEach((prev) => {
    if (stages[prev]?.content && CONTENT_STAGES.includes(prev)) {
      parts.push(`ETAPA APROBADA "${STAGE_LABELS[prev]}" (referencia obligatoria):\n${JSON.stringify(stages[prev].content)}`);
    }
  });
  if (answered.length) {
    parts.push(`DECISIONES YA TOMADAS (preguntas respondidas):\n${answered
      .map((q) => `- [${STAGE_LABELS[q.stage]}] ${q.text} → ${q.status === 'DISMISSED' ? `(descartada) ${q.answer || ''}` : q.answer}`)
      .join('\n')}`);
  }
  parts.push(open.length
    ? `PREGUNTAS ABIERTAS DE ESTA ETAPA:\n${open.map((q) => `- id=${q.id} ${q.blocking ? '[BLOQUEANTE]' : '[no bloqueante]'} ${q.text}`).join('\n')}`
    : 'PREGUNTAS ABIERTAS DE ESTA ETAPA: ninguna');
  const findings = checkConsistency(contentsOf(stages)).filter((f) => f.stage === stage);
  if (findings.length) {
    parts.push(`INCONSISTENCIAS DETECTADAS POR EL VALIDADOR EN ESTA ETAPA (corrígelas en "content" aunque el usuario no lo pida):\n${summarizeFindings(findings)}`);
  }
  parts.push(stages[stage]?.content
    ? `CONTENIDO ACTUAL DE ESTA ETAPA (versión ${stages[stage].version}):\n${JSON.stringify(stages[stage].content)}`
    : 'CONTENIDO ACTUAL DE ESTA ETAPA: vacío (genera la propuesta inicial).');
  return parts.join('\n\n');
}

async function conversation(projectId, stage) {
  const messages = await getPrisma().message.findMany({
    where: { projectId, stage },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_LIMIT,
  });
  return messages.reverse().map((m) => ({ role: m.role === 'USER' ? 'user' : 'assistant', content: m.content }));
}

// Corrige degeneraciones obvias del LLM (p. ej. listas que siguen "S11, S12, … S200" sin pantallas reales).
function sanitizeContent(stage, content) {
  if (stage === 'FRONTEND' && content?.screens) {
    const ids = new Set(content.screens.map((s) => String(s.id)));
    const flow = (content.mainFlow || []).filter((id) => ids.has(String(id)));
    content.mainFlow = flow.filter((id, i) => i === 0 || id !== flow[i - 1]);
  }
  return content;
}

const summarizeFindings = (findings, max = 25) => {
  const lines = findings.slice(0, max).map((f) => `- [${f.severity}] ${f.message}`);
  if (findings.length > max) lines.push(`- (y ${findings.length - max} más del mismo tipo)`);
  return lines.join('\n');
};

// Validaciones rápidas previas a un turno (se responden de inmediato, antes de lanzar el trabajo en segundo plano).
async function precheckTurn(projectId, stage) {
  assertContentStage(stage);
  assertPreviousApproved(await getStages(projectId), stage);
}

// ---------- Turno de conversación ----------
/**
 * Registra el mensaje del usuario, pide al LLM la versión actualizada de la etapa y la guarda.
 * @returns {Promise<{reply: string, version: number, newQuestions: number}>}
 */
async function runTurn({ project, stage, user, message }) {
  assertContentStage(stage);
  const prisma = getPrisma();
  const stages = await getStages(project.id);
  assertPreviousApproved(stages, stage);
  const projectStage = stages[stage];
  const expectedVersion = projectStage.version;

  await prisma.message.create({ data: { projectId: project.id, stage, role: 'USER', content: message, authorId: user.id } });

  const context = await buildContextMessage(project, stage, stages);
  const history = await conversation(project.id, stage);
  const llmArgs = {
    system: `${COMMON}\n\n${STAGE_PROMPTS[stage]}`,
    messages: [{ role: 'user', content: context }, { role: 'assistant', content: 'Entendido. Tengo el contexto.' }, ...history],
    schema: turnSchema(stage),
    name: `ideator_${stage.toLowerCase()}_turn`,
  };
  let result = await completeJson(llmArgs);
  if (result?.content) sanitizeContent(stage, result.content);

  // Autocorrección: si la propuesta rompe la consistencia, se pide UNA corrección antes de guardarla.
  const inconsistencies = (candidate) => (validate(STAGE_SCHEMAS[stage], candidate?.content).length ? [] : checkConsistency({ ...contentsOf(stages), [stage]: candidate.content })
    .filter((f) => f.stage === stage && f.severity === 'error'));
  const found = inconsistencies(result);
  if (found.length) {
    const repaired = await completeJson({
      ...llmArgs,
      messages: [...llmArgs.messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `El validador encontró estas inconsistencias en tu propuesta. Devuelve la respuesta completa corregida (mismas preguntas nuevas):\n${summarizeFindings(found)}` }],
    });
    if (repaired?.content) sanitizeContent(stage, repaired.content);
    if (inconsistencies(repaired).length < found.length) result = repaired;
  }

  const errors = validate(STAGE_SCHEMAS[stage], result?.content);
  if (errors.length) {
    throw new HttpError(502, 'El asistente devolvió una respuesta con formato inválido. Intenta de nuevo.', { code: 'LLM_BAD_OUTPUT', details: errors.slice(0, 5) });
  }

  const openIds = new Set((await prisma.question.findMany({
    where: { projectId: project.id, stage, status: 'OPEN' },
    select: { id: true },
  })).map((q) => q.id));
  const resolved = (result.resolvedQuestionIds || []).filter((id) => openIds.has(id));
  const newQuestions = (result.newQuestions || []).slice(0, MAX_NEW_QUESTIONS);

  const version = await prisma.$transaction(async (tx) => {
    const v = await writeContent(tx, { projectStage, expectedVersion, content: result.content, userId: user.id, source: 'ai', note: message.slice(0, 200) });
    await tx.message.create({ data: { projectId: project.id, stage, role: 'ASSISTANT', content: result.reply } });
    if (resolved.length) {
      await tx.question.updateMany({
        where: { id: { in: resolved }, status: 'OPEN' },
        data: { status: 'ANSWERED', answer: `Resuelta en la conversación: "${message.slice(0, 300)}"`, answeredById: user.id, answeredAt: new Date() },
      });
    }
    if (newQuestions.length) {
      await tx.question.createMany({
        data: newQuestions.map((q) => ({ projectId: project.id, stage, text: q.text, reason: q.reason, options: (q.options || []).slice(0, 6), blocking: q.blocking, source: 'ai' })),
      });
    }
    await audit(tx, project.id, user.id, 'stage.ai_update', { stage, version: v, newQuestions: newQuestions.length, resolved: resolved.length });
    return v;
  }, { timeout: 15000 });

  return { reply: result.reply, version, newQuestions: newQuestions.length };
}

async function generateProposal({ project, stage, user }) {
  return runTurn({
    project,
    stage,
    user,
    message: `Genera la propuesta de la etapa "${STAGE_LABELS[stage]}" a partir de las etapas aprobadas y las decisiones tomadas.`,
  });
}

// Responde (o descarta) varias preguntas a la vez y luego pide a la IA que incorpore las decisiones.
// Registra respuestas (o descartes) de varias preguntas de una misma etapa. Devuelve el mensaje con el que
// la IA debe incorporar las decisiones (null si la etapa no tiene contenido propio).
async function recordAnswers({ project, user, answers }) {
  const prisma = getPrisma();
  if (!Array.isArray(answers) || !answers.length) throw new HttpError(400, 'Envía al menos una respuesta', { code: 'NO_ANSWERS' });

  const ids = answers.map((a) => String(a.questionId || ''));
  const questions = await prisma.question.findMany({ where: { id: { in: ids }, projectId: project.id } });
  if (questions.length !== new Set(ids).size) throw new HttpError(404, 'Alguna pregunta no existe en este proyecto', { code: 'QUESTION_NOT_FOUND' });
  const stagesTouched = new Set(questions.map((q) => q.stage));
  if (stagesTouched.size > 1) throw new HttpError(400, 'Responde preguntas de una sola etapa a la vez', { code: 'MIXED_STAGES' });
  const [stage] = [...stagesTouched];
  if (CONTENT_STAGES.includes(stage)) await precheckTurn(project.id, stage);

  const byId = new Map(questions.map((q) => [q.id, q]));
  const lines = [];
  for (const entry of answers) {
    const question = byId.get(String(entry.questionId));
    const answer = String(entry.answer || '').trim();
    const dismiss = Boolean(entry.dismiss);
    if (question.status !== 'OPEN') throw new HttpError(409, `La pregunta "${question.text.slice(0, 60)}" ya fue respondida`, { code: 'QUESTION_CLOSED' });
    if (!answer) throw new HttpError(400, 'Cada respuesta debe tener texto (o el motivo para descartarla)', { code: 'EMPTY_ANSWER' });
    lines.push(`- Pregunta: ${question.text}\n  ${dismiss ? 'Descartada por el equipo. Motivo' : 'Respuesta'}: ${answer}`);
  }

  await prisma.$transaction(async (tx) => {
    for (const entry of answers) {
      const { count } = await tx.question.updateMany({
        where: { id: String(entry.questionId), status: 'OPEN' },
        data: {
          status: entry.dismiss ? 'DISMISSED' : 'ANSWERED',
          answer: String(entry.answer).trim(),
          answeredById: user.id,
          answeredAt: new Date(),
        },
      });
      if (count === 0) throw new HttpError(409, 'Otro integrante respondió esta pregunta al mismo tiempo', { code: 'QUESTION_CLOSED' });
    }
    await audit(tx, project.id, user.id, 'questions.answered', { stage, count: answers.length });
  });

  return { stage, message: CONTENT_STAGES.includes(stage) ? `Respuestas a preguntas pendientes:\n${lines.join('\n')}` : null };
}

// ---------- Edición manual ----------
async function saveManualContent({ project, stage, user, content, version, note }) {
  assertContentStage(stage);
  const errors = validate(STAGE_SCHEMAS[stage], content);
  if (errors.length) throw new HttpError(422, 'El contenido no tiene el formato esperado', { code: 'INVALID_CONTENT', details: errors.slice(0, 20) });
  if (!Number.isInteger(version)) throw new HttpError(400, 'Falta "version" (la versión que estabas editando)', { code: 'VERSION_REQUIRED' });

  const prisma = getPrisma();
  const stages = await getStages(project.id);
  assertPreviousApproved(stages, stage);
  const projectStage = stages[stage];

  return prisma.$transaction(async (tx) => {
    const v = await writeContent(tx, { projectStage, expectedVersion: version, content, userId: user.id, source: 'manual', note: String(note || '').slice(0, 200) });
    await audit(tx, project.id, user.id, 'stage.manual_edit', { stage, version: v, note: note || '' });
    return v;
  });
}

// ---------- Aprobación ----------
async function approveStage({ project, stage, user, version }) {
  assertContentStage(stage);
  const prisma = getPrisma();
  const stages = await getStages(project.id);
  assertPreviousApproved(stages, stage);
  const projectStage = stages[stage];

  if (!projectStage.content) throw new HttpError(409, 'La etapa todavía no tiene contenido', { code: 'EMPTY_STAGE' });
  if (Number.isInteger(version) && version !== projectStage.version) {
    throw new HttpError(409, 'La etapa cambió desde que la revisaste. Recarga antes de aprobar.', { code: 'VERSION_CONFLICT' });
  }
  if (projectStage.status === 'APPROVED') return { version: projectStage.version, status: 'APPROVED' };

  const blocking = await prisma.question.count({ where: { projectId: project.id, stage, status: 'OPEN', blocking: true } });
  if (blocking) {
    throw new HttpError(409, `Hay ${blocking} pregunta(s) bloqueante(s) sin resolver en esta etapa.`, { code: 'BLOCKING_QUESTIONS', count: blocking });
  }
  const errors = checkConsistency(contentsOf(stages)).filter((f) => f.stage === stage && f.severity === 'error');
  if (errors.length) {
    throw new HttpError(422, 'La etapa tiene inconsistencias que deben corregirse antes de aprobar.', { code: 'CONSISTENCY_ERRORS', findings: errors });
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.projectStage.updateMany({
      where: { id: projectStage.id, version: projectStage.version },
      data: { status: 'APPROVED', approvedById: user.id, approvedAt: new Date() },
    });
    if (count === 0) throw new HttpError(409, 'La etapa cambió mientras se aprobaba. Recarga.', { code: 'VERSION_CONFLICT' });
    const next = nextStage(stage);
    await tx.project.update({ where: { id: project.id }, data: { currentStage: next } });
    if (next && stages[next].status === 'NOT_STARTED') {
      await tx.projectStage.update({ where: { id: stages[next].id }, data: { status: 'DRAFT' } });
    }
    await audit(tx, project.id, user.id, 'stage.approved', { stage, version: projectStage.version });
  });
  return { version: projectStage.version, status: 'APPROVED' };
}

// ---------- Revisión consolidada ----------
async function readiness(projectId) {
  const prisma = getPrisma();
  const stages = await getStages(projectId);
  const findings = checkConsistency(contentsOf(stages));
  const openBlocking = await prisma.question.findMany({
    where: { projectId, status: 'OPEN', blocking: true },
    orderBy: { createdAt: 'asc' },
  });
  const notApproved = CONTENT_STAGES.filter((stage) => stages[stage]?.status !== 'APPROVED');
  const review = stages.REVIEW;
  const lastContentChange = Math.max(...CONTENT_STAGES.map((s) => stages[s]?.updatedAt?.getTime() || 0));
  const reviewRanAt = review?.content?.ranAt ? new Date(review.content.ranAt).getTime() : 0;
  const reviewUpToDate = reviewRanAt > 0 && reviewRanAt >= lastContentChange;

  const reasons = [];
  notApproved.forEach((stage) => reasons.push(`La etapa "${STAGE_LABELS[stage]}" no está aprobada.`));
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  if (errorCount) reasons.push(`Hay ${errorCount} inconsistencia(s) entre etapas.`);
  if (openBlocking.length) reasons.push(`Hay ${openBlocking.length} pregunta(s) bloqueante(s) sin resolver.`);
  if (!reviewUpToDate) reasons.push('Falta ejecutar la revisión final con IA sobre la versión vigente.');

  return {
    ready: reasons.length === 0,
    reasons,
    findings,
    openBlocking,
    review: review?.content || null,
    reviewUpToDate,
    stages: Object.fromEntries(STAGES.map((s) => [s, { status: stages[s]?.status, version: stages[s]?.version }])),
  };
}

async function precheckReview(projectId) {
  const stages = await getStages(projectId);
  const notApproved = CONTENT_STAGES.filter((stage) => stages[stage]?.status !== 'APPROVED');
  if (notApproved.length) {
    throw new HttpError(409, 'Aprueba todas las etapas antes de la revisión final.', { code: 'STAGES_NOT_APPROVED', stages: notApproved });
  }
  return stages;
}

async function runReview({ project, user }) {
  const prisma = getPrisma();
  const stages = await precheckReview(project.id);
  const answered = await prisma.question.findMany({ where: { projectId: project.id, status: { in: ['ANSWERED', 'DISMISSED'] } } });
  const spec = CONTENT_STAGES.map((stage) => `## ${STAGE_LABELS[stage]}\n${JSON.stringify(stages[stage].content)}`).join('\n\n');
  const decisions = answered.map((q) => `- ${q.text} → ${q.answer}`).join('\n');

  const result = await completeJson({
    system: REVIEW_PROMPT,
    messages: [{ role: 'user', content: `PROYECTO: ${project.name}\n\nDECISIONES:\n${decisions || '(ninguna)'}\n\nESPECIFICACIÓN:\n${spec}` }],
    schema: reviewSchema,
    name: 'ideator_review',
  });
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const ranAt = new Date(Date.now() + 1); // estrictamente posterior a los cambios previos

  await prisma.$transaction(async (tx) => {
    // Las observaciones abiertas de una revisión anterior quedan reemplazadas por las nuevas.
    await tx.question.updateMany({
      where: { projectId: project.id, source: 'review', status: 'OPEN' },
      data: { status: 'DISMISSED', answer: 'Reemplazada por una revisión más reciente' },
    });
    if (issues.length) {
      await tx.question.createMany({
        data: issues.map((issue) => ({
          projectId: project.id,
          stage: issue.stages?.[0] || 'DEFINITION',
          text: issue.description,
          reason: `Sugerencia: ${issue.suggestion}${issue.stages?.length > 1 ? ` (afecta: ${issue.stages.map((s) => STAGE_LABELS[s]).join(', ')})` : ''}`,
          blocking: issue.blocking,
          source: 'review',
        })),
      });
    }
    await tx.projectStage.update({
      where: { id: stages.REVIEW.id },
      data: {
        content: { ranAt: ranAt.toISOString(), summary: result.summary || '', issues: issues.length, blocking: issues.filter((i) => i.blocking).length },
        version: { increment: 1 },
        status: 'DRAFT',
        updatedById: user.id,
      },
    });
    await audit(tx, project.id, user.id, 'review.run', { issues: issues.length });
  });

  return { summary: result.summary, issues };
}

module.exports = {
  createStages,
  getStages,
  contentsOf,
  runTurn,
  generateProposal,
  recordAnswers,
  precheckTurn,
  precheckReview,
  saveManualContent,
  approveStage,
  readiness,
  runReview,
  stageIndex,
};
