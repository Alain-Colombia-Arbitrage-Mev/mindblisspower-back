# Modules

Cada subdirectorio es un dominio del negocio. Convención por módulo:

```
<dominio>/
├── api.ts           # handlers HTTP (Hono routes) — solo orquestación
├── service.ts       # lógica de negocio, sin Hono ni HTTP
├── repository.ts    # queries Drizzle/SQL — única capa que toca db
├── validators.ts    # zod schemas para input/output
├── jobs.ts          # workers BullMQ específicos del dominio (si aplica)
├── events.ts        # eventos internos que el módulo emite/escucha
└── README.md        # qué hace, invariantes, entradas/salidas
```

**Reglas:**

1. Un módulo solo importa de `shared/*` y de **`events.ts`** de otros módulos.
2. Nunca un módulo lee la DB de otro directamente — cruza siempre por `service.ts` (vía evento o llamada explícita).
3. `repository.ts` es el único archivo que importa `drizzle-orm`. Si necesitas SQL crudo, va aquí.
4. `api.ts` parsea con zod, llama service, formatea respuesta. Nada de lógica de negocio en handlers.
5. Tests viven en `src/tests/` espejados (`tests/integration/identity.test.ts` para `modules/identity/`).

Ver `_meta/BACKEND_PLAN.md §3` para el catálogo completo de módulos y sus responsabilidades.
