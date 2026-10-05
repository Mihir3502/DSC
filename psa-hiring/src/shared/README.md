# Shared technical primitives

This directory is reserved for genuine cross-cutting technical code such as authentication helpers, database access, error types, logging, and validation (see [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md), section 12).

Business rules do not belong here; they belong in a module's `domain` or `application` layer under `src/modules/`.

Nothing is implemented yet. Each subdirectory is added by the work item that first needs it.
