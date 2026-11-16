// Estructura del contenido de cada etapa, como JSON Schema "estricto" (formato que exige
// response_format json_schema strict de OpenAI: todas las propiedades requeridas, sin propiedades extra,
// los opcionales se expresan como `null`). Se usa para:
//   1. Obligar al LLM a responder con esta forma exacta.
//   2. Validar las ediciones manuales de los usuarios (validate()).

const str = (description) => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description) => ({ type: 'integer', ...(description ? { description } : {}) });
const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const enm = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
function obj(properties, description) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    ...(description ? { description } : {}),
  };
}

const STAGES = ['DEFINITION', 'DATA_MODEL', 'API', 'FRONTEND', 'ARCHITECTURE', 'REVIEW'];
// Etapas cuyo contenido es generado/editado (REVIEW no tiene contenido propio: consolida las demás).
const CONTENT_STAGES = ['DEFINITION', 'DATA_MODEL', 'API', 'FRONTEND', 'ARCHITECTURE'];

const STAGE_LABELS = {
  DEFINITION: 'Definición del producto',
  DATA_MODEL: 'Modelo de datos',
  API: 'Backend y API',
  FRONTEND: 'Frontend',
  ARCHITECTURE: 'Arquitectura',
  REVIEW: 'Revisión y documentos',
};

const definitionSchema = obj({
  productName: str('Nombre corto del producto'),
  summary: str('Resumen del producto en 2-4 oraciones'),
  problem: obj({
    statement: str('Problema concreto que se resuelve'),
    context: str('Dónde y cuándo ocurre el problema'),
    currentSituation: str('Cómo se resuelve hoy y por qué no basta'),
    expectedImprovement: str('Qué mejora concreta se espera'),
  }),
  userTypes: arr(obj({
    name: str('Nombre del tipo de usuario/rol. Se usa EXACTAMENTE igual en las demás etapas'),
    description: str(),
    goals: arr(str()),
    permissions: arr(str('Qué puede y qué no puede hacer')),
  })),
  expectedOutcomes: arr(obj({ outcome: str(), successMetric: str('Cómo se mide que se cumplió') })),
  mvp: obj({
    inScope: arr(obj({ id: str('ID estable, ej: F1'), feature: str(), description: str(), userTypes: arr(str()) })),
    outOfScope: arr(obj({ feature: str(), reason: str() })),
  }),
  mainJourney: obj({
    name: str(),
    actor: str('Tipo de usuario que lo realiza'),
    steps: arr(obj({ order: int(), userAction: str(), systemResponse: str() })),
  }),
  functionalRequirements: arr(obj({ id: str('ID estable, ej: RF1'), description: str(), featureId: str('ID de la funcionalidad del MVP'), userTypes: arr(str()) })),
  businessRules: arr(obj({ id: str('ID estable, ej: RN1'), rule: str() })),
  technicalConstraints: arr(str()),
  integrations: arr(obj({ name: str(), purpose: str(), failureBehavior: str('Qué hace el sistema si no está disponible') })),
  security: arr(str()),
  edgeCases: arr(obj({
    category: enm(['missing_info', 'action_failed', 'no_permission', 'not_found', 'invalid_data', 'external_unavailable', 'concurrency', 'other']),
    scenario: str(),
    expectedBehavior: str(),
  })),
  openItems: arr(str('Información que puede quedar abierta sin bloquear la construcción')),
});

const COLUMN_TYPES = ['uuid', 'string', 'text', 'integer', 'bigint', 'decimal', 'boolean', 'date', 'timestamp', 'json', 'enum'];

const dataModelSchema = obj({
  overview: str('Explicación general del modelo y de las decisiones principales'),
  entities: arr(obj({
    name: str('Nombre de la entidad en PascalCase singular'),
    tableName: str('Nombre de la tabla en snake_case plural'),
    description: str(),
    attributes: arr(obj({
      name: str('snake_case'),
      type: enm(COLUMN_TYPES),
      enumValues: nullable(arr(str())),
      maxLength: nullable(int()),
      nullable: bool(),
      primaryKey: bool(),
      unique: bool(),
      default: nullable(str()),
      references: nullable(obj({
        entity: str('Nombre de la entidad referenciada'),
        attribute: str(),
        onDelete: enm(['CASCADE', 'SET NULL', 'RESTRICT']),
      })),
      description: str(),
    })),
    indexes: arr(obj({ columns: arr(str()), unique: bool(), reason: str() })),
    constraints: arr(str('Restricciones adicionales: CHECKs, unicidad compuesta, reglas de integridad')),
  })),
  relationships: arr(obj({
    from: str('Nombre exacto de la entidad (campo name), lado "uno"'),
    to: str('Nombre exacto de la entidad (campo name), lado "muchos" en 1:N'),
    cardinality: enm(['1:1', '1:N', 'N:M']),
    via: nullable(str('SOLO para N:M: nombre de la ENTIDAD intermedia (no una columna). null en 1:1 y 1:N')),
    description: str(),
  })),
});

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const fieldSchema = obj({ name: str(), type: str(), required: bool(), validation: str() });

