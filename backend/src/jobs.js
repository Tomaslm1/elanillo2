// Trabajos de IA en segundo plano. Un turno con el LLM puede tardar minutos: la API responde 202 con el
// trabajo y el frontend consulta GET /api/projects/:id/jobs/:jobId hasta que termine.
// Con ?wait=true (scripts y tests) se espera el resultado y se responde como una llamada síncrona.
const { getPrisma } = require('./db');
const { HttpError } = require('./http');
const { logger } = require('./logger');

const inFlight = new Map(); // jobId -> promesa (para ?wait=true)

function serializeJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    stage: job.stage,
    status: job.status,
    result: job.result ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

function errorPayload(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message, ...err.extra };
  return { status: 500, message: 'Error interno del servidor' };
}

/**
 * Crea un trabajo y ejecuta `run` en segundo plano.
 * Falla con 409 si ya hay un trabajo en curso en el proyecto (garantizado por un índice único parcial).
 */
async function startJob({ project, user, stage = null, kind, run }) {
  const prisma = getPrisma();
  let job;
  try {
    job = await prisma.aiJob.create({ data: { projectId: project.id, stage, kind, createdById: user.id } });
  } catch (err) {
    if (err.code === 'P2002') {
      const active = await prisma.aiJob.findFirst({ where: { projectId: project.id, status: 'running' } });
      throw new HttpError(409, 'La IA ya está trabajando en este proyecto. Espera a que termine.', { code: 'JOB_IN_PROGRESS', jobId: active?.id });
    }
    throw err;
  }

  const promise = (async () => {
    try {
      const result = await run();
      await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'succeeded', result: result ?? {}, finishedAt: new Date() } });
    } catch (err) {
      if (!(err instanceof HttpError)) logger.error('job_error', { jobId: job.id, kind, error: err.message, stack: err.stack });
      await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'failed', error: errorPayload(err), finishedAt: new Date() } })
        .catch((updateErr) => logger.error('job_update_error', { jobId: job.id, error: updateErr.message }));
    } finally {
      inFlight.delete(job.id);
    }
  })();
  inFlight.set(job.id, promise);
  return { job, promise };
}

// Responde 202 con el trabajo, o espera el resultado si la request trae ?wait=true.
async function respondWithJob(req, res, args) {
  const { job, promise } = await startJob(args);
  if (req.query.wait !== 'true') return res.status(202).json({ job: serializeJob(job) });

  await promise;
  const done = await getPrisma().aiJob.findUnique({ where: { id: job.id } });
  if (done.status === 'failed') {
    const { status, message, ...extra } = done.error || {};
    return res.status(status || 500).json({ error: message, ...extra, jobId: done.id });
  }
  return res.status(201).json({ ...(done.result || {}), job: serializeJob(done) });
}

// Al arrancar, los trabajos que quedaron "running" de un proceso anterior ya no van a terminar.
async function failStaleJobs() {
  const { count } = await getPrisma().aiJob.updateMany({
    where: { status: 'running' },
    data: { status: 'failed', error: { status: 503, message: 'El servidor se reinició mientras la IA trabajaba. Intenta de nuevo.' }, finishedAt: new Date() },
  });
  if (count) logger.warn('stale_jobs_failed', { count });
}

module.exports = { startJob, respondWithJob, serializeJob, failStaleJobs };
