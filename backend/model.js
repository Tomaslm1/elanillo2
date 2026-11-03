// Modelo de datos del proyecto, editable en colaboración (SCRUM-48).
// Mismo patrón que resultados y requisitos: datos en memoria dentro del proyecto, permisos por rol
// (viewer solo lee) y versionado optimista (409 si alguien editó antes).
//
// Qué se edita y cómo se evitan los choques entre colaboradores:
//   - Cada ENTIDAD y cada RELACIÓN tiene su propia `version`. Dos personas que editan cosas distintas
//     no se bloquean entre sí; solo hay 409 si editan LO MISMO.
//   - El modelo completo tiene una `revision` que sube con cada cambio. El frontend la usa para
//     preguntar "¿hay algo nuevo?" (GET ...?since=<revision>) y así reflejar los cambios de otros.
//
// Validación tras cada edición (dos niveles):
//   - Errores de forma (nombre vacío, tipo desconocido, relación hacia una entidad que no existe...):
//     la edición se RECHAZA con 400 y no se guarda nada.
//   - Avisos de diseño (entidad sin clave primaria, sin atributos, sin relaciones...): la edición se
//     guarda, porque un modelo a medio hacer es normal, y los avisos vuelven en `validation`.
const crypto = require('crypto');

const ATTRIBUTE_TYPES = ['string', 'text', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'uuid', 'json'];
const RELATION_TYPES = ['one_to_one', 'one_to_many', 'many_to_many'];
const LIMITS = { name: 60, entities: 50, attributesPerEntity: 30, relations: 150 };

