# Ideator

Los commits no tienen que ver según quien hizo que parte, dado que hasta el día de la fecha (8 de septiembre), nos equivocamos de repo y lo estabamos desarrollando en un repo que no estaba vinculado con JIRA.

## Qué necesitas instalado

- **Node.js** (versión LTS): https://nodejs.org
- **Docker Desktop**: https://www.docker.com/products/docker-desktop (debe estar **abierto** cuando trabajes)
- **Git** o GitHub Desktop

## Cuando corres el proyecto

Todos los comandos se ejecutan dentro de la carpeta `backend` (en GitHub Desktop: *Repository → Open in Terminal*, y luego `cd backend`).

1. Copia `.env.example` como `.env` (este archivo **nunca** se sube al repo) y completa:
   - `JWT_SECRET`: cualquier texto largo y aleatorio.
   - `AZURE_AI_API_KEY`: la clave de Claude en Azure. Pídela por mensaje privado al equipo
   - `DATABASE_URL` y el resto quedan como vienen en el ejemplo.
2. Instala las dependencias: `npm install`
3. Levanta tu base de datos: `npm run db:up`
4. Crea las tablas: `npx prisma migrate deploy`
5. Genera el cliente de Prisma: `npx prisma generate`
6. Comprueba la conexión: `npm run db:check` (debe decir `Conexión OK` y listar las tablas)
7. Arranca el servidor: `npm start`

Para correr los tests: `npm test`.

## Cada vez que vuelves a trabajar

1. Abre **Docker Desktop** y espera a que diga que está corriendo.
2. `git pull` en tu rama.
3. En `backend`: `npm run db:up`
4. Según lo que haya cambiado al traer los cambios:
   - Si hay carpetas nuevas en `backend/prisma/migrations`: `npx prisma migrate deploy` y luego `npx prisma generate`.
   - Si cambió `package.json`: `npm install`.

Si no sabes qué cambió, correr los tres comandos (`npm install`, `npx prisma migrate deploy`, `npx prisma generate`) no hace daño.

## Si cambias el esquema de la base de datos

1. Edita `backend/prisma/schema.prisma`.
2. Crea la migración: `npm run db:migrate -- --name descripcion_corta_del_cambio`
3. **Sube la carpeta nueva de `prisma/migrations` junto con tu cambio**, para que los demás reciban las mismas tablas.
4. Nunca edites ni borres una migración que ya fue subida: si te equivocaste, crea otra migración que lo corrija.
5. Avisa al equipo antes de hacerlo: si dos personas crean migraciones al mismo tiempo desde distintas ramas, hay que ordenarlas.

## Por qué PostgreSQL con Docker

Elegimos esta opción pensando en que somos un equipo que trabaja en el mismo repo:

- **Cada integrante tiene su propia base de datos.** Así, lo que prueba uno no borra ni rompe los datos de los demás. Lo que sí se comparte es la *estructura* de las tablas, a través de las migraciones que viajan en el repo.
- **Todos usamos exactamente la misma versión y configuración** (PostgreSQL 16), definida en `docker-compose.yml`. Se acaban los problemas del tipo "en mi computador funciona".
- **Es el mismo tipo de base que usaríamos en producción.** Evita sorpresas al desplegar, y el enunciado pide especificar Docker y despliegue en los aspectos operacionales.
- **Se levanta con un solo comando** (`npm run db:up`), lo que también facilita que los evaluadores ejecuten Ideator.

Alternativas que descartamos:

- *SQLite:* no hay que instalar nada, pero se comporta distinto a PostgreSQL en cosas como enums y JSON, y esas diferencias solo aparecen al desplegar.
- *Una base compartida en la nube:* todos escribirían en los mismos datos, un cambio de esquema en una rama rompería a los demás, y los tests podrían borrar datos del resto.

Detalles de la configuración local:

- Las credenciales (`ideator` / `ideator`) son **solo para desarrollo local**; nunca se usan en producción.
- Existe una segunda base, `ideator_test`, reservada para los tests, así las pruebas nunca tocan tus datos de desarrollo.
proyecto usa Prisma 7 |
