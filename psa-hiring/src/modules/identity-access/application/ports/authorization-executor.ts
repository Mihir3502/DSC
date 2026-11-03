import { AsyncLocalStorage } from "node:async_hooks";

// The database executor of the authorization decision in progress (M2.2
// defect fix). authorizeInTransaction binds its transaction here so the
// database-backed scope, placement, and ownership adapters read through
// the SAME transaction instead of taking a second pooled connection. A
// command that already holds a connection (and row locks other commands
// wait on) can then never starve the pool waiting for its own resolver.
// Outside a transaction the adapters fall back to the pool.
//
// Dependency-free on purpose: adapters in other modules import it without
// creating an evaluation cycle with the identity runtime.

const executor = new AsyncLocalStorage<unknown>();

export function withAuthorizationExecutor<T>(
  tx: unknown,
  run: () => Promise<T>,
): Promise<T> {
  return executor.run(tx, run);
}

/** The bound transaction executor, or undefined outside one. */
export function currentAuthorizationExecutor<T>(): T | undefined {
  return executor.getStore() as T | undefined;
}
