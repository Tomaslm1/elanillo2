// Validación determinística de consistencia entre etapas.
// Devuelve hallazgos { severity: 'error'|'warning', stage, message }.
// Los 'error' impiden aprobar la etapa afectada y generar los documentos finales.
const { findArchitecture } = require('./architectures');

const norm = (value) => String(value ?? '').trim().toLowerCase();

function duplicates(values) {
  const seen = new Set();
  const dups = new Set();
  values.forEach((value) => (seen.has(norm(value)) ? dups.add(value) : seen.add(norm(value))));
  return [...dups];
}

function checkDefinition(def, add) {
  if (!def) return;
  if (!def.problem?.statement?.trim()) add('error', 'El problema a resolver no está definido.');
  if (!def.userTypes?.length) add('error', 'No hay tipos de usuario definidos.');
  if (!def.mvp?.inScope?.length) add('error', 'El alcance del MVP no tiene funcionalidades.');
  if (!def.mainJourney?.steps?.length) add('error', 'El recorrido principal no tiene pasos.');
  if (!def.functionalRequirements?.length) add('error', 'No hay requisitos funcionales.');

  const userTypes = new Set((def.userTypes || []).map((u) => norm(u.name)));
  const featureIds = new Set((def.mvp?.inScope || []).map((f) => norm(f.id)));

  duplicates((def.userTypes || []).map((u) => u.name)).forEach((d) => add('error', `Tipo de usuario duplicado: "${d}".`));
  duplicates((def.mvp?.inScope || []).map((f) => f.id)).forEach((d) => add('error', `ID de funcionalidad duplicado: ${d}.`));
  duplicates((def.functionalRequirements || []).map((r) => r.id)).forEach((d) => add('error', `ID de requisito duplicado: ${d}.`));

  if (def.mainJourney?.actor && userTypes.size && !userTypes.has(norm(def.mainJourney.actor))) {
    add('error', `El actor del recorrido principal ("${def.mainJourney.actor}") no es un tipo de usuario definido.`);
  }
  (def.mvp?.inScope || []).forEach((feature) => {
    (feature.userTypes || []).forEach((u) => {
      if (!userTypes.has(norm(u))) add('error', `La funcionalidad ${feature.id} usa el tipo de usuario "${u}", que no está definido.`);
    });
  });
  (def.functionalRequirements || []).forEach((req) => {
    if (req.featureId && !featureIds.has(norm(req.featureId))) {
      add('warning', `El requisito ${req.id} apunta a la funcionalidad ${req.featureId}, que no está en el MVP.`);
    }
    (req.userTypes || []).forEach((u) => {
      if (!userTypes.has(norm(u))) add('error', `El requisito ${req.id} usa el tipo de usuario "${u}", que no está definido.`);
    });
  });
  const categories = new Set((def.edgeCases || []).map((e) => e.category));
  ['no_permission', 'not_found', 'invalid_data'].forEach((category) => {
    if (!categories.has(category)) add('warning', `Falta definir el comportamiento para casos borde de tipo "${category}".`);
  });
}

