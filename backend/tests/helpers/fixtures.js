// Especificación de ejemplo (app de reservas de un gimnasio), consistente entre todas las etapas.
// Se usa como respuesta del LLM falso y para los tests unitarios de consistencia/exportación.
const clone = (value) => JSON.parse(JSON.stringify(value));

const DEFINITION = {
  productName: 'GymBook',
  summary: 'Aplicación web para que los socios de un gimnasio reserven cupos en clases grupales.',
  problem: {
    statement: 'Los socios no saben si hay cupo en las clases y se producen sobrecupos.',
    context: 'Gimnasio de barrio con 8 clases diarias y 300 socios.',
    currentSituation: 'Reservas por WhatsApp anotadas a mano por recepción.',
    expectedImprovement: 'Cero sobrecupos y reservas en menos de 30 segundos.',
  },
  userTypes: [
    { name: 'Socio', description: 'Persona inscrita en el gimnasio', goals: ['Reservar una clase'], permissions: ['Reservar y cancelar sus propias reservas'] },
    { name: 'Administrador', description: 'Personal de recepción', goals: ['Gestionar clases'], permissions: ['Crear clases', 'Ver todas las reservas'] },
  ],
  expectedOutcomes: [{ outcome: 'Sin sobrecupos', successMetric: '0 clases con más reservas que cupos' }],
  mvp: {
    inScope: [
      { id: 'F1', feature: 'Reservar clase', description: 'El socio reserva un cupo', userTypes: ['Socio'] },
      { id: 'F2', feature: 'Gestionar clases', description: 'El administrador crea clases', userTypes: ['Administrador'] },
    ],
    outOfScope: [{ feature: 'Pagos en línea', reason: 'Se pagan en recepción' }],
  },
  mainJourney: {
    name: 'Reservar una clase',
    actor: 'Socio',
    steps: [
      { order: 1, userAction: 'Abre el listado de clases', systemResponse: 'Muestra clases con cupos disponibles' },
      { order: 2, userAction: 'Pulsa Reservar', systemResponse: 'Crea la reserva y descuenta un cupo' },
    ],
  },
  functionalRequirements: [
    { id: 'RF1', description: 'Listar clases con cupos', featureId: 'F1', userTypes: ['Socio', 'Administrador'] },
    { id: 'RF2', description: 'Crear reserva', featureId: 'F1', userTypes: ['Socio'] },
    { id: 'RF3', description: 'Crear clase', featureId: 'F2', userTypes: ['Administrador'] },
  ],
  businessRules: [{ id: 'RN1', rule: 'Un socio no puede reservar dos veces la misma clase' }],
  technicalConstraints: ['Debe funcionar en navegadores móviles'],
  integrations: [],
  security: ['Contraseñas con bcrypt'],
  edgeCases: [
    { category: 'no_permission', scenario: 'Un socio intenta crear una clase', expectedBehavior: 'Responder 403' },
    { category: 'not_found', scenario: 'La clase no existe', expectedBehavior: 'Responder 404' },
    { category: 'invalid_data', scenario: 'Cupo negativo', expectedBehavior: 'Responder 422' },
  ],
  openItems: [],
};

const DATA_MODEL = {
  overview: 'Tres entidades: usuarios, clases y reservas.',
  entities: [
    {
      name: 'User', tableName: 'users', description: 'Usuarios',
      attributes: [
        { name: 'id', type: 'uuid', enumValues: null, maxLength: null, nullable: false, primaryKey: true, unique: true, default: 'gen_random_uuid()', references: null, description: 'PK' },
        { name: 'email', type: 'string', enumValues: null, maxLength: 255, nullable: false, primaryKey: false, unique: true, default: null, references: null, description: 'Correo' },
        { name: 'role', type: 'enum', enumValues: ['Socio', 'Administrador'], maxLength: null, nullable: false, primaryKey: false, unique: false, default: 'Socio', references: null, description: 'Rol' },
      ],
      indexes: [], constraints: [],
    },
    {
      name: 'GymClass', tableName: 'gym_classes', description: 'Clases',
      attributes: [
        { name: 'id', type: 'uuid', enumValues: null, maxLength: null, nullable: false, primaryKey: true, unique: true, default: null, references: null, description: 'PK' },
        { name: 'capacity', type: 'integer', enumValues: null, maxLength: null, nullable: false, primaryKey: false, unique: false, default: null, references: null, description: 'Cupos' },
      ],
      indexes: [], constraints: ['CHECK (capacity > 0)'],
    },
    {
      name: 'Booking', tableName: 'bookings', description: 'Reservas',
      attributes: [
        { name: 'id', type: 'uuid', enumValues: null, maxLength: null, nullable: false, primaryKey: true, unique: true, default: null, references: null, description: 'PK' },
        { name: 'user_id', type: 'uuid', enumValues: null, maxLength: null, nullable: false, primaryKey: false, unique: false, default: null, references: { entity: 'User', attribute: 'id', onDelete: 'CASCADE' }, description: 'Socio' },
        { name: 'class_id', type: 'uuid', enumValues: null, maxLength: null, nullable: false, primaryKey: false, unique: false, default: null, references: { entity: 'GymClass', attribute: 'id', onDelete: 'CASCADE' }, description: 'Clase' },
      ],
      indexes: [{ columns: ['user_id', 'class_id'], unique: true, reason: 'RN1' }],
      constraints: [],
    },
  ],
  relationships: [
    { from: 'User', to: 'Booking', cardinality: '1:N', via: null, description: 'hace' },
    { from: 'GymClass', to: 'Booking', cardinality: '1:N', via: null, description: 'tiene' },
  ],
};