function registerModelRoutes(app, deps) {
  const { requireAuth, loadProjectForMember, requireEditor, parseVersion, findUserById, EDITOR_ROLES } = deps;

  const modelOf = (project) => (project.model ||= { entities: [], relations: [], revision: 0 });
  const authorName = (userId) => {
    const user = findUserById(userId);
    return user?.name || user?.username || null;
  };
  const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // ---------- Serialización ----------
  function serializeEntity(entity) {
    return {
      id: entity.id,
      name: entity.name,
      attributes: entity.attributes.map((attribute) => ({ ...attribute })),
      version: entity.version,
      updatedAt: entity.updatedAt,
      updatedByName: authorName(entity.updatedBy),
    };
  }

  function serializeRelation(relation) {
    return {
      id: relation.id,
      from: relation.from,
      to: relation.to,
      type: relation.type,
      name: relation.name,
      version: relation.version,
      updatedAt: relation.updatedAt,
      updatedByName: authorName(relation.updatedBy),
    };
  }

  function serializeModel(model) {
    return {
      entities: model.entities.map(serializeEntity),
      relations: model.relations.map(serializeRelation),
      revision: model.revision,
    };
  }

  // ---------- Validación de estructura ----------
  // Se ejecuta tras cada edición y su resultado vuelve en la respuesta.
  function validateModel(model) {
    const issues = [];
    const entityIds = new Set(model.entities.map((entity) => entity.id));

    for (const entity of model.entities) {
      if (entity.attributes.length === 0) {
        issues.push({
          level: 'warning',
          code: 'ENTITY_WITHOUT_ATTRIBUTES',
          entityId: entity.id,
          message: `La entidad "${entity.name}" no tiene atributos`,
        });
      } else if (!entity.attributes.some((attribute) => attribute.primaryKey)) {
        issues.push({
          level: 'warning',
          code: 'ENTITY_WITHOUT_PRIMARY_KEY',
          entityId: entity.id,
          message: `La entidad "${entity.name}" no tiene clave primaria`,
        });
      }
      if (model.entities.length > 1 && !model.relations.some((r) => r.from === entity.id || r.to === entity.id)) {
        issues.push({
          level: 'warning',
          code: 'ENTITY_WITHOUT_RELATIONS',
          entityId: entity.id,
          message: `La entidad "${entity.name}" no se relaciona con ninguna otra`,
        });
      }
    }

    // Esto no debería ocurrir (las rutas lo impiden), pero se comprueba como defensa.
    for (const relation of model.relations) {
      if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) {
        issues.push({
          level: 'error',
          code: 'ORPHAN_RELATION',
          relationId: relation.id,
          message: 'Hay una relación que apunta a una entidad que no existe',
        });
      }
    }

    return { valid: !issues.some((issue) => issue.level === 'error'), issues };
  }

  // Respuesta estándar de una edición exitosa: el modelo cambió, así que sube la revisión y se revalida.
  function commit(model, body) {
    model.revision += 1;
    return { ...body, revision: model.revision, validation: validateModel(model) };
  }

  // ---------- Lectura de datos de entrada ----------
  function parseName(raw, label) {
    const name = String(raw ?? '').trim();
    if (!name) return { error: `${label} es obligatorio` };
    if (name.length > LIMITS.name) return { error: `${label} no puede superar ${LIMITS.name} caracteres` };
    return { name };
  }

  // Los atributos se envían completos (se reemplaza la lista). Si traen `id` de un atributo existente
  // se conserva; si no, se genera uno nuevo.
  function parseAttributes(raw, existing = []) {
    if (raw === undefined) return { attributes: existing.map((attribute) => ({ ...attribute })) };
    if (!Array.isArray(raw)) return { error: 'Los atributos deben ser una lista' };
    if (raw.length > LIMITS.attributesPerEntity) {
      return { error: `Una entidad no puede tener más de ${LIMITS.attributesPerEntity} atributos` };
    }

    const knownIds = new Set(existing.map((attribute) => attribute.id));
    const attributes = [];
    for (const item of raw) {
      const parsed = parseName(item?.name, 'El nombre del atributo');
      if (parsed.error) return { error: parsed.error };
      if (!ATTRIBUTE_TYPES.includes(item?.type)) {
        return { error: `El tipo del atributo "${parsed.name}" debe ser uno de: ${ATTRIBUTE_TYPES.join(', ')}` };
      }
      if (attributes.some((attribute) => sameName(attribute.name, parsed.name))) {
        return { error: `El atributo "${parsed.name}" está repetido en la entidad` };
      }
      attributes.push({
        id: knownIds.has(item?.id) && !attributes.some((a) => a.id === item.id) ? item.id : crypto.randomUUID(),
        name: parsed.name,
        type: item.type,
        required: item?.required === true,
        primaryKey: item?.primaryKey === true,
      });
    }
    return { attributes };
  }

  function parseRelation(body, model, currentId = null) {
    const { from, to, type } = body || {};
    const parsedName = String(body?.name ?? '').trim();
    if (parsedName.length > LIMITS.name) return { error: `El nombre de la relación no puede superar ${LIMITS.name} caracteres` };
    if (!model.entities.some((entity) => entity.id === from)) return { error: 'La entidad de origen no existe' };
    if (!model.entities.some((entity) => entity.id === to)) return { error: 'La entidad de destino no existe' };
    if (!RELATION_TYPES.includes(type)) return { error: `El tipo de relación debe ser uno de: ${RELATION_TYPES.join(', ')}` };

    const duplicate = model.relations.find(
      (relation) =>
        relation.id !== currentId &&
        relation.from === from &&
        relation.to === to &&
        relation.type === type &&
        sameName(relation.name, parsedName),
    );
    if (duplicate) return { duplicate: true };
    return { fields: { from, to, type, name: parsedName } };
  }

  // ---------- Respuestas de error ----------
  const entityConflict = (res, entity) =>
    res.status(409).json({
      error: 'Otra persona modificó esta entidad mientras la editabas',
      code: 'VERSION_CONFLICT',
      current: serializeEntity(entity),
    });
  const relationConflict = (res, relation) =>
    res.status(409).json({
      error: 'Otra persona modificó esta relación mientras la editabas',
      code: 'VERSION_CONFLICT',
      current: serializeRelation(relation),
    });
  const duplicateName = (res, name) =>
    res.status(409).json({ error: `Ya existe una entidad llamada "${name}"`, code: 'DUPLICATE_NAME' });

  // ================= Lectura =================
  // Cualquier miembro puede ver el modelo. Con ?since=<revision> el frontend pregunta si hubo cambios:
  // si no los hubo responde algo mínimo; si los hubo, devuelve el modelo completo.
  app.get('/api/projects/:projectId/model', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx) return;
    const model = modelOf(ctx.project);

    if (req.query.since !== undefined && Number(req.query.since) === model.revision) {
      return res.json({ changed: false, revision: model.revision });
    }
    return res.json({
      changed: true,
      model: serializeModel(model),
      validation: validateModel(model),
      attributeTypes: ATTRIBUTE_TYPES,
      relationTypes: RELATION_TYPES,
      canEdit: EDITOR_ROLES.includes(ctx.membership.role),
    });
  });

  // ================= Entidades =================
  app.post('/api/projects/:projectId/model/entities', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const model = modelOf(ctx.project);

    const parsedName = parseName(req.body?.name, 'El nombre de la entidad');
    if (parsedName.error) return res.status(400).json({ error: parsedName.error });
    const parsedAttributes = parseAttributes(req.body?.attributes);
    if (parsedAttributes.error) return res.status(400).json({ error: parsedAttributes.error });
    if (model.entities.length >= LIMITS.entities) {
      return res.status(400).json({ error: `El modelo no puede tener más de ${LIMITS.entities} entidades` });
    }
    if (model.entities.some((entity) => sameName(entity.name, parsedName.name))) {
      return duplicateName(res, parsedName.name);
    }

    const entity = {
      id: crypto.randomUUID(),
      name: parsedName.name,
      attributes: parsedAttributes.attributes,
      version: 1,
      updatedBy: req.user.id,
      updatedAt: Date.now(),
    };
    model.entities.push(entity);
    return res.status(201).json(commit(model, { entity: serializeEntity(entity) }));
  });

  // Editar: body { name, attributes, version }. `version` es la que el cliente vio.
  app.put('/api/projects/:projectId/model/entities/:entityId', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const model = modelOf(ctx.project);

    const entity = model.entities.find((candidate) => candidate.id === req.params.entityId);
    if (!entity) return res.status(404).json({ error: 'La entidad ya no existe' });

    const version = parseVersion(req.body?.version);
    if (!version) return res.status(400).json({ error: 'Falta la versión que estás editando' });

    const parsedName = parseName(req.body?.name, 'El nombre de la entidad');
    if (parsedName.error) return res.status(400).json({ error: parsedName.error });
    const parsedAttributes = parseAttributes(req.body?.attributes, entity.attributes);
    if (parsedAttributes.error) return res.status(400).json({ error: parsedAttributes.error });

    if (version !== entity.version) return entityConflict(res, entity);
    if (model.entities.some((other) => other.id !== entity.id && sameName(other.name, parsedName.name))) {
      return duplicateName(res, parsedName.name);
    }

    Object.assign(entity, {
      name: parsedName.name,
      attributes: parsedAttributes.attributes,
      version: entity.version + 1,
      updatedBy: req.user.id,
      updatedAt: Date.now(),
    });
    return res.json(commit(model, { entity: serializeEntity(entity) }));
  });

  // Eliminar: versión en la URL (?version=N). Las relaciones de la entidad se eliminan con ella,
  // y la respuesta dice cuáles fueron (nada se borra sin avisar).
  app.delete('/api/projects/:projectId/model/entities/:entityId', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const model = modelOf(ctx.project);

    const index = model.entities.findIndex((candidate) => candidate.id === req.params.entityId);
    if (index === -1) return res.status(404).json({ error: 'La entidad ya no existe' });
    const entity = model.entities[index];

    const version = parseVersion(req.query.version);
    if (!version) return res.status(400).json({ error: 'Falta la versión que estás eliminando' });
    if (version !== entity.version) return entityConflict(res, entity);

    const removedRelations = model.relations.filter((r) => r.from === entity.id || r.to === entity.id).map(serializeRelation);
    model.relations = model.relations.filter((r) => r.from !== entity.id && r.to !== entity.id);
    model.entities.splice(index, 1);
    return res.json(commit(model, { message: 'Entidad eliminada', removedRelations }));
  });

  // ================= Relaciones =================
  app.post('/api/projects/:projectId/model/relations', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const model = modelOf(ctx.project);

    if (model.relations.length >= LIMITS.relations) {
      return res.status(400).json({ error: `El modelo no puede tener más de ${LIMITS.relations} relaciones` });
    }
    const parsed = parseRelation(req.body, model);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (parsed.duplicate) return res.status(409).json({ error: 'Esa relación ya existe', code: 'DUPLICATE_RELATION' });

    const relation = { id: crypto.randomUUID(), ...parsed.fields, version: 1, updatedBy: req.user.id, updatedAt: Date.now() };
    model.relations.push(relation);
    return res.status(201).json(commit(model, { relation: serializeRelation(relation) }));
  });

  app.put('/api/projects/:projectId/model/relations/:relationId', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const model = modelOf(ctx.project);

    const relation = model.relations.find((candidate) => candidate.id === req.params.relationId);
    if (!relation) return res.status(404).json({ error: 'La relación ya no existe' });

    const version = parseVersion(req.body?.version);
    if (!version) return res.status(400).json({ error: 'Falta la versión que estás editando' });

    const parsed = parseRelation(req.body, model, relation.id);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    if (version !== relation.version) return relationConflict(res, relation);
    if (parsed.duplicate) return res.status(409).json({ error: 'Esa relación ya existe', code: 'DUPLICATE_RELATION' });

    Object.assign(relation, parsed.fields, { version: relation.version + 1, updatedBy: req.user.id, updatedAt: Date.now() });
    return res.json(commit(model, { relation: serializeRelation(relation) }));
  });

  app.delete('/api/projects/:projectId/model/relations/:relationId', requireAuth, (req, res) => {
    const ctx = loadProjectForMember(req, res);
    if (!ctx || !requireEditor(ctx.membership, res)) return;
    const model = modelOf(ctx.project);

    const index = model.relations.findIndex((candidate) => candidate.id === req.params.relationId);
    if (index === -1) return res.status(404).json({ error: 'La relación ya no existe' });

    const version = parseVersion(req.query.version);
    if (!version) return res.status(400).json({ error: 'Falta la versión que estás eliminando' });
    if (version !== model.relations[index].version) return relationConflict(res, model.relations[index]);

    model.relations.splice(index, 1);
    return res.json(commit(model, { message: 'Relación eliminada' }));
  });
}

module.exports = { registerModelRoutes, ATTRIBUTE_TYPES, RELATION_TYPES };
