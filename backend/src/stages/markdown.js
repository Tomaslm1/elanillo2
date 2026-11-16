// Genera los documentos finales (Markdown) a partir del contenido aprobado de cada etapa.
// Se construyen de forma determinística (sin LLM) para que reflejen exactamente lo aprobado.
const { findArchitecture } = require('./architectures');
const { erDiagram, navigationDiagram } = require('./diagrams');

const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const list = (items, fallback = '_Ninguno._') => (items?.length ? items.map((i) => `- ${i}`).join('\n') : fallback);
const table = (headers, rows) => (rows.length
  ? [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n')
  : '_Ninguno._');
const yesNo = (value) => (value ? 'sí' : 'no');

function columnType(attr) {
  if (attr.type === 'enum') return `enum(${(attr.enumValues || []).join(', ')})`;
  if (attr.type === 'string' && attr.maxLength) return `string(${attr.maxLength})`;
  return attr.type;
}

function decisionsSection(decisions) {
  if (!decisions.length) return '_No se registraron preguntas._';
  return decisions.map((q) => `- **${q.text}**\n  → ${q.status === 'DISMISSED' ? `_Descartada:_ ${q.answer}` : q.answer}`).join('\n');
}

function productSpec({ project, contents, decisions, openItems }) {
  const def = contents.DEFINITION;
  const model = contents.DATA_MODEL;
  const api = contents.API;
  const front = contents.FRONTEND;
  const out = [];

  out.push(`# Especificación de producto: ${def.productName || project.name}`);
  out.push(`> Documento generado por Ideator. Es autocontenido: junto con \`arquitectura.md\` contiene todo lo necesario para implementar el producto.
> **Instrucciones para quien implementa:** implementa exactamente lo descrito. No agregues funcionalidades fuera del alcance del MVP.
> Respeta los nombres de entidades, columnas, rutas, códigos de estado y roles tal como aparecen. Si algo no está especificado,
> usa la opción más simple coherente con este documento y déjala anotada.`);

  out.push(`## 1. Resumen\n${def.summary}`);
  out.push(`## 2. Problema\n**Problema:** ${def.problem.statement}\n\n**Contexto:** ${def.problem.context}\n\n**Situación actual:** ${def.problem.currentSituation}\n\n**Mejora esperada:** ${def.problem.expectedImprovement}`);

  out.push(`## 3. Tipos de usuario\n${def.userTypes.map((u) => `### ${u.name}\n${u.description}\n\n**Objetivos:**\n${list(u.goals)}\n\n**Permisos:**\n${list(u.permissions)}`).join('\n\n')}`);
  out.push(`## 4. Resultados esperados\n${table(['Resultado', 'Métrica de éxito'], def.expectedOutcomes.map((o) => [o.outcome, o.successMetric]))}`);

  out.push(`## 5. Alcance del MVP\n### Incluido\n${table(['ID', 'Funcionalidad', 'Descripción', 'Usuarios'], def.mvp.inScope.map((f) => [f.id, f.feature, f.description, f.userTypes.join(', ')]))}\n\n### Fuera del MVP (no implementar)\n${table(['Funcionalidad', 'Motivo'], def.mvp.outOfScope.map((f) => [f.feature, f.reason]))}`);

  out.push(`## 6. Recorrido principal: ${def.mainJourney.name}\nActor: **${def.mainJourney.actor}**\n\n${table(['#', 'Acción del usuario', 'Respuesta del sistema'], [...def.mainJourney.steps].sort((a, b) => a.order - b.order).map((s) => [s.order, s.userAction, s.systemResponse]))}`);

  out.push(`## 7. Requisitos funcionales\n${table(['ID', 'Descripción', 'Funcionalidad', 'Usuarios'], def.functionalRequirements.map((r) => [r.id, r.description, r.featureId, r.userTypes.join(', ')]))}`);
  out.push(`## 8. Reglas de negocio\n${table(['ID', 'Regla'], def.businessRules.map((r) => [r.id, r.rule]))}`);
  out.push(`## 9. Restricciones técnicas\n${list(def.technicalConstraints)}`);
  out.push(`## 10. Integraciones externas\n${table(['Integración', 'Propósito', 'Si no está disponible'], def.integrations.map((i) => [i.name, i.purpose, i.failureBehavior]))}`);
  out.push(`## 11. Seguridad\n${list(def.security)}`);
  out.push(`## 12. Casos borde y manejo de errores\n${table(['Tipo', 'Escenario', 'Comportamiento esperado'], def.edgeCases.map((e) => [e.category, e.scenario, e.expectedBehavior]))}`);

  // Modelo de datos
  out.push(`## 13. Modelo de datos\n${model.overview}\n\n### Diagrama entidad-relación\n\`\`\`mermaid\n${erDiagram(model)}\n\`\`\``);
  model.entities.forEach((entity) => {
    const rows = entity.attributes.map((a) => [
      a.name,
      columnType(a),
      a.primaryKey ? 'PK' : '',
      yesNo(!a.nullable),
      yesNo(a.unique),
      a.default ?? '',
      a.references ? `${a.references.entity}.${a.references.attribute} (ON DELETE ${a.references.onDelete})` : '',
      a.description,
    ]);
    const extras = [
      entity.indexes.length ? `**Índices:**\n${list(entity.indexes.map((i) => `${i.unique ? 'UNIQUE ' : ''}(${i.columns.join(', ')}): ${i.reason}`))}` : '',
      entity.constraints.length ? `**Restricciones:**\n${list(entity.constraints)}` : '',
    ].filter(Boolean).join('\n\n');
    out.push(`### ${entity.name} (tabla \`${entity.tableName}\`)\n${entity.description}\n\n${table(['Columna', 'Tipo', 'PK', 'Obligatorio', 'Único', 'Default', 'FK', 'Descripción'], rows)}${extras ? `\n\n${extras}` : ''}`);
  });
  out.push(`### Relaciones\n${table(['Desde', 'Hacia', 'Cardinalidad', 'Vía', 'Descripción'], model.relationships.map((r) => [r.from, r.to, r.cardinality, r.via || '', r.description]))}`);

  // API
  out.push(`## 14. API REST\n**Base URL:** \`${api.baseUrl}\`\n\n**Autenticación:** ${api.authentication}\n\n**Convenciones:**\n${list(api.conventions)}\n\n**Formato de error:** ${api.errorFormat}\n\n### Índice de endpoints\n${table(['ID', 'Método', 'Ruta', 'Descripción', 'Auth', 'Roles'], api.endpoints.map((e) => [e.id, e.method, `\`${e.path}\``, e.summary, e.auth, e.roles.join(', ') || 'cualquiera autenticado']))}`);
  api.endpoints.forEach((ep) => {
    const parts = [`### ${ep.id} · \`${ep.method} ${ep.path}\`\n${ep.summary}`];
    parts.push(`- **Auth:** ${ep.auth}${ep.roles.length ? ` · **Roles:** ${ep.roles.join(', ')}` : ''}\n- **Entidades:** ${ep.entities.join(', ') || '—'}\n- **Requisitos:** ${ep.requirementIds.join(', ') || '—'}`);
    if (ep.pathParams.length) parts.push(`**Parámetros de ruta**\n${table(['Nombre', 'Tipo', 'Descripción'], ep.pathParams.map((p) => [p.name, p.type, p.description]))}`);
    if (ep.queryParams.length) parts.push(`**Query**\n${table(['Nombre', 'Tipo', 'Obligatorio', 'Validación'], ep.queryParams.map((p) => [p.name, p.type, yesNo(p.required), p.validation]))}`);
    if (ep.headers.length) parts.push(`**Headers**\n${table(['Nombre', 'Obligatorio', 'Descripción'], ep.headers.map((h) => [h.name, yesNo(h.required), h.description]))}`);
    if (ep.requestBody) {
      parts.push(`**Body** (\`${ep.requestBody.contentType}\`)\n${table(['Campo', 'Tipo', 'Obligatorio', 'Validación'], ep.requestBody.fields.map((f) => [f.name, f.type, yesNo(f.required), f.validation]))}`);
      if (ep.requestBody.example?.trim()) parts.push(`\`\`\`json\n${ep.requestBody.example}\n\`\`\``);
    }
    parts.push(`**Respuestas**\n${ep.responses.map((r) => `- **${r.status}** — ${r.description}${r.body?.trim() ? `\n  \`\`\`json\n  ${r.body.replace(/\n/g, '\n  ')}\n  \`\`\`` : ''}`).join('\n')}`);
    out.push(parts.join('\n\n'));
  });

  // Frontend
  out.push(`## 15. Interfaz (frontend)\n${front.overview}\n\n**Pantalla de entrada:** ${front.entryScreenId} · **Flujo principal:** ${front.mainFlow.join(' → ')}\n\n### Mapa de navegación\n\`\`\`mermaid\n${navigationDiagram(front)}\n\`\`\``);
  front.screens.forEach((screen) => {
    out.push(`### ${screen.id} · ${screen.name} (\`${screen.route}\`)\n${screen.purpose}\n\n- **Acceden:** ${screen.roles.join(', ') || 'todos'}\n- **Muestra:** ${screen.dataShown.join('; ') || '—'}\n- **Estados:** ${screen.states.join('; ') || '—'}\n\n**Acciones**\n${table(['Acción', 'Endpoint', 'Visible para', 'Resultado'], screen.actions.map((a) => [a.label, a.endpointId || '(navegación)', a.roles.join(', ') || 'todos', a.result]))}\n\n\`\`\`text\n${screen.wireframe}\n\`\`\``);
  });

  out.push(`## 16. Decisiones tomadas durante la definición\n${decisionsSection(decisions)}`);
  out.push(`## 17. Puntos abiertos (no bloqueantes)\n${list(openItems, '_Ninguno._')}`);
  return `${out.join('\n\n')}\n`;
}

