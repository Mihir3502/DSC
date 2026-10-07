// Deterministic concurrency barriers for M1.7 race tests (packet M1.7
// §18, §23): a competitor is released only after PostgreSQL shows it
// waiting on a lock, so outcomes never depend on timing or sleeps.
export { waitForLockWait } from "./audit";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
