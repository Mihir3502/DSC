import { reconcileCandidateWorkItems } from "../../src/modules/candidates/application/reconcile-work-items";
import { authorizationDependencies } from "../../src/modules/identity-access/application/authorization-support";
import { closeDatabasePool } from "../../src/shared/database";

// Opens missing candidate tasks and cancels stale ones (packet M2.3 §11).
// Prints counts only. Safe to repeat.

const counts = await reconcileCandidateWorkItems(authorizationDependencies());
console.log(
  `work items reconciled: ${counts.opened} opened, ${counts.canceled} canceled`,
);
await closeDatabasePool();