function checkDataModel(model, add) {
  if (!model) return;
  if (!model.entities?.length) {
    add('error', 'El modelo de datos no tiene entidades.');
    return;
  }
  const entities = new Map(model.entities.map((e) => [norm(e.name), e]));
  duplicates(model.entities.map((e) => e.name)).forEach((d) => add('error', `Entidad duplicada: ${d}.`));
  duplicates(model.entities.map((e) => e.tableName)).forEach((d) => add('error', `Nombre de tabla duplicado: ${d}.`));

  model.entities.forEach((entity) => {
    const attrs = new Set((entity.attributes || []).map((a) => norm(a.name)));
    duplicates((entity.attributes || []).map((a) => a.name)).forEach((d) => add('error', `${entity.name}: atributo duplicado "${d}".`));
    if (!(entity.attributes || []).some((a) => a.primaryKey)) add('error', `${entity.name}: no tiene clave primaria.`);
    (entity.attributes || []).forEach((attr) => {
      if (attr.type === 'enum' && !attr.enumValues?.length) add('error', `${entity.name}.${attr.name}: es enum pero no define valores.`);
      if (attr.primaryKey && attr.nullable) add('error', `${entity.name}.${attr.name}: una clave primaria no puede ser nullable.`);
      if (attr.references) {
        const target = entities.get(norm(attr.references.entity));
        if (!target) {
          add('error', `${entity.name}.${attr.name}: referencia a la entidad inexistente "${attr.references.entity}".`);
        } else if (!(target.attributes || []).some((a) => norm(a.name) === norm(attr.references.attribute))) {
          add('error', `${entity.name}.${attr.name}: referencia a ${target.name}.${attr.references.attribute}, que no existe.`);
        }
        if (attr.references.onDelete === 'SET NULL' && !attr.nullable) {
          add('error', `${entity.name}.${attr.name}: ON DELETE SET NULL requiere que la columna sea nullable.`);
        }
      }
    });
    (entity.indexes || []).forEach((index) => {
      (index.columns || []).forEach((column) => {
        if (!attrs.has(norm(column))) add('error', `${entity.name}: el índice usa la columna inexistente "${column}".`);
      });
    });
  });

  (model.relationships || []).forEach((rel) => {
    [rel.from, rel.to, rel.via].filter(Boolean).forEach((name) => {
      if (!entities.has(norm(name))) add('error', `La relación ${rel.from} → ${rel.to} usa la entidad inexistente "${name}".`);
    });
    if (rel.cardinality === 'N:M' && !rel.via) add('error', `La relación N:M ${rel.from} ↔ ${rel.to} necesita una entidad intermedia.`);
  });
}

function checkApi(api, def, model, add) {
  if (!api) return;
  if (!api.endpoints?.length) {
    add('error', 'La API no tiene endpoints.');
    return;
  }
  const entities = new Set((model?.entities || []).map((e) => norm(e.name)));
  const userTypes = new Set((def?.userTypes || []).map((u) => norm(u.name)));
  const requirementIds = new Set((def?.functionalRequirements || []).map((r) => norm(r.id)));

  duplicates(api.endpoints.map((e) => e.id)).forEach((d) => add('error', `ID de endpoint duplicado: ${d}.`));
  duplicates(api.endpoints.map((e) => `${e.method} ${e.path}`)).forEach((d) => add('error', `Endpoint duplicado: ${d}.`));

  api.endpoints.forEach((ep) => {
    const label = `${ep.id} ${ep.method} ${ep.path}`;
    const statuses = new Set((ep.responses || []).map((r) => r.status));
    const has = (code) => statuses.has(code);

    if (![...statuses].some((s) => s >= 200 && s < 300)) add('error', `${label}: no documenta una respuesta exitosa (2xx).`);
    if (ep.auth === 'authenticated' && !has(401)) add('error', `${label}: requiere autenticación pero no documenta 401.`);
    if (ep.roles?.length && !has(403)) add('warning', `${label}: restringe roles pero no documenta 403.`);
    if (ep.pathParams?.length && !has(404)) add('warning', `${label}: recibe parámetros de ruta pero no documenta 404.`);
    if (['POST', 'PUT', 'PATCH'].includes(ep.method) && ep.requestBody && !has(400) && !has(422)) {
      add('error', `${label}: recibe un body pero no documenta 400/422 para datos inválidos.`);
    }
    if (ep.method === 'DELETE' && ep.requestBody) add('warning', `${label}: un DELETE no debería llevar body.`);

    const pathParamNames = (ep.path.match(/:([A-Za-z0-9_]+)|\{([A-Za-z0-9_]+)\}/g) || []).map((p) => norm(p.replace(/[:{}]/g, '')));
    const declared = new Set((ep.pathParams || []).map((p) => norm(p.name)));
    pathParamNames.forEach((name) => {
      if (!declared.has(name)) add('error', `${label}: el parámetro de ruta "${name}" no está documentado.`);
    });

    if (model) {
      (ep.entities || []).forEach((entity) => {
        if (!entities.has(norm(entity))) add('error', `${label}: usa la entidad "${entity}", que no existe en el modelo de datos aprobado.`);
      });
    }
    if (def) {
      (ep.roles || []).forEach((role) => {
        if (!userTypes.has(norm(role))) add('error', `${label}: usa el rol "${role}", que no es un tipo de usuario definido.`);
      });
      (ep.requirementIds || []).forEach((id) => {
        if (!requirementIds.has(norm(id))) add('warning', `${label}: referencia el requisito ${id}, que no existe.`);
      });
    }
  });

  if (def) {
    const covered = new Set(api.endpoints.flatMap((ep) => (ep.requirementIds || []).map(norm)));
    (def.functionalRequirements || []).forEach((req) => {
      if (!covered.has(norm(req.id))) add('warning', `El requisito ${req.id} no está cubierto por ningún endpoint.`);
    });
  }
}

