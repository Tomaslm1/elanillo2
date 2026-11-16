// Arquitecturas base entre las que Ideator elige (4 escenarios iniciales + 1 incorporado por el equipo).
// El LLM debe elegir una por `id`, justificarla para el producto y concretar cada decisión.
const ARCHITECTURES = [
  {
    id: 'node-spa-monolith',
    name: 'SPA React + API Node/Express + PostgreSQL',
    bestFor: 'Aplicaciones web CRUD de complejidad baja-media, equipos que dominan JavaScript/TypeScript, MVP rápido.',
    database: 'PostgreSQL 16 con Prisma ORM y migraciones versionadas',
    backend: 'Node.js 20 + Express + TypeScript, capas routes/services/repositories, validación con zod',
    frontend: 'React 18 + Vite + TypeScript, React Router, TanStack Query',
    communication: 'REST/JSON sobre HTTPS; el frontend se sirve como estáticos y llama a /api',
    auth: 'Login local (bcrypt) + SSO OIDC (Google/Microsoft); JWT de acceso corto en cookie HttpOnly + refresh token rotativo en BD',
    deployment: 'Docker multi-stage + docker-compose (app + postgres); ambientes dev/staging/prod vía variables de entorno',
    observability: 'Logs JSON (pino) con request-id, /health y /ready, métricas Prometheus (prom-client)',
  },
  {
    id: 'python-fastapi',
    name: 'API Python FastAPI + PostgreSQL + SPA React',
    bestFor: 'Productos con lógica de datos/IA/procesamiento, equipos Python, necesidad de OpenAPI automático.',
    database: 'PostgreSQL 16 con SQLAlchemy 2 + Alembic',
    backend: 'Python 3.12 + FastAPI + Pydantic v2, routers/services/repositories, tareas en background con Celery+Redis si aplica',
    frontend: 'React 18 + Vite + TypeScript',
    communication: 'REST/JSON con contrato OpenAPI generado por FastAPI',
    auth: 'OAuth2/OIDC con Authlib, JWT en cookie HttpOnly, dependencias de FastAPI para autorización por recurso',
    deployment: 'Docker (uvicorn/gunicorn) + docker-compose; ambientes por variables de entorno (pydantic-settings)',
    observability: 'Logging estructurado (structlog), OpenTelemetry para trazas, /health, métricas Prometheus',
  },
  {
    id: 'nextjs-fullstack',
    name: 'Next.js full-stack (SSR) + PostgreSQL',
    bestFor: 'Productos con contenido público/SEO, equipos pequeños que quieren un solo código para front y back.',
    database: 'PostgreSQL (gestionado, p.ej. Neon/Supabase) con Prisma',
    backend: 'Route Handlers y Server Actions de Next.js 14 (App Router), lógica en /lib/services',
    frontend: 'Next.js 14 App Router + React Server Components + Tailwind',
    communication: 'Server Actions/fetch interno; route handlers REST para clientes externos',
    auth: 'Auth.js (NextAuth) con proveedores OIDC + credenciales, sesión en cookie, middleware de autorización',
    deployment: 'Vercel o contenedor Docker standalone; ambientes preview/staging/prod',
    observability: 'Logs de plataforma + Sentry, health route, métricas de Vercel/OTel',
  },
  {
    id: 'java-spring-enterprise',
    name: 'Spring Boot + PostgreSQL + Angular, con Keycloak',
    bestFor: 'Sistemas corporativos con reglas de negocio complejas, muchos roles, auditoría estricta e integración con IdP empresarial.',
    database: 'PostgreSQL 16 con JPA/Hibernate y Flyway',
    backend: 'Java 21 + Spring Boot 3 (Web, Security, Data JPA, Validation), arquitectura hexagonal',
    frontend: 'Angular 17 + Angular Material',
    communication: 'REST/JSON documentado con springdoc-openapi',
    auth: 'Keycloak como IdP (OIDC/SAML para SSO), JWT bearer validado por Spring Security, autorización con @PreAuthorize por recurso',
    deployment: 'Docker + docker-compose (app, postgres, keycloak); Kubernetes en producción',
    observability: 'Spring Boot Actuator (/actuator/health, métricas Micrometer→Prometheus), logs JSON, trazas OpenTelemetry',
  },
  {
    id: 'supabase-baas',
    name: 'BaaS: Supabase (Postgres + Auth + RLS) + SPA React + Edge Functions',
    bestFor: 'MVP con equipo muy reducido, colaboración en tiempo real, sin necesidad de backend propio complejo. (Escenario incorporado por el equipo.)',
    database: 'PostgreSQL gestionado por Supabase con migraciones SQL (supabase CLI) y Row Level Security por proyecto/rol',
    backend: 'Sin servidor propio: PostgREST autogenerado + Edge Functions (Deno/TypeScript) para lógica que no cabe en SQL/RLS',
    frontend: 'React 18 + Vite + supabase-js, suscripciones Realtime para colaboración',
    communication: 'supabase-js (REST/PostgREST + WebSocket Realtime) directo desde el cliente; Edge Functions vía HTTPS',
    auth: 'Supabase Auth (email+contraseña, SSO OAuth/SAML); JWT con claims usado por las políticas RLS para autorizar cada fila',
    deployment: 'Frontend estático (Vercel/Netlify), Supabase gestionado; ambientes como proyectos Supabase separados',
    observability: 'Logs y métricas del dashboard de Supabase, logs de Edge Functions, health check de Edge Function dedicada',
  },
];

function findArchitecture(id) {
  return ARCHITECTURES.find((architecture) => architecture.id === id);
}

module.exports = { ARCHITECTURES, findArchitecture };
