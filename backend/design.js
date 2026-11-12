// Etapas de diseño del proyecto como datos estructurados (decisión de diseño de Ideator: cada etapa
// se guarda como dato, no como texto de chat), y los motores que trabajan sobre ellos:
//   SCRUM-54  GET /api-docs        documentación de respuestas y códigos de estado
//   SCRUM-60  GET /navigation-map  mapa de navegación entre pantallas
//   SCRUM-66  GET /operations      aspectos operacionales de la arquitectura
//   SCRUM-67  GET /coherence       coherencia arquitectura vs. decisiones previas
// Las entradas (especificaciones) se guardan con PUT /specs/:name. Mismo patrón de siempre: datos en
// memoria dentro del proyecto, permisos por rol y versionado optimista (409 si alguien editó antes).
const { validateApiSpec, generateApiDocs } = require('./generators/apiDocs');
const { validateNavigationSpec, generateNavigationMap } = require('./generators/navigationMap');
const { validateArchitectureSpec, generateOperations } = require('./generators/operations');
const { validateDecisionsSpec, checkCoherence } = require('./generators/coherence');

const SPECS = {
  api: { label: 'Endpoints de la API', validate: validateApiSpec },
  navigation: { label: 'Pantallas y recorrido principal', validate: validateNavigationSpec },
  architecture: { label: 'Arquitectura elegida', validate: validateArchitectureSpec },
  decisions: { label: 'Decisiones previas (base de datos, backend, frontend)', validate: validateDecisionsSpec },
};

function registerDesignRoutes(app, deps) {
  const { requireAuth, loadProjectForMember, requireEditor, parseVersion, findUserById, EDITOR_ROLES } = deps;

  const specsOf = (project) => (project.specs ||= {});
  const authorName = (userId) => {
    const user = findUserById(userId);
    return user?.name || user?.username || null;
  };
  const isKnownSpec = (name) => Object.prototype.hasOwnProperty.call(SPECS, name);

  function serializeSpec(name, stored) {
    return {
      name,
      label: SPECS[name].label,
      defined: Boolean(stored),
      data: stored ? stored.data : null,
      version: stored ? stored.version : null,
      updatedAt: stored ? stored.updatedAt : null,
      updatedByName: stored ? authorName(stored.updatedBy) : null,
    };
  }

  // ---------- Especificaciones ----------
  app.get('/api/projects/:projectId/specs', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const stored = specsOf(ctx.project);
    return res.json({
      specs: Object.keys(SPECS).map((name) => serializeSpec(name, stored[name])),
      canEdit: EDITOR_ROLES.includes(ctx.membership.role),
    });
  });

  app.get('/api/projects/:projectId/specs/:name', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const { name } = req.params;
    if (!isKnownSpec(name)) return res.status(404).json({ error: 'Esa especificación no existe' });
    return res.json({ spec: serializeSpec(name, specsOf(ctx.project)[name]), canEdit: EDITOR_ROLES.includes(ctx.membership.role) });
  });

  // Guardar: body { data, version? }. La primera vez no lleva versión; después es obligatoria
  // (la que el cliente vio). Si no coincide, 409 con el valor actual y no se guarda nada.
  app.put('/api/projects/:projectId/specs/:name', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const { name } = req.params;
    if (!isKnownSpec(name)) return res.status(404).json({ error: 'Esa especificación no existe' });

    const specs = specsOf(ctx.project);
    const existing = specs[name];
    const hasVersion = req.body?.version !== undefined;
    const version = parseVersion(req.body?.version);
    if (hasVersion && !version) return res.status(400).json({ error: 'La versión no es válida' });

    const parsed = SPECS[name].validate(req.body?.data);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    if (existing && version !== existing.version) {
      return res.status(409).json({
        error: version ? 'Otra persona modificó esta especificación mientras la editabas' : 'Esta especificación ya existe: envía la versión que estás editando',
        code: version ? 'VERSION_CONFLICT' : 'ALREADY_DEFINED',
        current: serializeSpec(name, existing),
      });
    }
    if (!existing && version) return res.status(409).json({ error: 'Esa especificación todavía no existe: guárdala sin versión', code: 'NOT_DEFINED' });

    specs[name] = { data: parsed.data, version: existing ? existing.version + 1 : 1, updatedBy: req.user.id, updatedAt: Date.now() };
    return res.status(existing ? 200 : 201).json({ spec: serializeSpec(name, specs[name]) });
  });

  // ---------- Motores ----------
  // Responden 409 si falta alguna especificación de la que dependen (el sistema no inventa datos).
  function requireSpec(res, project, name) {
    const stored = specsOf(project)[name];
    if (!stored) {
      res.status(409).json({ error: `Primero hay que definir: ${SPECS[name].label}`, code: 'SPEC_MISSING', missing: name });
      return null;
    }
    return stored;
  }

  // SCRUM-54. ?format=markdown devuelve el documento listo para pegar en la documentación final.
  app.get('/api/projects/:projectId/api-docs', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const spec = requireSpec(res, ctx.project, 'api');
    if (!spec) return;
    const docs = generateApiDocs(spec.data);
    if (req.query.format === 'markdown') return res.type('text/markdown; charset=utf-8').send(docs.markdown);
    return res.json({ ...docs, specVersion: spec.version });
  });

  // SCRUM-60. ?format=mermaid devuelve solo el diagrama en texto.
  app.get('/api/projects/:projectId/navigation-map', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const spec = requireSpec(res, ctx.project, 'navigation');
    if (!spec) return;
    const map = generateNavigationMap(spec.data);
    if (req.query.format === 'mermaid') return res.type('text/plain; charset=utf-8').send(map.mermaid);
    return res.json({ ...map, specVersion: spec.version });
  });

  // SCRUM-66
  app.get('/api/projects/:projectId/operations', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const spec = requireSpec(res, ctx.project, 'architecture');
    if (!spec) return;
    const ops = generateOperations(spec.data);
    if (req.query.format === 'markdown') return res.type('text/markdown; charset=utf-8').send(ops.markdown);
    return res.json({ ...ops, specVersion: spec.version });
  });

  // SCRUM-67. Usa también el modelo de datos si ya existe (relaciones muchos a muchos, etc.).
  app.get('/api/projects/:projectId/coherence', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const architecture = requireSpec(res, ctx.project, 'architecture');
    if (!architecture) return;
    const decisions = specsOf(ctx.project).decisions;
    const result = checkCoherence({ architecture: architecture.data, decisions: decisions?.data, model: ctx.project.model });
    return res.json({ ...result, architectureVersion: architecture.version, decisionsVersion: decisions ? decisions.version : null });
  });
}

module.exports = { registerDesignRoutes, SPECS };
