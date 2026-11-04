import { dispatchApplicationEmails } from "../../src/modules/applications/application/application-outbox";
import { authorizationDependencies } from "../../src/modules/identity-access/application/authorization-support";
import { closeDatabasePool } from "../../src/shared/database";

// Retries application-received emails that weren't delivered right after
// submission (packet M2.6). Prints counts only. Safe to repeat.

const counts = await dispatchApplicationEmails(authorizationDependencies());
console.log(
  `outbox: ${counts.sent} sent, ${counts.retrying} retrying, ${counts.failed} failed`,
);
await closeDatabasePool();
