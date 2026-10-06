import { and, desc, eq, inArray } from "drizzle-orm";
import { advanceStaffRecovery } from "../../src/modules/identity-access/application/recover-staff-account";
import { normalizeLoginEmail } from "../../src/modules/identity-access/domain/email";
import { openRecoveryStatuses } from "../../src/modules/identity-access/domain/staff-recovery";
import { findAccountByEmail } from "../../src/modules/identity-access/infrastructure/account-repository";
import { parseAuthEnv } from "../../src/modules/identity-access/infrastructure/auth-env";
import { createIdentityRuntime } from "../../src/modules/identity-access/infrastructure/runtime";
import { NonproductionHarnessGate } from "../../src/modules/identity-access/infrastructure/staff-administration-gate";
import { staffRecoveryCase } from "../../src/modules/identity-access/infrastructure/staff-identity-schema";
import { closeDatabasePool, getDatabase } from "../../src/shared/database";
import { getLogger } from "../../src/shared/logging";
import { runScript } from "../db/lib/tooling";

// Nonproduction staff-recovery harness (packet M1.3 §14.2, AC-M1.3-10).
// Production has no recovery approval/completion route or UI until
// M1.4–M1.6. This command drives one step of the open case for a synthetic
// staff account, acting as another synthetic ACTIVE staff account; the
// domain still enforces self-action and verifier/approver separation. It
// runs only with APP_ENV=local or test and prints result codes only.
//
//   pnpm auth:staff:recovery:local --target=<email> --actor=<email> \
//     --step=START_VERIFICATION|CONFIRM_IDENTITY|APPROVE|REJECT|CANCEL|COMPLETE

const steps = [
  "START_VERIFICATION",
  "CONFIRM_IDENTITY",
  "APPROVE",
  "REJECT",
  "CANCEL",
  "COMPLETE",
] as const;

void runScript("auth:staff:recovery:local", async () => {
  const appEnv = process.env.APP_ENV;
  if (appEnv !== "local" && appEnv !== "test") {
    throw new Error(
      "auth:staff:recovery:local runs only when APP_ENV=local or test",
    );
  }
  const arg = (name: string) =>
    process.argv
      .slice(2)
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3);
  const step = arg("step") as (typeof steps)[number] | undefined;
  const target = arg("target");
  const actorEmail = arg("actor");
  if (!step || !steps.includes(step) || !target || !actorEmail) {
    throw new Error(
      `usage: --target=<email> --actor=<email> --step=${steps.join("|")}`,
    );
  }
  for (const email of [target, actorEmail]) {
    if (!/@(example\.(test|com|org|net)|[a-z0-9-]+\.test)$/i.test(email)) {
      throw new Error("use synthetic reserved-domain addresses only");
    }
  }
  const runtime = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger: getLogger(),
    staffAdmin: new NonproductionHarnessGate(appEnv),
  });
  try {
    const [targetAccount, actor] = await Promise.all([
      findAccountByEmail(runtime.db, normalizeLoginEmail(target).login),
      findAccountByEmail(runtime.db, normalizeLoginEmail(actorEmail).login),
    ]);
    if (!targetAccount || !actor) {
      console.log("auth:staff:recovery:local: NOT_FOUND");
      return;
    }
    const [open] = await runtime.db
      .select({ id: staffRecoveryCase.id })
      .from(staffRecoveryCase)
      .where(
        and(
          eq(staffRecoveryCase.accountId, targetAccount.id),
          inArray(staffRecoveryCase.status, [...openRecoveryStatuses]),
        ),
      )
      .orderBy(desc(staffRecoveryCase.createdAt))
      .limit(1);
    if (!open) {
      console.log("auth:staff:recovery:local: NO_OPEN_CASE");
      return;
    }
    const result = await advanceStaffRecovery(
      {
        caseId: open.id,
        actor: { kind: "ACCOUNT", accountId: actor.id },
        command: step,
      },
      runtime,
    );
    await runtime.email.idle();
    console.log(
      `auth:staff:recovery:local: ${result.kind}${
        "status" in result ? ` ${result.status}` : ""
      }${"reason" in result ? ` ${result.reason}` : ""}`,
    );
  } finally {
    await closeDatabasePool();
  }
});
