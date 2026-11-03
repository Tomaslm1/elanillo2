# Modelo de datos colaborativo (SCRUM-48)

Formato en el que Ideator guarda el modelo de datos de un proyecto. Es el **contrato** para quienes generan el modelo (SCRUM-44), lo dibujan (SCRUM-46) o le agregan restricciones (SCRUM-47): si algo no calza, se ajusta aquí.

## Formato

```json
{
  "entities": [
    {
      "id": "uuid",
      "name": "Pedido",
      "attributes": [
        { "id": "uuid", "name": "id", "type": "uuid", "required": true, "primaryKey": true },
        { "id": "uuid", "name": "total", "type": "decimal", "required": true, "primaryKey": false }
      ],
      "version": 1
    }
  ],
  "relations": [
    { "id": "uuid", "from": "<id de entidad>", "to": "<id de entidad>", "type": "one_to_many", "name": "realiza", "version": 1 }
  ],
  "revision": 3
}
```

- **Tipos de atributo:** `string`, `text`, `integer`, `decimal`, `boolean`, `date`, `datetime`, `uuid`, `json`.
- **Tipos de relación:** `one_to_one`, `one_to_many`, `many_to_many`. `from` y `to` son ids de entidades que existen (puede ser la misma entidad).
- **Límites:** nombres de hasta 60 caracteres; máximo 50 entidades, 30 atributos por entidad y 150 relaciones.
- Los nombres de entidad no se repiten (sin distinguir mayúsculas); tampoco los atributos dentro de una entidad.

## Endpoints

Todos bajo `/api/projects/:projectId/model` y con sesión iniciada. Cualquier miembro puede leer; solo `owner` y `editor` pueden modificar (`viewer` recibe 403). Quien no es miembro recibe 404.

| Método y ruta | Qué hace |
|---|---|
| `GET /model` | Devuelve `model`, `validation`, `attributeTypes`, `relationTypes` y `canEdit` |
| `GET /model?since=N` | Si `N` es la revisión actual responde `{ "changed": false, "revision": N }`; si no, el modelo completo. Sirve para que el frontend consulte cada pocos segundos y refleje los cambios de otros |
| `POST /model/entities` | Crea una entidad: `{ name, attributes? }` |
| `PUT /model/entities/:id` | Edita: `{ name, attributes?, version }` (si no se envían atributos se conservan; si se envían, reemplazan a los anteriores) |
| `DELETE /model/entities/:id?version=N` | Elimina la entidad **y sus relaciones**; la respuesta trae `removedRelations` |
| `POST /model/relations` | Crea una relación: `{ from, to, type, name? }` |
| `PUT /model/relations/:id` | Edita: `{ from, to, type, name?, version }` |
| `DELETE /model/relations/:id?version=N` | Elimina la relación |

## Edición concurrente

Cada entidad y cada relación tiene su `version`. Para editar o eliminar hay que enviar la versión que se vio. Si alguien la cambió antes, la respuesta es **409** con `code: "VERSION_CONFLICT"` y el valor actual en `current`, y no se guarda nada. Dos personas que editan cosas distintas no se bloquean entre sí.

Otros 409: `DUPLICATE_NAME` (entidad con nombre repetido) y `DUPLICATE_RELATION`.

## Validación tras cada edición

Cada respuesta exitosa incluye `revision` y `validation: { valid, issues }`.

- **Errores de forma** (nombre vacío, tipo desconocido, relación hacia una entidad inexistente...): la edición se rechaza con **400** y no se guarda.
- **Avisos de diseño** (`issues`, nivel `warning`): la edición se guarda, porque un modelo a medio hacer es normal. Códigos: `ENTITY_WITHOUT_ATTRIBUTES`, `ENTITY_WITHOUT_PRIMARY_KEY`, `ENTITY_WITHOUT_RELATIONS`.
- `valid` es `false` solo si hay un `error` (por ejemplo `ORPHAN_RELATION`), algo que las rutas impiden.

## Pendiente

- Los datos viven en memoria, igual que resultados y requisitos; pasan a la base de datos junto con ellos.
- SCRUM-49 (pantalla de edición) consume estos endpoints.