function architectureDoc({ project, contents }) {
  const arch = contents.ARCHITECTURE;
  const def = contents.DEFINITION;
  const base = findArchitecture(arch.templateId);
  const out = [];

  out.push(`# Arquitectura: ${def.productName || project.name}`);
  out.push(`> Documento generado por Ideator. Define la arquitectura definitiva para implementar la especificación de \`producto.md\`.
> Usa exactamente estas tecnologías y decisiones; no las sustituyas.`);
  out.push(`## 1. Arquitectura seleccionada\n**${base ? base.name : arch.templateId}** (\`${arch.templateId}\`)\n\n${arch.justification}\n\n**Alternativas descartadas:**\n${list(arch.alternativesDiscarded.map((a) => `\`${a.templateId}\`: ${a.reason}`))}`);
  out.push(`## 2. Organización de la solución\n**Comunicación entre componentes:** ${arch.communication}\n\n### Estructura de carpetas\n\`\`\`text\n${arch.projectStructure}\n\`\`\``);
  out.push(`## 3. Base de datos\n- **Motor:** ${arch.database.engine}\n- **ORM / acceso a datos:** ${arch.database.orm}\n- **Migraciones:** ${arch.database.migrations}\n- **Notas:** ${arch.database.notes}\n\nEl esquema (entidades, columnas, claves e índices) está definido en la sección "Modelo de datos" de \`producto.md\` y debe implementarse tal cual.`);
  out.push(`## 4. Backend\n- **Lenguaje:** ${arch.backend.language}\n- **Framework:** ${arch.backend.framework}\n- **Estructura:** ${arch.backend.structure}\n- **Validación:** ${arch.backend.validation}\n- **Notas:** ${arch.backend.notes}\n\nLos endpoints, contratos y códigos de respuesta están en la sección "API REST" de \`producto.md\`.`);
  out.push(`## 5. Frontend\n- **Framework:** ${arch.frontend.framework}\n- **Estructura:** ${arch.frontend.structure}\n- **Estado:** ${arch.frontend.stateManagement}\n- **Estilos:** ${arch.frontend.styling}\n- **Notas:** ${arch.frontend.notes}`);
  out.push(`## 6. Autenticación y autorización\n- **Validación de identidad:** ${arch.authentication.identityValidation}\n- **Single Sign-On:** ${arch.authentication.sso}\n- **Sesión / token:** ${arch.authentication.sessionOrToken}\n- **Autorización:** ${arch.authentication.authorization}\n\n**Roles del producto:** ${def.userTypes.map((u) => u.name).join(', ')}. La autorización se valida siempre en el backend; ocultar controles en la interfaz no es suficiente.`);
  out.push(`## 7. Despliegue y configuración\n- **Docker:** ${arch.deployment.docker}\n- **Hosting:** ${arch.deployment.hosting}\n- **Ambientes:** ${arch.deployment.environments.join(', ')}\n- **Configuración:** ${arch.deployment.configuration}\n\n### Variables de entorno\n${table(['Variable', 'Descripción', 'Ejemplo'], arch.deployment.envVars.map((v) => [v.name, v.description, v.example]))}`);
  out.push(`## 8. Observabilidad\n- **Logging:** ${arch.observability.logging}\n- **Métricas:** ${arch.observability.metrics}\n- **Trazabilidad:** ${arch.observability.tracing}\n- **Monitoreo:** ${arch.observability.monitoring}\n- **Health checks:** ${arch.observability.healthChecks}`);
  out.push(`## 9. Pruebas\n${arch.testing}`);
  out.push(`## 10. Riesgos y mitigaciones\n${list(arch.risks)}`);
  return `${out.join('\n\n')}\n`;
}

function buildExports({ project, contents, decisions, openItems }) {
  return [
    { name: 'producto.md', content: productSpec({ project, contents, decisions, openItems }) },
    { name: 'arquitectura.md', content: architectureDoc({ project, contents }) },
  ];
}

module.exports = { buildExports };
