import { expect } from "vitest";
import { authorizationDependencies } from "@/modules/identity-access/application/authorization-support";
import { FixedWindowRateLimiter } from "@/modules/identity-access/infrastructure/action-rate-limiter";
import { NonproductionAssignmentHarness } from "@/modules/identity-access/infrastructure/assignment-harness";
import { parseAuthEnv } from "@/modules/identity-access/infrastructure/auth-env";
import { InMemoryEmailCapture } from "@/modules/identity-access/infrastructure/auth-email";
import { createIdentityRuntime } from "@/modules/identity-access/infrastructure/runtime";
import type { SecurityEvent } from "@/modules/identity-access/infrastructure/security-events";
import { NonproductionHarnessGate } from "@/modules/identity-access/infrastructure/staff-administration-gate";
import { createAuditRecorder, type AuditKeyRing } from "@/modules/audit";
import type {
  ConfigurationActor,
  ConfigurationDependencies,
} from "@/modules/organization/application/configuration-runtime";
import {
  changeBranchStatus,
  changeOrganizationStatus,
  changeTeamStatus,
  createBranch,
  createOrganization,
  createTeam,
} from "@/modules/organization/application/commands/hierarchy-commands";
import {
  changePositionStatus,
  createDescriptionDraft,
  createPosition,
  publishDescription,
} from "@/modules/organization/application/commands/position-commands";
import type { ConfigurationResult } from "@/modules/organization/application/commands/result";
import type { PublicDependencies } from "@/modules/organization/application/public-positions";
import {
  findPublicCycle,
  listPublicCycles,
  listPublicLocations,
} from "@/modules/organization/infrastructure/organization-repository";
import type { PublicPositionInvalidator } from "@/modules/organization/infrastructure/public-position-cache";
import { getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../fixtures/canaries";
import { capturingRecorder, type AuthorizationHarness } from "./authorization";

// M2.1 organization integration support. Unlike the M1.4 harness, the
// identity runtime here keeps the REAL organization scope resolver (the
// production default), so organization/branch/team scopes resolve only
// from rows these tests create. The nonproduction assignment harness is
// the bootstrap gate (APP_ENV=test only). Synthetic data only.

export function createOrganizationHarness(
  options: { keys?: AuditKeyRing } = {},
): AuthorizationHarness {
  const capture = new InMemoryEmailCapture();
  const logs = createMemoryDestination();
  const logger = createLogger({ destination: logs });
  const events: SecurityEvent[] = [];
  const durable = createAuditRecorder({
    db: getDatabase(),
    logger,
    ...(options.keys ? { keys: options.keys } : {}),
  });
  const runtime = createIdentityRuntime({
    env: parseAuthEnv(process.env),
    db: getDatabase(),
    logger,
    transport: capture,
    limiter: new FixedWindowRateLimiter(),
    staffAdmin: new NonproductionHarnessGate("test"),
    assignmentHarness: new NonproductionAssignmentHarness(process.env.APP_ENV),
    events: capturingRecorder(durable, events),
  });
  return {
    runtime,
    // The real resolver is in runtime.authorization; this field is unused.
    resolver: undefined as never,
    ownership: undefined as never,
    events,
    logs,
    capture,
  };
}

/** Records post-commit invalidations instead of calling Next.js. */
export function recordingInvalidator(): PublicPositionInvalidator & {
  tags: string[];
} {
  const tags: string[] = [];
  return {
    tags,
    async invalidate(next) {
      tags.push(...next);
    },
  };
}

export function configDeps(
  h: AuthorizationHarness,
  overrides: Partial<ConfigurationDependencies> = {},
): ConfigurationDependencies & {
  invalidator: ReturnType<typeof recordingInvalidator>;
} {
  return {
    ...authorizationDependencies(h.runtime),
    bootstrap: h.runtime.assignmentHarness,
    invalidator: recordingInvalidator(),
    ...overrides,
  } as ConfigurationDependencies & {
    invalidator: ReturnType<typeof recordingInvalidator>;
  };
}

export const bootstrapActor = (accountId: string): ConfigurationActor => ({
  kind: "BOOTSTRAP",
  reason: "TEST_HARNESS",
  accountId,
});

/** A fresh command key (UUID v4). */
export const key = () => crypto.randomUUID();

/** Expects a DONE outcome and returns its target and version. */
export function done(result: ConfigurationResult): {
  id: string;
  version: number;
} {
  if (result.kind !== "DONE") {
    throw new Error(`expected DONE, got ${JSON.stringify(result)}`);
  }
  return { id: result.targetId, version: result.version };
}

export function refused(result: ConfigurationResult): string {
  expect(result.kind).toBe("REFUSED");
  return result.kind === "REFUSED" ? result.reason : "";
}

export const reason = "ROUTINE_CONFIGURATION";

/** Uncached public dependencies over the real repository. */
export function publicDeps(clock: () => Date): PublicDependencies {
  const db = getDatabase();
  return {
    source: {
      list: (q) => listPublicCycles(db, q),
      locations: (now) => listPublicLocations(db, now),
      detail: (ref) => findPublicCycle(db, ref),
    },
    live: (ref) => findPublicCycle(db, ref),
    clock,
  };
}

export type Hierarchy = Readonly<{
  org: string;
  branch: string;
  branch2: string;
  team: string;
  org2: string;
  org2Branch: string;
}>;

/**
 * Provisions two ACTIVE synthetic organizations with branches and a team
 * through the real commands and the bootstrap actor.
 */
export async function provisionHierarchy(
  deps: ConfigurationDependencies,
  actorAccountId: string,
  suffix: string,
): Promise<Hierarchy> {
  const actor = bootstrapActor(actorAccountId);
  const org = async (code: string) => {
    const created = done(
      await createOrganization(
        {
          commandKey: key(),
          code,
          legalName: `TEST Synthetic Agency ${code} LLC`,
          displayName: `TEST Agency ${code}`,
          timezone: "America/New_York",
        },
        actor,
        deps,
      ),
    );
    done(
      await changeOrganizationStatus(
        "activate",
        {
          commandKey: key(),
          targetId: created.id,
          expectedVersion: String(created.version),
          reasonCode: reason,
        },
        actor,
        deps,
      ),
    );
    return created.id;
  };
  const branch = async (organizationId: string, code: string) => {
    const created = done(
      await createBranch(
        {
          commandKey: key(),
          organizationId,
          code,
          name: `TEST Branch ${code}`,
          publicLocationLabel: `Testville ${code}`,
          timezone: "America/New_York",
        },
        actor,
        deps,
      ),
    );
    done(
      await changeBranchStatus(
        "activate",
        {
          commandKey: key(),
          targetId: created.id,
          expectedVersion: String(created.version),
          reasonCode: reason,
        },
        actor,
        deps,
      ),
    );
    return created.id;
  };
  const orgId = await org(`ORG${suffix}`);
  const org2Id = await org(`OTHER${suffix}`);
  const branchId = await branch(orgId, "LEX");
  const branch2Id = await branch(orgId, "LOU");
  const org2BranchId = await branch(org2Id, "LEX");
  const team = done(
    await createTeam(
      {
        commandKey: key(),
        branchId,
        code: "HOME-CARE",
        name: "TEST Home care",
      },
      actor,
      deps,
    ),
  );
  done(
    await changeTeamStatus(
      "activate",
      {
        commandKey: key(),
        targetId: team.id,
        expectedVersion: String(team.version),
        reasonCode: reason,
      },
      actor,
      deps,
    ),
  );
  return {
    org: orgId,
    branch: branchId,
    branch2: branch2Id,
    team: team.id,
    org2: org2Id,
    org2Branch: org2BranchId,
  };
}

/** An ACTIVE position with one PUBLISHED description (bootstrap actor). */
export async function provisionPosition(
  deps: ConfigurationDependencies,
  actorAccountId: string,
  organizationId: string,
  code: string,
  workerPathsAllowed = "W2_AND_CONTRACTOR_ELIGIBLE",
): Promise<{ position: string; description: string }> {
  const actor = bootstrapActor(actorAccountId);
  const position = done(
    await createPosition(
      {
        commandKey: key(),
        organizationId,
        code,
        internalTitle: `TEST internal ${code}`,
        publicTitle: `TEST Caregiver ${code}`,
        workerPathsAllowed,
      },
      actor,
      deps,
    ),
  );
  done(
    await changePositionStatus(
      "activate",
      {
        commandKey: key(),
        targetId: position.id,
        expectedVersion: String(position.version),
        reasonCode: reason,
      },
      actor,
      deps,
    ),
  );
  const draft = done(
    await createDescriptionDraft(
      {
        commandKey: key(),
        positionId: position.id,
        publicTitle: `TEST Caregiver ${code}`,
        summary: "TEST synthetic summary for a personal services role.",
        body: "TEST synthetic description.\n\n- Assist with daily activities\n- Keep accurate notes",
      },
      actor,
      deps,
    ),
  );
  done(
    await publishDescription(
      {
        commandKey: key(),
        targetId: draft.id,
        expectedVersion: String(draft.version),
        reasonCode: reason,
      },
      actor,
      deps,
    ),
  );
  return { position: position.id, description: draft.id };
}
