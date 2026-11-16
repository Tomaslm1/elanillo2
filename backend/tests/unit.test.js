// Pruebas unitarias de la lógica de negocio (no usan HTTP ni LLM).
const { checkConsistency } = require('../src/stages/consistency');
const { validate, STAGE_SCHEMAS, turnSchema } = require('../src/stages/schemas');
const { erDiagram, navigationDiagram } = require('../src/stages/diagrams');
const { buildExports } = require('../src/stages/markdown');
const { ARCHITECTURES } = require('../src/stages/architectures');
const { CONTENTS, clone } = require('./helpers/fixtures');

const errorsOf = (contents) => checkConsistency(contents).filter((f) => f.severity === 'error');

describe('Validador de esquemas', () => {
  test.each(Object.keys(CONTENTS))('el fixture de %s cumple su esquema', (stage) => {
    expect(validate(STAGE_SCHEMAS[stage], CONTENTS[stage])).toEqual([]);
  });

  test('detecta propiedades faltantes, extra y tipos incorrectos', () => {
    const def = clone(CONTENTS.DEFINITION);
    delete def.summary;
    def.extra = 1;
    def.userTypes[0].goals = 'no es lista';
    const errors = validate(STAGE_SCHEMAS.DEFINITION, def);
    expect(errors).toEqual(expect.arrayContaining([
      '$.summary: falta',
      '$.extra: propiedad no permitida',
      '$.userTypes[0].goals: debe ser una lista',
    ]));
  });

  test('valida enums y nullables', () => {
    const model = clone(CONTENTS.DATA_MODEL);
    model.entities[0].attributes[0].type = 'varchar';
    model.entities[0].attributes[0].references = null; // null permitido
    model.entities[0].attributes[1].nullable = null; // null NO permitido
    const errors = validate(STAGE_SCHEMAS.DATA_MODEL, model);
    expect(errors.some((e) => e.includes('.type: debe ser uno de'))).toBe(true);
    expect(errors.some((e) => e.includes('.nullable: no puede ser null'))).toBe(true);
    expect(errors.some((e) => e.includes('.references'))).toBe(false);
  });

  test('los esquemas de turno cumplen el modo estricto (todas las propiedades requeridas)', () => {
    const walk = (schema) => {
      if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
        expect(schema.additionalProperties).toBe(false);
        expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach(walk);
      }
      if (schema.items) walk(schema.items);
    };
    Object.keys(STAGE_SCHEMAS).forEach((stage) => walk(turnSchema(stage)));
  });
});