const apiSchema = obj({
  baseUrl: str('Ej: /api/v1'),
  authentication: str('Cómo se autentica cada request (cookie/bearer, formato)'),
  conventions: arr(str('Convenciones generales: paginación, fechas, ids, nombres')),
  errorFormat: str('Forma JSON común de los errores, con ejemplo'),
  endpoints: arr(obj({
    id: str('ID estable, ej: E1'),
    method: enm(HTTP_METHODS),
    path: str('Ruta con parámetros como :id'),
    summary: str(),
    auth: enm(['public', 'authenticated']),
    roles: arr(str('Tipos de usuario permitidos (vacío = cualquier autenticado)')),
    entities: arr(str('Entidades del modelo de datos que usa')),
    requirementIds: arr(str('IDs de REQUISITOS FUNCIONALES de la definición (ej: RF3). NO usar IDs de funcionalidades del MVP (F1, F2)')),
    pathParams: arr(obj({ name: str(), type: str(), description: str() })),
    queryParams: arr(fieldSchema),
    headers: arr(obj({ name: str(), required: bool(), description: str() })),
    requestBody: nullable(obj({ contentType: str(), fields: arr(fieldSchema), example: str('JSON de ejemplo') })),
    responses: arr(obj({ status: int(), description: str(), body: str('JSON de ejemplo o vacío') })),
  })),
});

const frontendSchema = obj({
  overview: str(),
  screens: arr(obj({
    id: str('ID estable, ej: S1'),
    name: str(),
    route: str(),
    purpose: str(),
    roles: arr(str('Tipos de usuario que acceden')),
    dataShown: arr(str()),
    actions: arr(obj({
      label: str(),
      endpointId: nullable(str('ID del endpoint que invoca, o null si es solo navegación')),
      roles: arr(str('Quién ve esta acción (vacío = todos los que acceden a la pantalla)')),
      result: str('Qué pasa después (navega a / muestra)'),
    })),
    states: arr(str('Estados: cargando, vacío, error, sin permisos')),
    wireframe: str('Wireframe en ASCII de baja fidelidad, máx 25 líneas'),
  })),
  navigation: arr(obj({ from: str('ID pantalla'), to: str('ID pantalla'), trigger: str() })),
  entryScreenId: str(),
  mainFlow: arr(str('ID de una pantalla EXISTENTE en screens'), 'Recorrido principal: solo IDs de pantallas definidas arriba, en orden, sin repetir; normalmente 3-8 pasos'),
});

const architectureSchema = obj({
  templateId: str('ID de una de las arquitecturas base'),
  justification: str('Por qué esta arquitectura es apropiada para ESTE producto'),
  alternativesDiscarded: arr(obj({ templateId: str(), reason: str() })),
  database: obj({ engine: str(), orm: str(), migrations: str(), notes: str() }),
  backend: obj({ language: str(), framework: str(), structure: str('Capas/carpetas'), validation: str(), notes: str() }),
  frontend: obj({ framework: str(), structure: str(), stateManagement: str(), styling: str(), notes: str() }),
  communication: str('Cómo se comunican frontend y backend (REST/JSON, CORS, etc.)'),
  authentication: obj({
    identityValidation: str(),
    sso: str(),
    sessionOrToken: str(),
    authorization: str('Cómo el backend decide si un usuario puede acceder a un recurso'),
  }),
  deployment: obj({
    docker: str(),
    environments: arr(str()),
    envVars: arr(obj({ name: str(), description: str(), example: str() })),
    configuration: str(),
    hosting: str(),
  }),
  observability: obj({ logging: str(), metrics: str(), tracing: str(), monitoring: str(), healthChecks: str() }),
  testing: str('Estrategia de pruebas unitarias y funcionales'),
  projectStructure: str('Árbol de carpetas propuesto'),
  risks: arr(str()),
});

const STAGE_SCHEMAS = {
  DEFINITION: definitionSchema,
  DATA_MODEL: dataModelSchema,
  API: apiSchema,
  FRONTEND: frontendSchema,
  ARCHITECTURE: architectureSchema,
};

const questionSchema = obj({
  text: str('Pregunta concreta (sin listar las opciones aquí)'),
  reason: str('Por qué importa / qué decide'),
  options: arr(str('Opción de respuesta autocontenida'), '2-4 opciones concretas; lista vacía si es una pregunta abierta'),
  blocking: bool('true si sin esta respuesta no se puede construir una solución coherente (afecta datos, backend, UI o arquitectura)'),
});

// Respuesta de un turno de conversación en una etapa.
function turnSchema(stage) {
  return obj({
    reply: str('Mensaje para el usuario: qué entendiste, qué cambiaste y qué falta. Breve.'),
    content: STAGE_SCHEMAS[stage],
    newQuestions: arr(questionSchema),
    resolvedQuestionIds: arr(str('IDs de preguntas abiertas que quedaron respondidas')),
  });
}

const reviewSchema = obj({
  issues: arr(obj({
    description: str('Contradicción o vacío concreto, citando IDs/nombres'),
    stages: arr(enm(CONTENT_STAGES)),
    blocking: bool(),
    suggestion: str(),
  })),
  summary: str(),
});

// ---- Validador mínimo para el subconjunto de JSON Schema usado arriba ----
function validate(schema, value, path = '$', errors = []) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) {
    if (!types.includes('null')) errors.push(`${path}: no puede ser null`);
    return errors;
  }
  const type = types.find((t) => t !== 'null');
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: debe ser un objeto`);
      return errors;
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: falta`);
    }
    for (const key of Object.keys(value)) {
      if (!schema.properties[key]) errors.push(`${path}.${key}: propiedad no permitida`);
      else validate(schema.properties[key], value[key], `${path}.${key}`, errors);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path}: debe ser una lista`);
    else value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
  } else if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: debe ser texto`);
    else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: debe ser uno de ${schema.enum.join(', ')}`);
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: debe ser un entero`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: debe ser true/false`);
  }
  return errors;
}

module.exports = {
  STAGES,
  CONTENT_STAGES,
  STAGE_LABELS,
  STAGE_SCHEMAS,
  COLUMN_TYPES,
  turnSchema,
  reviewSchema,
  validate,
};
