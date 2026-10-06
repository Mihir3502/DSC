import { createInterface } from "node:readline/promises";
import { and, eq } from "drizzle-orm";
import {
  issueStaffInvitation,
  revokeStaffInvitation,
} from "../../src/modules/identity-access/application/issue-staff-invitation";
import { normalizeLoginEmail } from "../../src/modules/identity-access/domain/email";
import { parseAuthEnv } from "../../src/modules/identity-access/infrastructure/auth-env";
import { createIdentityRuntime } from "../../src/modules/identity-access/infrastructure/runtime";
import { NonproductionHarnessGate } from "../../src/modules/identity-access/infrastructure/staff-administration-gate";
import { staffInvitation } from "../../src/modules/identity-access/infrastructure/staff-identity-schema";
import { closeDatabasePool, getDatabase } from "../../src/shared/database";
import { getLogger } from "../../src/shared/logging";
import { runScript } from "../db/lib/tooling";

// Nonproduction staff-invitation harness (packet M1.3 §7.3, AC-M1.3-03).
// The running application has no invitation-issuance route or UI until
// M1.4–M1.6 add authorization and immutable audit. This command:
//
// - runs only with APP_ENV=local or test (the harness gate refuses to be
//   constructed anywhere else, so it fails closed in staging/production);
// - accepts exactly one synthetic reserved-domain email, by argument or an
//   interactive prompt, and never prints or logs it;
// - requires an explicit reason code (stored on the invitation);
// - sends the invitation through the configured local email transport
//   (Mailpit locally, file capture in tests) and never prints the link.
//
//   pnpm auth:staff:invite:local --reason=LOCAL_BOOTSTRAP [email]
//   pnpm auth:staff:invite:local --reason=LOCAL_BOOTSTRAP --revoke [email]

const reasons = {
  LOCAL_BOOTSTRAP: ["local", "test"],
  TEST_HARNESS: ["test"],
} as const;
type Reason = keyof typeof reasons;

void runScript("auth:staff:invite:local", async () => {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "local" && appEnv !== "test") {
    throw new Error(
      "auth:staff:invite:local runs only when APP_ENV=local or test",
    );
  }
  const args = process.argv.slice(2);
  const reason = args
    .find((a) => a.startsWith("--reason="))
    ?.slice("--reason=".length) as Reason | undefined;
  if (!reason || !Object.hasOwn(reasons, reason)) {
    throw new Error(
      "a reason is required: --reason=LOCAL_BOOTSTRAP (or TEST_HARNESS in test)",
    );
  }
  if (!(reasons[reason] as readonly string[]).includes(appEnv)) {
    throw new Error(`--reason=${reason} is not allowed when APP_ENV=${appEnv}`);
  }
  const revoke = args.includes("--revoke");
  let email = args.find((a) => !a.startsWith("--"));
  if (!email) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    email = (await prompt.question("Synthetic staff email: ")).trim();
    prompt.close();
  }
  if (!/@(example\.(test|com|org|net)|[a-z0-9-]+\.test)$/i.test(email)) {
    throw new Error(
      "use a synthetic reserved-domain address (*.test or example.*)",
    );
  }

  const runtime = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger: getLogger(),
    staffAdmin: new NonproductionHarnessGate(appEnv),
  });
  const actor = { kind: "BOOTSTRAP", reason } as const;
  try {
    if (revoke) {
      const { login } = normalizeLoginEmail(email);
      const [pending] = await runtime.db
        .select({ id: staffInvitation.id })
        .from(staffInvitation)
        .where(
          and(
            eq(staffInvitation.email, login),
            eq(staffInvitation.status, "PENDING"),
          ),
        )
        .limit(1);
      const result = pending
        ? await revokeStaffInvitation(
            { invitationId: pending.id, actor },
            runtime,
          )
        : { kind: "NOT_FOUND" as const };
      console.log(`auth:staff:invite:local revoke: ${result.kind}`);
      return;
    }
    const result = await issueStaffInvitation({ email, actor }, runtime);
    await runtime.email.idle();
    console.log(
      result.kind === "ACCEPTED"
        ? `auth:staff:invite:local: request accepted (transport ${runtime.env.AUTH_EMAIL_TRANSPORT}). If the address can be invited, the email is in Mailpit/capture; nothing else is printed.`
        : `auth:staff:invite:local: ${result.kind}`,
    );
  } finally {
    await closeDatabasePool();
  }
});
