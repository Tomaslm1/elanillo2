// SCRUM-66: aspectos operacionales de una arquitectura: Docker, despliegue, variables de entorno,
// ambientes y observabilidad. Cada parte aparece "cuando corresponde": depende de los componentes
// que la arquitectura realmente tiene (sin base de datos no hay respaldos, sin IA no hay presupuesto
// de tokens, etc.). Es determinista: sin IA, siempre las mismas reglas.
const { databaseFamily, backendFamily } = require('./tech');

const DEPLOYMENTS = ['containers', 'single_vm', 'serverless', 'managed_paas'];
const ROLES = ['frontend', 'backend', 'database', 'cache', 'queue', 'worker', 'ai'];
const LIMITS = { name: 80, components: 20, tech: 80 };
const text = (value) => String(value ?? '').trim();

function validateArchitectureSpec(data) {
  const name = text(data?.name);
  if (!name || name.length > LIMITS.name) return { error: `La arquitectura necesita un nombre de hasta ${LIMITS.name} caracteres` };
  if (!DEPLOYMENTS.includes(data?.deployment)) return { error: `"deployment" debe ser uno de: ${DEPLOYMENTS.join(', ')}` };
  if (!Array.isArray(data?.components) || data.components.length === 0) return { error: 'Define al menos un componente en "components"' };
  if (data.components.length > LIMITS.components) return { error: `No puede haber más de ${LIMITS.components} componentes` };

  const components = [];
  for (const item of data.components) {
    const componentName = text(item?.name);
    const tech = text(item?.tech);
    if (!componentName || componentName.length > LIMITS.name) return { error: 'Cada componente necesita un nombre' };
    if (!ROLES.includes(item?.role)) return { error: `El rol de "${componentName}" debe ser uno de: ${ROLES.join(', ')}` };
    if (!tech || tech.length > LIMITS.tech) return { error: `El componente "${componentName}" necesita una tecnología ("tech")` };
    if (components.some((c) => c.name.toLowerCase() === componentName.toLowerCase())) {
      return { error: `El componente "${componentName}" está repetido` };
    }
    components.push({ name: componentName, role: item.role, tech });
  }
  return { data: { name, deployment: data.deployment, components } };
}

