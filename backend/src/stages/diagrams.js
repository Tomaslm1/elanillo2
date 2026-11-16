// Genera diagramas Mermaid a partir del contenido estructurado.
// Se usan en la UI (render en el navegador) y dentro de los Markdown exportados.

const safeId = (value) => String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_') || 'x';
const safeLabel = (value) => String(value ?? '').replace(/["\n\r]/g, ' ').trim();

const CARDINALITY = {
  '1:1': '||--||',
  '1:N': '||--o{',
};

function erDiagram(model) {
  if (!model?.entities?.length) return '';
  const lines = ['erDiagram'];
  model.entities.forEach((entity) => {
    lines.push(`  ${safeId(entity.name)} {`);
    (entity.attributes || []).forEach((attr) => {
      const keys = [attr.primaryKey && 'PK', attr.references && 'FK', attr.unique && !attr.primaryKey && 'UK'].filter(Boolean).join(',');
      lines.push(`    ${safeId(attr.type)} ${safeId(attr.name)}${keys ? ` ${keys}` : ''}`);
    });
    lines.push('  }');
  });
  (model.relationships || []).forEach((rel) => {
    const label = `"${safeLabel(rel.description).slice(0, 40) || 'rel'}"`;
    if (rel.cardinality === 'N:M' && rel.via) {
      lines.push(`  ${safeId(rel.from)} ||--o{ ${safeId(rel.via)} : ${label}`);
      lines.push(`  ${safeId(rel.to)} ||--o{ ${safeId(rel.via)} : ${label}`);
    } else {
      lines.push(`  ${safeId(rel.from)} ${CARDINALITY[rel.cardinality] || '||--o{'} ${safeId(rel.to)} : ${label}`);
    }
  });
  return lines.join('\n');
}

function navigationDiagram(front) {
  if (!front?.screens?.length) return '';
  const main = new Set((front.mainFlow || []).map(String));
  const lines = ['flowchart TD'];
  front.screens.forEach((screen) => {
    lines.push(`  ${safeId(screen.id)}["${safeLabel(screen.name)}<br/><small>${safeLabel(screen.route)}</small>"]`);
  });
  (front.navigation || []).forEach((nav) => {
    lines.push(`  ${safeId(nav.from)} -->|"${safeLabel(nav.trigger).slice(0, 40)}"| ${safeId(nav.to)}`);
  });
  const mainIds = front.screens.filter((s) => main.has(String(s.id))).map((s) => safeId(s.id));
  if (mainIds.length) {
    lines.push('  classDef main fill:#fdf3d1,stroke:#b8901f,stroke-width:2px,color:#0b1730');
    lines.push(`  class ${mainIds.join(',')} main`);
  }
  return lines.join('\n');
}

module.exports = { erDiagram, navigationDiagram };
