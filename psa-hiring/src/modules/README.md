# Business modules

Release 1 business modules live here, one directory per module (for example `candidates`, `classification`, `readiness`). No modules exist yet; they are added by later work items.

Each module follows the layer boundaries in [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) (sections 5, 6, and 12):

- `domain/` — aggregates, policies, and workflow rules. No Next.js, React, ORM, auth, or vendor imports.
- `application/` — commands, queries, use-case handlers, and port interfaces.
- `infrastructure/` — adapters that implement ports (database, providers).
- `ui/` — module-specific presentation that calls the application layer.
- `index.ts` — the module's public API. Other modules import only from here.

Do not create empty module directories ahead of the work item that needs them.
