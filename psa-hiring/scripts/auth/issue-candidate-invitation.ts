import { issueCandidateInvitation } from "../../src/modules/identity-access";
import { closeDatabasePool } from "../../src/shared/database";
import { runScript } from "../db/lib/tooling";

// Local/test-only helper (packet M1.2 §22): issues one single-use candidate
// invitation for a synthetic reserved-domain email and prints the
// registration link. Staff invitation issuance with authorization arrives in
// M1.3+. Refuses to run outside APP_ENV=local|test and for non-reserved
// domains, so it can never mint a capability for a real address.
//
//   pnpm auth:intent:local test.candidate@example.test

void runScript("auth:intent:local", async () => {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "local" && appEnv !== "test") {
    throw new Error("auth:intent:local runs only when APP_ENV=local or test");
  }
  const email = process.argv[2] ?? "";
  if (!/@(example\.(test|com|org|net)|[a-z0-9-]+\.test)$/i.test(email)) {
    throw new Error(
      "use a synthetic reserved-domain address (*.test or example.*)",
    );
  }
  try {
    const link = await issueCandidateInvitation(email);
    console.log(link);
  } finally {
    await closeDatabasePool();
  }
});
