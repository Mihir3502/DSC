import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionIssuance } from "../domain/session-issuance-policy";

// Server-declared session-issuance intent (packet M1.3, ADR-0004). An
// approved staff command wraps its in-process auth.api call in
// withSessionIssuance; Better Auth's session-creation hook, which runs in
// the same async context, reads it. Nothing from a request can set it, and
// Better Auth HTTP endpoints that could create sessions are closed.

const storage = new AsyncLocalStorage<SessionIssuance>();

export function withSessionIssuance<T>(
  issuance: SessionIssuance,
  run: () => Promise<T>,
): Promise<T> {
  return storage.run(issuance, run);
}

export function currentSessionIssuance(): SessionIssuance | undefined {
  return storage.getStore();
}
