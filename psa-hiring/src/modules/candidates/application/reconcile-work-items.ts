import "server-only";
import {
  reconcileWorkItems,
  type Executor,
} from "../infrastructure/candidates-repository";
import type { CandidateDependencies } from "./candidate-runtime";

// Operator reconciliation for candidate tasks (packet M2.3 §11, §22). It is
// bounded and safe to repeat, changes only work items, never pretends a person
// acted, and reports counts alone. A failure leaves nothing changed.

export async function reconcileCandidateWorkItems(
  deps: Pick<CandidateDependencies, "db" | "logger">,
  limit = 500,
): Promise<Readonly<{ opened: number; canceled: number }>> {
  const counts = await deps.db.transaction((tx) =>
    reconcileWorkItems(tx as unknown as Executor, limit),
  );
  deps.logger.info("candidates.work_items_reconciled", {
    module: "candidates",
    resultCode: counts.opened + counts.canceled > 0 ? "changed" : "unchanged",
  });
  return counts;
}
