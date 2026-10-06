import { AsyncLocalStorage } from "node:async_hooks";

// Per-request context for server-side code running in the Node.js runtime.
// AsyncLocalStorage keeps each request's correlation ID isolated across
// concurrent requests without any module-level mutable request state.

export type RequestContext = Readonly<{ correlationId: string }>;

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(Object.freeze({ ...context }), fn);
}

/** The current request context, or undefined outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
