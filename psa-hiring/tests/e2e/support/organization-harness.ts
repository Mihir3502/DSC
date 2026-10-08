import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  authorizationDependencies,
  roleAssignmentDependencies,
} from "@/modules/identity-access/application/authorization-support";
import {
  approveRoleAssignment,
  proposeRoleAssignment,
} from "@/modules/identity-access/application/role-assignments";
import type {
  RoleCode,
  ScopeType,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { NonproductionAssignmentHarness } from "@/modules/identity-access/infrastructure/assignment-harness";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import { createIdentityRuntime } from "@/modules/identity-access/infrastructure/runtime";
import {
  changeBranchStatus,
  changeOrganizationStatus,
  changeTeamStatus,
  createBranch,
  createOrganization,
  createTeam,
} from "@/modules/organization/application/commands/hierarchy-commands";
import {
  createHiringCycle,
  transitionHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import {
  changePositionStatus,
  createDescriptionDraft,
  createPosition,
  publishDescription,
} from "@/modules/organization/application/commands/position-commands";
import type { ConfigurationResult } from "@/modules/organization/application/commands/result";
import type {
  ConfigurationActor,
  ConfigurationDependencies,
} from "@/modules/organization/application/configuration-runtime";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";

// Browser-test provisioning harness for M2.1 (APP_ENV=test only). Creates
// synthetic hierarchy, positions, and hiring cycles through the REAL
// commands with the nonproduction bootstrap actor, and grants staff roles
// through the real role-assignment commands. It lives under tests/ (never
// scripts/ or src/), refuses any other environment, and prints only opaque
// identifiers and public references as JSON.

if (process.env.APP_ENV !== "test") {
  throw new Error(
    "the organization browser harness runs only with APP_ENV=test",
  );
}

const logger = createLogger({ destination: { write: () => undefined } });
const runtime = createIdentityRuntime({
  env: parseAuthEnv(process.env),
  db: getDatabase(),
  logger,
  assignmentHarness: new NonproductionAssignmentHarness(process.env.APP_ENV),
});
const deps: ConfigurationDependencies = {
  ...authorizationDependencies(runtime),
  bootstrap: runtime.assignmentHarness,
  invalidator: { invalidate: async () => undefined },
};

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: process.env.DATABASE_ADMIN_URL,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function bootstrapAccount(label: string): Promise<string> {
  return admin(async (c) => {
    const email = `test.e2e.${label}.${randomUUID()}@example.test`;
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
       VALUES ('TEST bootstrap actor', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
      [email, email],
    );
    return rows[0]!.id;
  });
}

function done(result: ConfigurationResult) {
  if (result.kind !== "DONE")
    throw new Error(`harness command: ${result.kind}`);
  return { id: result.targetId, version: result.version };
}

const key = () => randomUUID();
const reason = "ROUTINE_CONFIGURATION";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const actor: ConfigurationActor = {
    kind: "BOOTSTRAP",
    reason: "TEST_HARNESS",
    accountId: await bootstrapAccount("org-harness"),
  };
  const status = (id: string, version: number, code = reason) => ({
    commandKey: key(),
    targetId: id,
    expectedVersion: String(version),
    reasonCode: code,
  });
  let output: unknown;
  switch (command) {
    case "provision": {
      const suffix = args[0]!;
      const org = done(
        await createOrganization(
          {
            commandKey: key(),
            code: `E2E${suffix}`,
            legalName: `TEST E2E Agency ${suffix} LLC`,
            displayName: `TEST E2E Agency ${suffix}`,
            timezone: "America/New_York",
          },
          actor,
          deps,
        ),
      );
      done(
        await changeOrganizationStatus(
          "activate",
          status(org.id, org.version),
          actor,
          deps,
        ),
      );
      const branch = done(
        await createBranch(
          {
            commandKey: key(),
            organizationId: org.id,
            code: "LEX",
            name: `TEST Lexington ${suffix}`,
            publicLocationLabel: `Lexington ${suffix}`,
            timezone: "America/New_York",
          },
          actor,
          deps,
        ),
      );
      done(
        await changeBranchStatus(
          "activate",
          status(branch.id, branch.version),
          actor,
          deps,
        ),
      );
      const team = done(
        await createTeam(
          {
            commandKey: key(),
            branchId: branch.id,
            code: "HOME",
            name: "TEST Home care",
          },
          actor,
          deps,
        ),
      );
      done(
        await changeTeamStatus(
          "activate",
          status(team.id, team.version),
          actor,
          deps,
        ),
      );
      output = { org: org.id, branch: branch.id, team: team.id };
      break;
    }
    case "position": {
      const [organizationId, code, title] = args as [string, string, string];
      const position = done(
        await createPosition(
          {
            commandKey: key(),
            organizationId,
            code,
            internalTitle: `TEST internal ${code}`,
            publicTitle: title,
            workerPathsAllowed: "W2_AND_CONTRACTOR_ELIGIBLE",
          },
          actor,
          deps,
        ),
      );
      done(
        await changePositionStatus(
          "activate",
          status(position.id, position.version),
          actor,
          deps,
        ),
      );
      const draft = done(
        await createDescriptionDraft(
          {
            commandKey: key(),
            positionId: position.id,
            publicTitle: title,
            summary:
              "TEST Support adults at home with daily activities & companionship.",
            body: 'TEST You will help clients with daily routines.\n\n- Lift < 25 lb with "safe lifting" technique\n- Keep accurate visit notes',
          },
          actor,
          deps,
        ),
      );
      done(
        await publishDescription(status(draft.id, draft.version), actor, deps),
      );
      output = { position: position.id, description: draft.id };
      break;
    }
    case "cycle": {
      const [positionId, branchId, state, closesInMinutes] = args as [
        string,
        string,
        string,
        string,
      ];
      const opens = new Date(Date.now() - 3_600_000);
      const closes = new Date(Date.now() + Number(closesInMinutes) * 60_000);
      const cycle = done(
        await createHiringCycle(
          {
            commandKey: key(),
            positionId,
            branchId,
            code: `E2E-${randomUUID().slice(0, 8)}`.toUpperCase(),
            internalLabel: "TEST internal cycle label E2E",
            opensAt: toZonedLocal(opens, "America/New_York"),
            closesAt: toZonedLocal(closes, "America/New_York"),
          },
          actor,
          deps,
        ),
      );
      let version = cycle.version;
      if (state !== "draft") {
        version = done(
          await transitionHiringCycle(
            "publish",
            status(cycle.id, version),
            actor,
            deps,
          ),
        ).version;
      }
      if (state === "open") {
        version = done(
          await transitionHiringCycle(
            "open",
            status(cycle.id, version),
            actor,
            deps,
          ),
        ).version;
      }
      const ref = await admin(
        async (c) =>
          (
            await c.query<{ public_reference: string }>(
              "SELECT public_reference FROM app.hiring_cycle WHERE id = $1",
              [cycle.id],
            )
          ).rows[0]!.public_reference,
      );
      output = { cycle: cycle.id, ref, version };
      break;
    }
    case "grant": {
      const [email, role, scopeType, scopeId] = args as [
        string,
        RoleCode,
        ScopeType,
        string,
      ];
      const subject = await admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              'SELECT id FROM auth."user" WHERE email = $1',
              [email.toLowerCase()],
            )
          ).rows[0]!.id,
      );
      const creator = {
        kind: "BOOTSTRAP" as const,
        reason: "TEST_HARNESS" as const,
        accountId: await bootstrapAccount("grant-creator"),
      };
      const approver = {
        kind: "BOOTSTRAP" as const,
        reason: "TEST_HARNESS" as const,
        accountId: await bootstrapAccount("grant-approver"),
      };
      const proposed = await proposeRoleAssignment(
        {
          subjectAccountId: subject,
          roleCode: role,
          scopeType,
          scopeReferenceId: scopeId,
          effectiveFrom: new Date(Date.now() - 60_000),
          effectiveTo: null,
          reasonCode: "NEW_ACCESS",
          reasonReference: "TEST-E2E",
        },
        creator,
        roleAssignmentDependencies(runtime),
      );
      if (proposed.kind !== "PROPOSED")
        throw new Error(`grant: ${proposed.kind}`);
      const approved = await approveRoleAssignment(
        { assignmentId: proposed.assignmentId, expectedVersion: 1 },
        approver,
        roleAssignmentDependencies(runtime),
      );
      if (approved.kind !== "APPROVED")
        throw new Error(`grant: ${approved.kind}`);
      output = { granted: true };
      break;
    }
    default:
      throw new Error("unknown harness command");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `organization harness failed: ${(error as Error).message}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