function checkFrontend(front, def, api, add) {
  if (!front) return;
  if (!front.screens?.length) {
    add('error', 'No hay pantallas definidas.');
    return;
  }
  const screens = new Set(front.screens.map((s) => norm(s.id)));
  const endpoints = new Set((api?.endpoints || []).map((e) => norm(e.id)));
  const userTypes = new Set((def?.userTypes || []).map((u) => norm(u.name)));

  duplicates(front.screens.map((s) => s.id)).forEach((d) => add('error', `ID de pantalla duplicado: ${d}.`));
  if (!screens.has(norm(front.entryScreenId))) add('error', `La pantalla inicial "${front.entryScreenId}" no existe.`);
  (front.mainFlow || []).forEach((id) => {
    if (!screens.has(norm(id))) add('error', `El flujo principal usa la pantalla inexistente "${id}".`);
  });
  (front.navigation || []).forEach((nav) => {
    [nav.from, nav.to].forEach((id) => {
      if (!screens.has(norm(id))) add('error', `La navegación ${nav.from} → ${nav.to} usa la pantalla inexistente "${id}".`);
    });
  });

  front.screens.forEach((screen) => {
    if (def) {
      (screen.roles || []).forEach((role) => {
        if (!userTypes.has(norm(role))) add('error', `Pantalla ${screen.id}: usa el rol "${role}", que no es un tipo de usuario definido.`);
      });
    }
    (screen.actions || []).forEach((action) => {
      if (action.endpointId && api && !endpoints.has(norm(action.endpointId))) {
        add('error', `Pantalla ${screen.id}, acción "${action.label}": usa el endpoint ${action.endpointId}, que no existe en la API.`);
      }
      if (def) {
        (action.roles || []).forEach((role) => {
          if (!userTypes.has(norm(role))) add('error', `Pantalla ${screen.id}, acción "${action.label}": rol "${role}" no definido.`);
        });
      }
    });
    const reachable = (front.navigation || []).some((nav) => norm(nav.to) === norm(screen.id));
    if (!reachable && norm(screen.id) !== norm(front.entryScreenId)) {
      add('warning', `La pantalla ${screen.id} (${screen.name}) no es alcanzable desde ninguna otra.`);
    }
  });

  if (api) {
    const used = new Set(front.screens.flatMap((s) => (s.actions || []).map((a) => norm(a.endpointId)).filter(Boolean)));
    api.endpoints.forEach((ep) => {
      if (!used.has(norm(ep.id))) add('warning', `El endpoint ${ep.id} ${ep.method} ${ep.path} no lo usa ninguna pantalla.`);
    });
  }
}

function checkArchitecture(arch, add) {
  if (!arch) return;
  if (!findArchitecture(arch.templateId)) add('error', `La arquitectura "${arch.templateId}" no es una de las arquitecturas base.`);
  if (!arch.justification?.trim()) add('error', 'La arquitectura no tiene justificación.');
  if (!arch.deployment?.envVars?.length) add('warning', 'La arquitectura no lista variables de entorno.');
}

/**
 * @param {Record<string, object|null>} contents contenido vigente por etapa
 * @returns {{severity: 'error'|'warning', stage: string, message: string}[]}
 */
function checkConsistency(contents) {
  const findings = [];
  const adder = (stage) => (severity, message) => findings.push({ severity, stage, message });
  checkDefinition(contents.DEFINITION, adder('DEFINITION'));
  checkDataModel(contents.DATA_MODEL, adder('DATA_MODEL'));
  checkApi(contents.API, contents.DEFINITION, contents.DATA_MODEL, adder('API'));
  checkFrontend(contents.FRONTEND, contents.DEFINITION, contents.API, adder('FRONTEND'));
  checkArchitecture(contents.ARCHITECTURE, adder('ARCHITECTURE'));
  return findings;
}

module.exports = { checkConsistency };