describe('Consistencia entre etapas', () => {
  test('una especificación coherente no tiene errores', () => {
    expect(errorsOf(CONTENTS)).toEqual([]);
  });

  test('definición: actor y roles deben ser tipos de usuario definidos', () => {
    const contents = clone(CONTENTS);
    contents.DEFINITION.mainJourney.actor = 'Invitado';
    contents.DEFINITION.functionalRequirements[0].userTypes.push('Entrenador');
    const messages = errorsOf(contents).map((f) => f.message);
    expect(messages.some((m) => m.includes('"Invitado"'))).toBe(true);
    expect(messages.some((m) => m.includes('"Entrenador"'))).toBe(true);
  });

  test('modelo: FK a entidad inexistente, sin PK, índice sobre columna inexistente y N:M sin intermedia', () => {
    const contents = clone(CONTENTS);
    const booking = contents.DATA_MODEL.entities[2];
    booking.attributes[1].references.entity = 'Member';
    booking.indexes[0].columns.push('fecha');
    contents.DATA_MODEL.entities[1].attributes[0].primaryKey = false;
    contents.DATA_MODEL.relationships.push({ from: 'User', to: 'GymClass', cardinality: 'N:M', via: null, description: 'x' });
    const messages = errorsOf(contents).map((f) => f.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('entidad inexistente "Member"'),
      expect.stringContaining('GymClass: no tiene clave primaria'),
      expect.stringContaining('columna inexistente "fecha"'),
      expect.stringContaining('necesita una entidad intermedia'),
    ]));
  });

  test('API: entidad fuera del modelo, rol no definido, faltan 401/2xx/400 y parámetro sin documentar', () => {
    const contents = clone(CONTENTS);
    const [e1, e2, e3] = contents.API.endpoints;
    e1.entities.push('Payment');
    e1.responses = [{ status: 200, description: 'ok', body: '' }]; // sin 401
    e2.roles = ['Entrenador'];
    e2.pathParams = [];
    e3.responses = e3.responses.filter((r) => r.status !== 400);
    const findings = errorsOf(contents);
    const messages = findings.map((f) => f.message);
    expect(findings.every((f) => f.stage === 'API')).toBe(true);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('"Payment"'),
      expect.stringContaining('no documenta 401'),
      expect.stringContaining('rol "Entrenador"'),
      expect.stringContaining('parámetro de ruta "classid"'),
      expect.stringContaining('no documenta 400/422'),
    ]));
  });

  test('frontend: endpoint inexistente y navegación a pantalla inexistente', () => {
    const contents = clone(CONTENTS);
    contents.FRONTEND.screens[0].actions[0].endpointId = 'E99';
    contents.FRONTEND.navigation.push({ from: 'S1', to: 'S9', trigger: 'x' });
    const messages = errorsOf(contents).map((f) => f.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('E99'),
      expect.stringContaining('pantalla inexistente "S9"'),
    ]));
  });

  test('advierte endpoints que ninguna pantalla usa y requisitos sin endpoint', () => {
    const contents = clone(CONTENTS);
    contents.FRONTEND.screens[1].actions = [];
    contents.API.endpoints[0].requirementIds = [];
    const warnings = checkConsistency(contents).filter((f) => f.severity === 'warning').map((f) => f.message);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('E3 POST /classes no lo usa ninguna pantalla'),
      expect.stringContaining('RF1 no está cubierto'),
    ]));
  });

  test('arquitectura: debe ser una de las 5 base', () => {
    expect(ARCHITECTURES).toHaveLength(5);
    const contents = clone(CONTENTS);
    contents.ARCHITECTURE.templateId = 'cobol-mainframe';
    expect(errorsOf(contents).map((f) => f.message)).toEqual([expect.stringContaining('cobol-mainframe')]);
  });
});

describe('Diagramas y documentos', () => {
  test('genera ERD y mapa de navegación en Mermaid', () => {
    const er = erDiagram(CONTENTS.DATA_MODEL);
    expect(er).toMatch(/^erDiagram/);
    expect(er).toContain('uuid user_id FK');
    expect(er).toContain('User ||--o{ Booking');
    const nav = navigationDiagram(CONTENTS.FRONTEND);
    expect(nav).toMatch(/^flowchart TD/);
    expect(nav).toContain('S1 -->|"Nueva clase"| S2');
  });

  test('exporta producto.md y arquitectura.md autocontenidos', () => {
    const files = buildExports({
      project: { name: 'GymBook' },
      contents: CONTENTS,
      decisions: [{ text: '¿Lista de espera?', answer: 'No en el MVP', status: 'ANSWERED' }],
      openItems: ['Colores de la marca'],
    });
    expect(files.map((f) => f.name)).toEqual(['producto.md', 'arquitectura.md']);
    const [product, architecture] = files.map((f) => f.content);

    ['Problema', 'Tipos de usuario', 'Alcance del MVP', 'Reglas de negocio', 'Modelo de datos', 'API REST', 'Interfaz'].forEach((section) => {
      expect(product).toContain(section);
    });
    expect(product).toContain('### E2 · `POST /classes/:classId/bookings`');
    expect(product).toContain('**409** — Ya reservada');
    expect(product).toContain('```mermaid\nerDiagram');
    expect(product).toContain('¿Lista de espera?');
    expect(product).toContain('Colores de la marca');
    expect(product).toContain('Pagos en línea');

    ['Base de datos', 'Backend', 'Frontend', 'Autenticación y autorización', 'Despliegue', 'Observabilidad'].forEach((section) => {
      expect(architecture).toContain(section);
    });
    expect(architecture).toContain('SPA React + API Node/Express + PostgreSQL');
    expect(architecture).toContain('| DATABASE_URL |');
  });
});
