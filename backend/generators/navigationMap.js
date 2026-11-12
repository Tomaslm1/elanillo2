// SCRUM-60: mapa de navegación entre pantallas, según el recorrido principal definido.
// Entrada: pantallas, recorrido principal (lista ordenada de ids) y transiciones extra.
// Salida: nodos con posición (para dibujarlos), conexiones, avisos y el mismo mapa en Mermaid
// (para pegarlo en los documentos Markdown).

const LIMITS = { screens: 60, name: 60, description: 200, transitions: 200, label: 40 };
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const text = (value) => String(value ?? '').trim();

function validateNavigationSpec(data) {
  if (!Array.isArray(data?.screens) || data.screens.length === 0) return { error: 'Define al menos una pantalla en "screens"' };
  if (data.screens.length > LIMITS.screens) return { error: `No puede haber más de ${LIMITS.screens} pantallas` };

  const screens = [];
  for (const item of data.screens) {
    const id = text(item?.id);
    const name = text(item?.name);
    if (!ID_PATTERN.test(id)) return { error: `El id de pantalla "${id.slice(0, 20)}" no es válido (minúsculas, números, - y _; máximo 40)` };
    if (screens.some((screen) => screen.id === id)) return { error: `El id de pantalla "${id}" está repetido` };
    if (!name || name.length > LIMITS.name) return { error: `La pantalla "${id}" necesita un nombre de hasta ${LIMITS.name} caracteres` };
    const description = text(item?.description);
    if (description.length > LIMITS.description) return { error: `La descripción de "${id}" supera ${LIMITS.description} caracteres` };
    screens.push({ id, name, description });
  }
  const ids = new Set(screens.map((screen) => screen.id));

  const mainFlow = data.mainFlow === undefined ? [] : data.mainFlow;
  if (!Array.isArray(mainFlow)) return { error: '"mainFlow" debe ser una lista de ids de pantalla' };
  const cleanFlow = mainFlow.map(text);
  const unknown = cleanFlow.find((id) => !ids.has(id));
  if (unknown !== undefined) return { error: `El recorrido principal usa una pantalla que no existe: "${unknown}"` };

  const rawTransitions = data.transitions === undefined ? [] : data.transitions;
  if (!Array.isArray(rawTransitions)) return { error: '"transitions" debe ser una lista' };
  if (rawTransitions.length > LIMITS.transitions) return { error: `No puede haber más de ${LIMITS.transitions} transiciones` };
  const transitions = [];
  for (const item of rawTransitions) {
    const from = text(item?.from);
    const to = text(item?.to);
    if (!ids.has(from) || !ids.has(to)) return { error: `La transición "${from}" → "${to}" usa una pantalla que no existe` };
    const label = text(item?.label);
    if (label.length > LIMITS.label) return { error: `La etiqueta de la transición "${from}" → "${to}" supera ${LIMITS.label} caracteres` };
    transitions.push({ from, to, label });
  }
  return { data: { screens, mainFlow: cleanFlow, transitions } };
}

const mermaidText = (value) => value.replace(/["\n]/g, ' ').trim();
const safeId = (id) => `s_${id.replace(/[^a-z0-9_]/g, '_')}`;

function generateNavigationMap(spec) {
  const { screens, mainFlow, transitions } = spec;

  // Conexiones: el recorrido principal une pantallas consecutivas; las transiciones extra se suman.
  const edges = [];
  const addEdge = (from, to, label, kind) => {
    const existing = edges.find((edge) => edge.from === from && edge.to === to);
    if (existing) {
      // Si ya existe (por ejemplo, por el recorrido principal) se conserva su tipo; solo se completa la etiqueta.
      if (!existing.label && label) existing.label = label;
      return;
    }
    edges.push({ from, to, label, kind });
  };
  for (let i = 0; i < mainFlow.length - 1; i += 1) addEdge(mainFlow[i], mainFlow[i + 1], '', 'main');
  for (const transition of transitions) addEdge(transition.from, transition.to, transition.label, 'secondary');

  // Niveles por recorrido en anchura desde la pantalla de inicio (la primera del recorrido principal).
  const start = mainFlow[0] || screens[0].id;
  const level = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const edge of edges.filter((e) => e.from === current)) {
      if (!level.has(edge.to)) {
        level.set(edge.to, level.get(current) + 1);
        queue.push(edge.to);
      }
    }
  }
  const maxLevel = Math.max(...level.values());
  const unreachable = screens.filter((screen) => !level.has(screen.id));
  unreachable.forEach((screen) => level.set(screen.id, maxLevel + 1));

  // Posición: una columna por nivel; las pantallas del mismo nivel se apilan.
  const perLevel = new Map();
  const nodes = screens.map((screen) => {
    const lvl = level.get(screen.id);
    const row = perLevel.get(lvl) || 0;
    perLevel.set(lvl, row + 1);
    return {
      id: screen.id,
      name: screen.name,
      description: screen.description,
      level: lvl,
      x: lvl * 240,
      y: row * 120,
      isStart: screen.id === start,
      reachable: !unreachable.includes(screen),
    };
  });

  // Avisos de diseño
  const issues = [];
  if (mainFlow.length < 2) {
    issues.push({ level: 'warning', code: 'NO_MAIN_FLOW', message: 'El recorrido principal necesita al menos dos pantallas' });
  }
  for (const screen of unreachable) {
    issues.push({ level: 'warning', code: 'UNREACHABLE_SCREEN', screenId: screen.id, message: `No hay forma de llegar a "${screen.name}" desde la pantalla de inicio` });
  }
  const lastOfFlow = mainFlow[mainFlow.length - 1];
  for (const screen of screens) {
    const hasOutgoing = edges.some((edge) => edge.from === screen.id);
    if (!hasOutgoing && screen.id !== lastOfFlow && !unreachable.includes(screen)) {
      issues.push({ level: 'warning', code: 'DEAD_END', screenId: screen.id, message: `"${screen.name}" no lleva a ninguna otra pantalla` });
    }
  }

  // Mermaid: línea gruesa para el recorrido principal, fina para el resto.
  const lines = ['flowchart LR'];
  for (const screen of screens) lines.push(`  ${safeId(screen.id)}["${mermaidText(screen.name)}"]`);
  for (const edge of edges) {
    const arrow = edge.kind === 'main' ? '==>' : '-->';
    const label = edge.label ? `|${mermaidText(edge.label)}|` : '';
    lines.push(`  ${safeId(edge.from)} ${arrow}${label} ${safeId(edge.to)}`);
  }

  return { nodes, edges, start, issues, mermaid: lines.join('\n') };
}

module.exports = { validateNavigationSpec, generateNavigationMap };