const response = (status, description) => ({ status, description, body: '' });

const API = {
  baseUrl: '/api',
  authentication: 'Cookie HttpOnly con JWT',
  conventions: ['Fechas ISO 8601'],
  errorFormat: '{"error": "mensaje"}',
  endpoints: [
    {
      id: 'E1', method: 'GET', path: '/classes', summary: 'Lista clases', auth: 'authenticated', roles: [], entities: ['GymClass'], requirementIds: ['RF1'],
      pathParams: [], queryParams: [], headers: [], requestBody: null,
      responses: [response(200, 'Lista'), response(401, 'Sin sesión')],
    },
    {
      id: 'E2', method: 'POST', path: '/classes/:classId/bookings', summary: 'Reserva', auth: 'authenticated', roles: ['Socio'], entities: ['Booking', 'GymClass'], requirementIds: ['RF2'],
      pathParams: [{ name: 'classId', type: 'uuid', description: 'Clase' }], queryParams: [], headers: [], requestBody: null,
      responses: [response(201, 'Creada'), response(401, 'Sin sesión'), response(403, 'No es socio'), response(404, 'No existe'), response(409, 'Ya reservada')],
    },
    {
      id: 'E3', method: 'POST', path: '/classes', summary: 'Crea clase', auth: 'authenticated', roles: ['Administrador'], entities: ['GymClass'], requirementIds: ['RF3'],
      pathParams: [], queryParams: [], headers: [],
      requestBody: { contentType: 'application/json', fields: [{ name: 'capacity', type: 'integer', required: true, validation: '> 0' }], example: '{"capacity": 20}' },
      responses: [response(201, 'Creada'), response(400, 'Inválido'), response(401, 'Sin sesión'), response(403, 'No es admin')],
    },
  ],
};

const FRONTEND = {
  overview: 'SPA con dos pantallas.',
  screens: [
    {
      id: 'S1', name: 'Clases', route: '/clases', purpose: 'Ver y reservar', roles: ['Socio', 'Administrador'], dataShown: ['Clases'],
      actions: [
        { label: 'Reservar', endpointId: 'E2', roles: ['Socio'], result: 'Muestra confirmación' },
        { label: 'Cargar', endpointId: 'E1', roles: [], result: 'Lista' },
        { label: 'Nueva clase', endpointId: null, roles: ['Administrador'], result: 'Navega a S2' },
      ],
      states: ['cargando', 'vacío', 'error'], wireframe: '+--------+\n| Clases |\n+--------+',
    },
    {
      id: 'S2', name: 'Nueva clase', route: '/clases/nueva', purpose: 'Crear clase', roles: ['Administrador'], dataShown: [],
      actions: [{ label: 'Guardar', endpointId: 'E3', roles: [], result: 'Vuelve a S1' }],
      states: ['error'], wireframe: '[ cupos ] [Guardar]',
    },
  ],
  navigation: [{ from: 'S1', to: 'S2', trigger: 'Nueva clase' }, { from: 'S2', to: 'S1', trigger: 'Guardar' }],
  entryScreenId: 'S1',
  mainFlow: ['S1'],
};

const ARCHITECTURE = {
  templateId: 'node-spa-monolith',
  justification: 'CRUD simple y equipo JavaScript.',
  alternativesDiscarded: [{ templateId: 'java-spring-enterprise', reason: 'Demasiado pesado' }],
  database: { engine: 'PostgreSQL 16', orm: 'Prisma', migrations: 'prisma migrate', notes: '' },
  backend: { language: 'TypeScript', framework: 'Express', structure: 'routes/services', validation: 'zod', notes: '' },
  frontend: { framework: 'React + Vite', structure: 'pages/components', stateManagement: 'TanStack Query', styling: 'CSS modules', notes: '' },
  communication: 'REST/JSON',
  authentication: { identityValidation: 'bcrypt', sso: 'Google OIDC', sessionOrToken: 'JWT en cookie', authorization: 'Middleware por rol' },
  deployment: { docker: 'docker-compose', environments: ['dev', 'prod'], envVars: [{ name: 'DATABASE_URL', description: 'Conexión', example: 'postgresql://...' }], configuration: '.env', hosting: 'Render' },
  observability: { logging: 'pino', metrics: 'prom-client', tracing: 'request-id', monitoring: 'Uptime', healthChecks: '/health' },
  testing: 'Jest + Supertest + Playwright',
  projectStructure: 'backend/\nfrontend/',
  risks: ['Picos de reservas a la misma hora'],
};

const CONTENTS = { DEFINITION, DATA_MODEL, API, FRONTEND, ARCHITECTURE };

module.exports = { CONTENTS, clone };