// ---- Piezas por tecnología ----
const DB_SERVICES = {
  postgresql: { image: 'postgres:16', port: 5432, env: ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'], volume: '/var/lib/postgresql/data', health: 'pg_isready -U $$POSTGRES_USER' },
  mysql: { image: 'mysql:8', port: 3306, env: ['MYSQL_ROOT_PASSWORD', 'MYSQL_DATABASE'], volume: '/var/lib/mysql', health: 'mysqladmin ping -h localhost' },
  mongodb: { image: 'mongo:7', port: 27017, env: ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD'], volume: '/data/db', health: null },
  sqlserver: { image: 'mcr.microsoft.com/mssql/server:2022-latest', port: 1433, env: ['ACCEPT_EULA', 'MSSQL_SA_PASSWORD'], volume: '/var/opt/mssql', health: null },
  redis: { image: 'redis:7-alpine', port: 6379, env: [], volume: '/data', health: 'redis-cli ping' },
};
const BACKEND_PORTS = { node: 3000, python: 8000, java: 8080, dotnet: 8080, php: 8080, ruby: 3000, go: 8080 };

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'servicio';

function buildDocker(components, notes) {
  const services = [];
  const dataServices = [];

  for (const component of components) {
    const key = slug(component.name);
    if (component.role === 'database' || component.role === 'cache' || component.role === 'queue') {
      const family = component.role === 'queue' ? (component.tech.toLowerCase().includes('rabbit') ? 'rabbitmq' : null) : databaseFamily(component.tech);
      if (family === 'sqlite') {
        notes.push(`"${component.name}" usa SQLite: es un archivo, no un contenedor. Hay que montar un volumen persistente para el archivo.`);
        continue;
      }
      if (family === 'rabbitmq') {
        services.push({ name: key, image: 'rabbitmq:3-management', ports: ['5672:5672'], env: ['RABBITMQ_DEFAULT_USER', 'RABBITMQ_DEFAULT_PASS'], volume: '/var/lib/rabbitmq', healthcheck: 'rabbitmq-diagnostics -q ping', dependsOn: [] });
        dataServices.push(key);
        continue;
      }
      const def = DB_SERVICES[family];
      if (!def) {
        notes.push(`No hay una imagen estándar para "${component.tech}" (${component.name}): defínela a mano o usa un servicio administrado.`);
        continue;
      }
      services.push({ name: key, image: def.image, ports: [`${def.port}:${def.port}`], env: def.env, volume: def.volume, healthcheck: def.health, dependsOn: [] });
      dataServices.push(key);
    }
  }

  for (const component of components) {
    const key = slug(component.name);
    if (component.role === 'backend' || component.role === 'worker') {
      const port = BACKEND_PORTS[backendFamily(component.tech)] || 3000;
      if (!backendFamily(component.tech)) notes.push(`No se reconoce la tecnología "${component.tech}" de ${component.name}: se asume el puerto ${port}, ajústalo si es otro.`);
      services.push({
        name: key,
        build: `./${key}`,
        ports: component.role === 'backend' ? [`${port}:${port}`] : [],
        env: ['(todas las variables de la sección de entorno)'],
        healthcheck: component.role === 'backend' ? `curl -f http://localhost:${port}/health` : null,
        dependsOn: dataServices,
      });
    } else if (component.role === 'frontend') {
      services.push({ name: key, build: `./${key}`, image: 'nginx:alpine (sirve los archivos compilados)', ports: ['8080:80'], env: [], healthcheck: null, dependsOn: [] });
    }
  }
  return services;
}

function composeYaml(services) {
  const lines = ['services:'];
  for (const s of services) {
    lines.push(`  ${s.name}:`);
    if (s.build) lines.push(`    build: ${s.build}`);
    else lines.push(`    image: ${s.image}`);
    if (s.ports.length) lines.push('    ports:', ...s.ports.map((p) => `      - "${p}"`));
    if (s.env.length && !s.env[0].startsWith('(')) lines.push('    environment:', ...s.env.map((e) => `      ${e}: \${${e}}`));
    if (s.build && s.env.length) lines.push('    env_file: .env');
    if (s.volume) lines.push('    volumes:', `      - ${s.name}-data:${s.volume}`);
    if (s.healthcheck) lines.push('    healthcheck:', `      test: ["CMD-SHELL", "${s.healthcheck}"]`, '      interval: 10s', '      retries: 5');
    if (s.dependsOn.length) lines.push('    depends_on:', ...s.dependsOn.map((d) => `      - ${d}`));
  }
  const volumes = services.filter((s) => s.volume).map((s) => `  ${s.name}-data:`);
  if (volumes.length) lines.push('', 'volumes:', ...volumes);
  return lines.join('\n');
}

function buildEnvVars(components) {
  const vars = [];
  const add = (name, description, { required = true, secret = false, component } = {}) => vars.push({ name, description, required, secret, component });
  const withRole = (role) => components.filter((c) => c.role === role);

  if (withRole('backend').length) {
    const backend = withRole('backend')[0].name;
    add('APP_ENV', 'Ambiente en el que corre (desarrollo, pruebas o produccion)', { component: backend });
    add('PORT', 'Puerto en el que escucha el backend', { required: false, component: backend });
    add('LOG_LEVEL', 'Nivel de detalle de los logs (debug, info, warn, error)', { required: false, component: backend });
  }
  for (const db of withRole('database')) {
    if (databaseFamily(db.tech) !== 'redis') add('DATABASE_URL', `Cadena de conexión a la base de datos (${db.tech})`, { secret: true, component: db.name });
  }
  if (withRole('cache').length) add('CACHE_URL', 'Dirección de la caché', { secret: true, component: withRole('cache')[0].name });
  if (withRole('queue').length) add('QUEUE_URL', 'Dirección de la cola de mensajes', { secret: true, component: withRole('queue')[0].name });
  if (withRole('ai').length) {
    const ai = withRole('ai')[0].name;
    add('AI_API_KEY', 'Clave del proveedor de IA. Solo la usa el backend; jamás debe llegar al frontend', { secret: true, component: ai });
    add('AI_BASE_URL', 'Dirección del servicio de IA', { component: ai });
    add('AI_MODEL', 'Modelo o deployment que se usa', { component: ai });
    add('AI_MONTHLY_TOKEN_BUDGET', 'Tope mensual de tokens; al superarlo se avisa o se bloquean nuevas llamadas', { required: false, component: ai });
  }
  if (withRole('frontend').length) add('API_BASE_URL', 'Dirección del backend que usa el frontend (se fija al compilar)', { component: withRole('frontend')[0].name });
  return vars;
}

const STEPS = {
  containers: [
    'Construir una imagen por cada servicio propio y etiquetarla con la versión (por ejemplo, el hash del commit).',
    'Subir las imágenes a un registro de contenedores.',
    'Cargar las variables de entorno secretas desde el gestor de secretos de la plataforma, nunca desde el repositorio.',
    'Ejecutar las migraciones de base de datos antes de levantar la nueva versión del backend.',
    'Desplegar los contenedores y esperar a que pasen sus chequeos de salud.',
    'Si fallan los chequeos, volver a la etiqueta de imagen anterior (rollback).',
  ],
  single_vm: [
    'Crear la máquina virtual y cerrar todos los puertos salvo 80 y 443 (y 22 solo para administradores).',
    'Instalar Docker y Docker Compose.',
    'Copiar docker-compose.yml y crear el archivo .env solo en el servidor, con permisos restringidos.',
    'Configurar un proxy inverso con certificado HTTPS (por ejemplo, Caddy o Nginx con Let\'s Encrypt).',
    'Levantar el sistema con "docker compose up -d" y comprobar /health.',
    'Programar respaldos automáticos de los datos persistentes y probar la restauración.',
  ],
  serverless: [
    'Empaquetar cada función con sus dependencias.',
    'Definir las variables de entorno en el servicio del proveedor, con las secretas en su gestor de secretos.',
    'Usar una base de datos administrada con pool de conexiones (las funciones abren muchas conexiones cortas).',
    'Publicar un API Gateway delante de las funciones, con límite de peticiones.',
    'Desplegar por ambiente (pruebas primero) y probar los endpoints principales.',
  ],
  managed_paas: [
    'Conectar el repositorio a la plataforma y elegir la rama que se despliega automáticamente.',
    'Crear la base de datos administrada y copiar su cadena de conexión a las variables de entorno.',
    'Cargar las demás variables de entorno desde el panel de la plataforma.',
    'Configurar el comando de arranque, el puerto y la ruta de chequeo de salud (/health).',
    'Activar los despliegues automáticos y revisar los logs del primer despliegue.',
  ],
};

function buildEnvironments(deployment, hasDatabase) {
  const environments = [
    {
      name: 'desarrollo',
      purpose: 'Trabajo diario de cada integrante en su propio computador.',
      differences: ['Se levanta con Docker Compose en la máquina local.', 'Logs en nivel debug.', 'Datos de prueba; nunca datos reales.', 'Secretos de ejemplo en un .env local (fuera del repositorio).'],
    },
  ];
  if (deployment !== 'single_vm') {
    environments.push({
      name: 'pruebas',
      purpose: 'Probar cada cambio en un entorno parecido a producción antes de publicarlo.',
      differences: ['Misma configuración que producción, con datos ficticios.', 'Se despliega automáticamente con cada cambio aprobado.', 'Secretos propios, distintos a los de producción.'],
    });
  }
  environments.push({
    name: 'produccion',
    purpose: 'El sistema que usan las personas reales.',
    differences: [
      'Logs en nivel info y en formato JSON.',
      'HTTPS obligatorio.',
      'Secretos en un gestor de secretos, rotados periódicamente.',
      ...(hasDatabase ? ['Respaldos automáticos de la base de datos y restauración probada.'] : []),
      'Despliegue solo desde la rama principal y con un plan de rollback.',
    ],
  });
  return environments;
}

function buildObservability(components) {
  const roles = new Set(components.map((c) => c.role));
  const logs = ['Todos los servicios escriben logs a la salida estándar, en JSON, con fecha, nivel y un identificador de petición.', 'Nunca se registran contraseñas, tokens ni claves.'];
  const metrics = [];
  const healthChecks = [];
  const alerts = [];

  if (roles.has('backend')) {
    healthChecks.push('El backend expone GET /health (sin autenticación) que responde 200 si está vivo y sus dependencias responden.');
    metrics.push('Peticiones por minuto, latencia (p50 y p95) y tasa de errores 5xx por endpoint.');
    alerts.push('Tasa de errores 5xx sobre el 2% durante 5 minutos.', 'Latencia p95 sobre 1 segundo durante 10 minutos.');
  }
  if (roles.has('database')) {
    metrics.push('Conexiones activas, consultas lentas y espacio en disco de la base de datos.');
    alerts.push('Espacio en disco de la base de datos sobre el 80%.', 'Último respaldo con más de 24 horas.');
  }
  if (roles.has('cache')) metrics.push('Tasa de aciertos de la caché y uso de memoria.');
  if (roles.has('queue') || roles.has('worker')) {
    metrics.push('Mensajes pendientes en la cola y tiempo que esperan antes de procesarse.');
    alerts.push('Cola con mensajes acumulándose por más de 15 minutos.');
  }
  if (roles.has('ai')) {
    metrics.push('Tokens consumidos y costo estimado por proyecto y por día.', 'Latencia y tasa de errores de las llamadas a la IA.');
    alerts.push('Consumo de tokens del mes sobre el 80% del presupuesto (AI_MONTHLY_TOKEN_BUDGET).');
  }
  if (roles.has('frontend')) metrics.push('Errores de JavaScript en el navegador y tiempo de carga de la página principal.');
  return { logs, metrics, healthChecks, alerts };
}

const bullets = (items) => items.map((item) => `- ${item}`).join('\n');

function toMarkdown(spec, ops) {
  const dockerSection = ops.docker.services.length
    ? `Servicios: ${ops.docker.services.map((s) => `\`${s.name}\``).join(', ')}.\n\n\`\`\`yaml\n${ops.docker.composeYaml}\n\`\`\`\n` + (ops.docker.notes.length ? `\n${bullets(ops.docker.notes)}\n` : '')
    : (ops.docker.notes.length ? bullets(ops.docker.notes) : 'Esta arquitectura no define servicios propios para contenerizar.') + '\n';
  const envTable = ops.environmentVariables.length
    ? '| Variable | Qué es | Obligatoria | Secreta | Componente |\n|---|---|---|---|---|\n' +
      ops.environmentVariables.map((v) => `| \`${v.name}\` | ${v.description} | ${v.required ? 'Sí' : 'No'} | ${v.secret ? 'Sí' : 'No'} | ${v.component} |`).join('\n')
    : 'No se requieren variables de entorno.';
  const envs = ops.environments.map((e) => `### ${e.name[0].toUpperCase()}${e.name.slice(1)}\n\n${e.purpose}\n\n${bullets(e.differences)}`).join('\n\n');
  const obs = ops.observability;
  return [
    `# Aspectos operacionales: ${spec.name}`,
    '## Docker',
    dockerSection,
    `## Despliegue (${spec.deployment})`,
    ops.deployment.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'),
    '## Variables de entorno',
    envTable,
    '## Ambientes',
    envs,
    '## Observabilidad',
    `**Logs**\n\n${bullets(obs.logs)}`,
    obs.healthChecks.length ? `**Chequeos de salud**\n\n${bullets(obs.healthChecks)}` : '',
    obs.metrics.length ? `**Métricas**\n\n${bullets(obs.metrics)}` : '',
    obs.alerts.length ? `**Alertas**\n\n${bullets(obs.alerts)}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
}

function generateOperations(spec) {
  const notes = [];
  const services = buildDocker(spec.components, notes);
  const hasDatabase = spec.components.some((c) => c.role === 'database');
  const ops = {
    docker: { services, composeYaml: services.length ? composeYaml(services) : '', notes },
    deployment: { style: spec.deployment, steps: STEPS[spec.deployment] },
    environmentVariables: buildEnvVars(spec.components),
    environments: buildEnvironments(spec.deployment, hasDatabase),
    observability: buildObservability(spec.components),
  };
  return { ...ops, markdown: toMarkdown(spec, ops) };
}

module.exports = { validateArchitectureSpec, generateOperations, DEPLOYMENTS, ROLES };
