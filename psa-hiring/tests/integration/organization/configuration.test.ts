import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAuditRecorder } from "@/modules/audit";
import { proposeRoleAssignment } from "@/modules/identity-access/application/role-assignments";
import {
  changeBranchStatus,
  changeOrganizationStatus,
  changeTeamStatus,
  createBranch,
  createOrganization,
  updateBranchDetails,
  updateOrganizationDetails,
  updateTeamDetails,
} from "@/modules/organization/application/commands/hierarchy-commands";
import {
  createHiringCycle,
  transitionHiringCycle,
  updateHiringCycleDraft,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import {
  changePositionStatus,
  createDescriptionDraft,
  createPosition,
  publishDescription,
  updateDescriptionDraftContent,
  updatePositionDetails,
} from "@/modules/organization/application/commands/position-commands";
import type { ConfigurationActor } from "@/modules/organization/application/configuration-runtime";
import {
  beginApplicationHandoff,
  confirmApplicationHandoff,
  queryHandoffOpening,
  queryPublicPosition,
  queryPublicPositions,
} from "@/modules/organization/application/public-positions";
import {
  queryCycleDetail,
  queryHierarchy,
  queryPositionDetail,
  queryPositionList,
} from "@/modules/organization/application/staff-queries";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import { verifyApplicationHandoff } from "@/modules/identity-access/application/registration-intents";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../fixtures/canaries";
import { deferred, waitForLockWait } from "../support/barriers";
import { failingKeys, verify } from "../support/audit";
import {
  activateStaff,
  assignmentDeps,
  bootstrap,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  signIn,
  stepUp,
  type AuthorizationHarness,
  type BootstrapPair,
  type StaffSession,
} from "../support/authorization";
import type { OwnedDatabase } from "../support/harness";
import {
  bootstrapActor,
  configDeps,
  createOrganizationHarness,
  done,
  key,
  provisionHierarchy,
  provisionPosition,
  publicDeps,
  reason,
  refused,
  type Hierarchy,
} from "../support/organization";

// M2.1 configuration commands, real scope resolution, authorization,
// lifecycle, snapshots, availability, idempotency, concurrency, audit, and
// handoff (packet M2.1 §9–§21, §28, §30; AC-M2.1-02/03/04/05/06/07/08/09/
// 10/11/12/15/16). Staff are real MFA accounts with real role grants on
// real hierarchy rows; scope resolves only through the production
// organization adapter. Synthetic data only.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let deps: ReturnType<typeof configDeps>;
let pair: BootstrapPair;
let tree: Hierarchy;
const staff: Record<string, StaffSession> = {};
const as = (name: string): ConfigurationActor => ({
  kind: "ACCOUNT",
  principal: staff[name]!.principal,
});
const boot = () => bootstrapActor(pair.creator);

type AuditRow = {
  event_name: string;
  actor_type: string;
  actor_user_id: string | null;
  effective_role_code: string | null;
  organization_id: string | null;
  reason_code: string | null;
  metadata_json: Record<string, unknown>;
  new_record_version: number | null;
};

async function eventsFor(targetId: string): Promise<AuditRow[]> {
  const { rows } = await admin.query<AuditRow>(
    `SELECT event_name, actor_type, actor_user_id, effective_role_code, organization_id,
            reason_code, metadata_json, new_record_version
       FROM audit.audit_event WHERE target_id = $1 ORDER BY chain_sequence`,
    [targetId],
  );
  return rows;
}

const names = async (targetId: string) =>
  (await eventsFor(targetId)).map((r) => r.event_name);

const statusInput = (id: string, version: number, code = reason) => ({
  commandKey: key(),
  targetId: id,
  expectedVersion: String(version),
  reasonCode: code,
});

/** "YYYY-MM-DDTHH:mm" in New York for an instant (form input shape). */
const local = (d: Date) => toZonedLocal(d, "America/New_York");

async function draftCycle(
  positionId: string,
  window: { opens: Date; closes: Date | null },
  actor: ConfigurationActor = boot(),
  placement: { branchId: string; teamId?: string } = { branchId: tree.branch },
) {
  return done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId,
        ...placement,
        code: `C-${randomUUID().slice(0, 8)}`.toUpperCase(),
        internalLabel: "TEST internal cycle label",
        opensAt: local(window.opens),
        ...(window.closes
          ? { closesAt: local(window.closes) }
          : { openEnded: "yes" }),
      },
      actor,
      deps,
    ),
  );
}

async function openCycle(positionId: string, closes: Date | null) {
  const cycle = await draftCycle(positionId, {
    opens: new Date(Date.now() - 3_600_000),
    closes,
  });
  const published = done(
    await transitionHiringCycle(
      "publish",
      statusInput(cycle.id, cycle.version),
      boot(),
      deps,
    ),
  );
  const opened = done(
    await transitionHiringCycle(
      "open",
      statusInput(cycle.id, published.version),
      boot(),
      deps,
    ),
  );
  const { rows } = await admin.query<{ public_reference: string }>(
    "SELECT public_reference FROM app.hiring_cycle WHERE id = $1",
    [cycle.id],
  );
  return {
    id: cycle.id,
    version: opened.version,
    ref: rows[0]!.public_reference,
  };
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "org_config",
  ));
  h = createOrganizationHarness();
  deps = configDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(deps, pair.creator, "CFG");

  const accounts = {
    manager: await activateStaff(h, "org-manager"),
    hr: await activateStaff(h, "org-hr"),
    hrBranch: await activateStaff(h, "org-hr-branch"),
    recruiter: await activateStaff(h, "org-recruiter"),
    administrator: await activateStaff(h, "org-admin"),
    otherManager: await activateStaff(h, "org-other-manager"),
  };
  await grant(
    h,
    pair,
    accounts.manager.accountId,
    "PSA_MANAGER",
    "ORGANIZATION",
    tree.org,
  );
  await grant(
    h,
    pair,
    accounts.hr.accountId,
    "HR_SPECIALIST",
    "ORGANIZATION",
    tree.org,
  );
  await grant(
    h,
    pair,
    accounts.hrBranch.accountId,
    "HR_SPECIALIST",
    "BRANCH",
    tree.branch2,
  );
  await grant(
    h,
    pair,
    accounts.recruiter.accountId,
    "RECRUITER",
    "ORGANIZATION",
    tree.org,
  );
  await grant(
    h,
    pair,
    accounts.administrator.accountId,
    "SYSTEM_ADMINISTRATOR",
    "ORGANIZATION",
    tree.org,
  );
  await grant(
    h,
    pair,
    accounts.otherManager.accountId,
    "PSA_MANAGER",
    "ORGANIZATION",
    tree.org2,
  );
  for (const [name, member] of Object.entries(accounts)) {
    staff[name] = await signIn(h, member);
  }
  // Only the manager steps up (recent auth for approval commands).
  (staff as Record<string, unknown>).managerMember = accounts.manager;
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) {
    const { dropOwnedDatabase } = await import("../support/harness");
    await dropOwnedDatabase(ctx, db.name);
  }
});

// ------------------------------------------------------- real scope

describe("real organization scope resolution (AC-M2.1-02)", () => {
  it("assigns roles only to real ACTIVE hierarchy and refuses missing, draft, and disallowed scopes", async () => {
    const subject = staff.recruiter!.principal.accountId;
    const propose = (
      scopeType: "ORGANIZATION" | "BRANCH",
      id: string,
      role = "HR_SPECIALIST",
    ) =>
      proposeRoleAssignment(
        {
          subjectAccountId: subject,
          roleCode: role,
          scopeType,
          scopeReferenceId: id,
          effectiveFrom: new Date(Date.now() - 60_000),
          effectiveTo: null,
          reasonCode: "NEW_ACCESS",
          reasonReference: "TEST-TICKET-2",
        },
        bootstrap(pair.creator),
        assignmentDeps(h),
      );
    expect(await propose("ORGANIZATION", randomUUID())).toEqual({
      kind: "REFUSED",
      reason: "SCOPE_UNRESOLVED",
    });
    // A branch ID is not an organization (wrong type).
    expect(await propose("ORGANIZATION", tree.branch)).toEqual({
      kind: "REFUSED",
      reason: "SCOPE_UNRESOLVED",
    });
    const draftOrg = done(
      await createOrganization(
        {
          commandKey: key(),
          code: "DRAFTORG",
          legalName: "TEST Draft Org LLC",
          displayName: "TEST Draft Org",
          timezone: "America/Chicago",
        },
        boot(),
        deps,
      ),
    );
    expect(await propose("ORGANIZATION", draftOrg.id)).toEqual({
      kind: "REFUSED",
      reason: "SCOPE_UNRESOLVED",
    });
    // The auditor never holds an organization scope (D1 pair rule).
    expect(
      await propose("ORGANIZATION", tree.org, "AUDITOR_READ_ONLY"),
    ).toEqual({
      kind: "REFUSED",
      reason: "SCOPE_NOT_ALLOWED_FOR_ROLE",
    });
  });

  it("removes a branch-scoped role's authority as soon as its branch is inactive", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "BRANCHSCOPE",
    );
    const allowed = await draftCycle(
      position,
      {
        opens: new Date(Date.now() + 86_400_000),
        closes: new Date(Date.now() + 2 * 86_400_000),
      },
      as("hrBranch"),
      { branchId: tree.branch2 },
    );
    expect(allowed.version).toBe(1);
    // Outside its branch: denied.
    expect(
      refused(
        await createHiringCycle(
          {
            commandKey: key(),
            positionId: position,
            branchId: tree.branch,
            code: "HRB-OUT",
            internalLabel: "TEST",
            opensAt: local(new Date(Date.now() + 86_400_000)),
            closesAt: local(new Date(Date.now() + 2 * 86_400_000)),
          },
          as("hrBranch"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
    const { rows } = await admin.query<{ version: number }>(
      "SELECT version FROM app.branch WHERE id = $1",
      [tree.branch2],
    );
    const inactive = done(
      await changeBranchStatus(
        "inactivate",
        statusInput(tree.branch2, rows[0]!.version),
        boot(),
        deps,
      ),
    );
    expect(
      refused(
        await updateHiringCycleDraft(
          {
            commandKey: key(),
            cycleId: allowed.id,
            expectedVersion: "1",
            code: "HRB-EDIT",
            internalLabel: "TEST",
            opensAt: local(new Date(Date.now() + 86_400_000)),
            closesAt: local(new Date(Date.now() + 2 * 86_400_000)),
          },
          as("hrBranch"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
    done(
      await changeBranchStatus(
        "activate",
        statusInput(tree.branch2, inactive.version),
        boot(),
        deps,
      ),
    );
  });
});

// ------------------------------------------------------ authorization

describe("staff configuration authorization (AC-M2.1-09)", () => {
  it("lets HR create and edit drafts in scope but never activate, publish, or open", async () => {
    const created = done(
      await createPosition(
        {
          commandKey: key(),
          organizationId: tree.org,
          code: "HR-DRAFT",
          internalTitle: "TEST HR draft",
          publicTitle: "TEST Public HR draft",
          workerPathsAllowed: "W2_ONLY",
        },
        as("hr"),
        deps,
      ),
    );
    done(
      await updatePositionDetails(
        {
          commandKey: key(),
          positionId: created.id,
          expectedVersion: "1",
          code: "HR-DRAFT",
          internalTitle: "TEST HR draft edited",
          publicTitle: "TEST Public HR draft",
          workerPathsAllowed: "W2_AND_CONTRACTOR_ELIGIBLE",
        },
        as("hr"),
        deps,
      ),
    );
    expect(
      refused(
        await changePositionStatus(
          "activate",
          statusInput(created.id, 2),
          as("hr"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
    const draft = done(
      await createDescriptionDraft(
        {
          commandKey: key(),
          positionId: created.id,
          publicTitle: "TEST HR description",
          summary: "TEST summary",
          body: "TEST body",
        },
        as("hr"),
        deps,
      ),
    );
    expect(
      refused(
        await publishDescription(
          statusInput(draft.id, draft.version),
          as("hr"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
    // Branch-scoped HR cannot create organization-level positions.
    expect(
      refused(
        await createPosition(
          {
            commandKey: key(),
            organizationId: tree.org,
            code: "HRB-POS",
            internalTitle: "TEST",
            publicTitle: "TEST",
            workerPathsAllowed: "W2_ONLY",
          },
          as("hrBranch"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
  });

  it("denies recruiters, technical administrators, and managers of another organization", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "DENYALL",
    );
    for (const name of ["recruiter", "administrator", "otherManager"]) {
      expect(
        refused(
          await createPosition(
            {
              commandKey: key(),
              organizationId: tree.org,
              code: `DENY-${name.length}`,
              internalTitle: "TEST",
              publicTitle: "TEST",
              workerPathsAllowed: "W2_ONLY",
            },
            as(name),
            deps,
          ),
        ),
        name,
      ).toBe("NOT_AUTHORIZED");
      expect(
        refused(
          await changePositionStatus(
            "retire",
            statusInput(position, 2),
            as(name),
            deps,
          ),
        ),
        name,
      ).toBe("NOT_AUTHORIZED");
    }
    // Nothing changed.
    const { rows } = await admin.query(
      "SELECT status FROM app.position WHERE id = $1",
      [position],
    );
    expect(rows[0].status).toBe("ACTIVE");
  });

  it("requires recent authentication for approval commands and then allows the scoped manager", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "STEPUP",
    );
    const cycle = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    expect(
      refused(
        await transitionHiringCycle(
          "publish",
          statusInput(cycle.id, cycle.version),
          as("manager"),
          deps,
        ),
      ),
    ).toBe("REAUTHENTICATION_REQUIRED");
    const member = (staff as Record<string, unknown>)
      .managerMember as Parameters<typeof stepUp>[1];
    await stepUp(h, member, staff.manager!, "CONFIGURATION_CHANGE");
    const published = done(
      await transitionHiringCycle(
        "publish",
        statusInput(cycle.id, cycle.version),
        as("manager"),
        deps,
      ),
    );
    const events = await eventsFor(cycle.id);
    const publishedEvent = events.find(
      (e) => e.event_name === "hiring_cycle.published",
    )!;
    expect(publishedEvent.actor_type).toBe("USER");
    expect(publishedEvent.actor_user_id).toBe(
      staff.manager!.principal.accountId,
    );
    expect(publishedEvent.effective_role_code).toBe("PSA_MANAGER");
    expect(publishedEvent.reason_code).toBe(reason);
    expect(publishedEvent.organization_id).toBe(tree.org);
    // Another organization's manager is denied even with a fresh session.
    expect(
      refused(
        await transitionHiringCycle(
          "open",
          statusInput(cycle.id, published.version),
          as("otherManager"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
  });
});

// ------------------------------------------------ hierarchy commands

describe("hierarchy lifecycle and audit (AC-M2.1-01, AC-M2.1-12)", () => {
  it("records each hierarchy event exactly once with codes-only metadata", async () => {
    const org = done(
      await createOrganization(
        {
          commandKey: key(),
          code: "EVTORG",
          legalName: "TEST Event Org LLC",
          displayName: "TEST Event Org",
          timezone: "America/New_York",
        },
        boot(),
        deps,
      ),
    );
    const orgActive = done(
      await changeOrganizationStatus(
        "activate",
        statusInput(org.id, org.version),
        boot(),
        deps,
      ),
    );
    const orgEdited = done(
      await updateOrganizationDetails(
        {
          commandKey: key(),
          organizationId: org.id,
          expectedVersion: String(orgActive.version),
          code: "EVTORG",
          legalName: "TEST Event Org Renamed LLC",
          displayName: "TEST Event Org",
          timezone: "America/New_York",
        },
        boot(),
        deps,
      ),
    );
    const branch = done(
      await createBranch(
        {
          commandKey: key(),
          organizationId: org.id,
          code: "EVTB",
          name: "TEST Event Branch",
          publicLocationLabel: "Testville",
          timezone: "America/New_York",
        },
        boot(),
        deps,
      ),
    );
    const branchActive = done(
      await changeBranchStatus(
        "activate",
        statusInput(branch.id, branch.version),
        boot(),
        deps,
      ),
    );
    const branchEdited = done(
      await updateBranchDetails(
        {
          commandKey: key(),
          branchId: branch.id,
          expectedVersion: String(branchActive.version),
          code: "EVTB",
          name: "TEST Event Branch Renamed",
          publicLocationLabel: "Testville",
          timezone: "America/New_York",
        },
        boot(),
        deps,
      ),
    );
    const { createTeam } =
      await import("@/modules/organization/application/commands/hierarchy-commands");
    const team = done(
      await createTeam(
        {
          commandKey: key(),
          branchId: branch.id,
          code: "EVTT",
          name: "TEST Team",
        },
        boot(),
        deps,
      ),
    );
    const teamActive = done(
      await changeTeamStatus(
        "activate",
        statusInput(team.id, team.version),
        boot(),
        deps,
      ),
    );
    const teamEdited = done(
      await updateTeamDetails(
        {
          commandKey: key(),
          teamId: team.id,
          expectedVersion: String(teamActive.version),
          code: "EVTT",
          name: "TEST Team Renamed",
        },
        boot(),
        deps,
      ),
    );
    done(
      await changeTeamStatus(
        "inactivate",
        statusInput(team.id, teamEdited.version),
        boot(),
        deps,
      ),
    );
    done(
      await changeBranchStatus(
        "inactivate",
        statusInput(branch.id, branchEdited.version),
        boot(),
        deps,
      ),
    );
    done(
      await changeOrganizationStatus(
        "inactivate",
        statusInput(org.id, orgEdited.version),
        boot(),
        deps,
      ),
    );

    expect(await names(org.id)).toEqual([
      "organization.created",
      "organization.activated",
      "organization.updated",
      "organization.inactivated",
    ]);
    expect(await names(branch.id)).toEqual([
      "branch.created",
      "branch.activated",
      "branch.updated",
      "branch.inactivated",
    ]);
    expect(await names(team.id)).toEqual([
      "team.created",
      "team.activated",
      "team.updated",
      "team.inactivated",
    ]);
    for (const row of [
      ...(await eventsFor(org.id)),
      ...(await eventsFor(branch.id)),
      ...(await eventsFor(team.id)),
    ]) {
      expect(row.organization_id).toBe(org.id);
      expect(row.actor_type).toBe("SYSTEM");
      expect(
        Object.keys(row.metadata_json).every((k) =>
          ["changed_fields", "policy_version"].includes(k),
        ),
      ).toBe(true);
      expect(JSON.stringify(row.metadata_json)).not.toMatch(
        /TEST|Testville|America/,
      );
    }
    const updated = (await eventsFor(org.id)).find(
      (e) => e.event_name === "organization.updated",
    )!;
    expect(updated.metadata_json.changed_fields).toEqual(["NAME"]);
  });

  it("refuses activating a child under an inactive parent and keeps codes stable after activation", async () => {
    const { rows } = await admin.query<{ version: number; status: string }>(
      "SELECT version, status FROM app.organization WHERE code = 'EVTORG'",
    );
    expect(rows[0]!.status).toBe("INACTIVE");
    const branch = done(
      await createBranch(
        {
          commandKey: key(),
          organizationId: (
            await admin.query(
              "SELECT id FROM app.organization WHERE code = 'EVTORG'",
            )
          ).rows[0].id,
          code: "LATE",
          name: "TEST Late",
          publicLocationLabel: "Testville",
          timezone: "UTC",
        },
        boot(),
        deps,
      ),
    );
    expect(
      refused(
        await changeBranchStatus(
          "activate",
          statusInput(branch.id, branch.version),
          boot(),
          deps,
        ),
      ),
    ).toBe("PARENT_NOT_ACTIVE");
    expect(
      refused(
        await updateBranchDetails(
          {
            commandKey: key(),
            branchId: tree.branch,
            expectedVersion: String(
              (
                await admin.query(
                  "SELECT version FROM app.branch WHERE id = $1",
                  [tree.branch],
                )
              ).rows[0].version,
            ),
            code: "RENAMED",
            name: "TEST",
            publicLocationLabel: "Testville",
            timezone: "UTC",
          },
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("rejects duplicate codes, invalid timezones, and unsafe names without partial state", async () => {
    expect(
      refused(
        await createBranch(
          {
            commandKey: key(),
            organizationId: tree.org,
            code: "lex",
            name: "TEST dup",
            publicLocationLabel: "Testville",
            timezone: "UTC",
          },
          boot(),
          deps,
        ),
      ),
    ).toBe("DUPLICATE_CODE");
    const invalid = await createBranch(
      {
        commandKey: key(),
        organizationId: tree.org,
        code: "NEWB",
        name: "<b>TEST</b>",
        publicLocationLabel: "Testville",
        timezone: "Mars/Olympus",
      },
      boot(),
      deps,
    );
    expect(invalid).toEqual({
      kind: "INVALID_INPUT",
      fields: { name: "UNSAFE_CONTENT", timezone: "INVALID_TIMEZONE" },
    });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM app.branch WHERE code = 'NEWB'",
    );
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------- positions, descriptions, and snapshots

describe("positions, immutable descriptions, and published snapshots (AC-M2.1-03/04/07)", () => {
  it("allocates unique monotonic versions, supersedes on publish, and records each description event once", async () => {
    const { position, description: v1 } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "VERSIONS",
    );
    const v2 = done(
      await createDescriptionDraft(
        {
          commandKey: key(),
          positionId: position,
          publicTitle: "TEST v2",
          summary: "TEST v2 summary",
          body: "TEST v2 body",
        },
        boot(),
        deps,
      ),
    );
    // One draft at a time.
    expect(
      refused(
        await createDescriptionDraft(
          {
            commandKey: key(),
            positionId: position,
            publicTitle: "TEST v3",
            summary: "s",
            body: "b",
          },
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const edited = done(
      await updateDescriptionDraftContent(
        {
          commandKey: key(),
          descriptionId: v2.id,
          expectedVersion: "1",
          publicTitle: "TEST v2 edited",
          summary: "TEST v2 summary",
          body: "TEST v2 body",
        },
        boot(),
        deps,
      ),
    );
    done(
      await publishDescription(
        statusInput(v2.id, edited.version),
        boot(),
        deps,
      ),
    );
    // Published content cannot be edited through the command either.
    expect(
      refused(
        await updateDescriptionDraftContent(
          {
            commandKey: key(),
            descriptionId: v2.id,
            expectedVersion: String(edited.version + 1),
            publicTitle: "x",
            summary: "x",
            body: "x",
          },
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const { rows } = await admin.query<{
      id: string;
      version_number: number;
      status: string;
    }>(
      "SELECT id, version_number, status FROM app.job_description_version WHERE position_id = $1 ORDER BY version_number",
      [position],
    );
    expect(rows.map((r) => [r.version_number, r.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, "PUBLISHED"],
    ]);
    expect(await names(v1)).toEqual([
      "job_description.draft_created",
      "job_description.published",
      "job_description.superseded",
    ]);
    expect(await names(v2.id)).toEqual([
      "job_description.draft_created",
      "job_description.updated",
      "job_description.published",
    ]);
  });

  it("serializes concurrent draft creation: exactly one draft and one version number", async () => {
    const created = done(
      await createPosition(
        {
          commandKey: key(),
          organizationId: tree.org,
          code: "RACE-DRAFT",
          internalTitle: "TEST",
          publicTitle: "TEST",
          workerPathsAllowed: "W2_ONLY",
        },
        boot(),
        deps,
      ),
    );
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.position WHERE id = $1 FOR UPDATE", [
      created.id,
    ]);
    const race = [1, 2].map(() =>
      createDescriptionDraft(
        {
          commandKey: key(),
          positionId: created.id,
          publicTitle: "TEST race",
          summary: "TEST",
          body: "TEST",
        },
        boot(),
        deps,
      ),
    );
    const { connect } = await import("../support/audit");
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const results = await Promise.all(race);
    expect(results.filter((r) => r.kind === "DONE")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "REFUSED")).toHaveLength(1);
    const { rows } = await admin.query(
      "SELECT version_number FROM app.job_description_version WHERE position_id = $1",
      [created.id],
    );
    expect(rows.map((r) => r.version_number)).toEqual([1]);
  });

  it("keeps a published cycle's snapshot when the position and description change later", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "SNAPSHOT",
      "W2_AND_CONTRACTOR_ELIGIBLE",
    );
    const opened = await openCycle(position, new Date(Date.now() + 86_400_000));
    const before = await queryPublicPosition(
      opened.ref,
      publicDeps(() => new Date()),
    );
    expect(before.kind).toBe("FOUND");
    const pos = (
      await admin.query("SELECT version FROM app.position WHERE id = $1", [
        position,
      ])
    ).rows[0];
    const updated = done(
      await updatePositionDetails(
        {
          commandKey: key(),
          positionId: position,
          expectedVersion: String(pos.version),
          code: "SNAPSHOT",
          internalTitle: "TEST changed internal",
          publicTitle: "TEST Changed Public Title",
          workerPathsAllowed: "W2_ONLY",
        },
        boot(),
        deps,
      ),
    );
    expect(await names(position)).toContain("position.updated");
    expect(
      (await eventsFor(position)).find(
        (e) => e.event_name === "position.updated",
      )!.metadata_json.changed_fields,
    ).toEqual(["TITLE", "WORKER_PATHS"]);
    const draft = done(
      await createDescriptionDraft(
        {
          commandKey: key(),
          positionId: position,
          publicTitle: "TEST Rewritten Title",
          summary: "TEST rewritten summary",
          body: "TEST rewritten body",
        },
        boot(),
        deps,
      ),
    );
    done(
      await publishDescription(
        statusInput(draft.id, draft.version),
        boot(),
        deps,
      ),
    );
    expect(updated.version).toBeGreaterThan(1);
    const after = await queryPublicPosition(
      opened.ref,
      publicDeps(() => new Date()),
    );
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toMatch(/Rewritten|Changed Public/);
  });

  it("records position lifecycle events and never lets a retired position return", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "LIFECYCLE",
    );
    const pos = (
      await admin.query("SELECT version FROM app.position WHERE id = $1", [
        position,
      ])
    ).rows[0];
    const inactive = done(
      await changePositionStatus(
        "inactivate",
        statusInput(position, pos.version),
        boot(),
        deps,
      ),
    );
    const retired = done(
      await changePositionStatus(
        "retire",
        statusInput(position, inactive.version),
        boot(),
        deps,
      ),
    );
    expect(
      refused(
        await changePositionStatus(
          "activate",
          statusInput(position, retired.version),
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    expect(await names(position)).toEqual([
      "position.created",
      "position.activated",
      "position.inactivated",
      "position.retired",
    ]);
  });
});

// -------------------------------------------- hiring-cycle lifecycle

describe("hiring-cycle lifecycle, boundaries, and races (AC-M2.1-05/06/08)", () => {
  it("records every hiring-cycle event once and refuses reopening after close, cancel, or archive", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "CYCLES",
    );
    const cycle = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    const edited = done(
      await updateHiringCycleDraft(
        {
          commandKey: key(),
          cycleId: cycle.id,
          expectedVersion: String(cycle.version),
          code: "CYCLE-EDITED",
          internalLabel: "TEST edited label",
          publicLabel: "TEST Public Opening",
          opensAt: local(new Date(Date.now() - 3_600_000)),
          closesAt: local(new Date(Date.now() + 86_400_000)),
        },
        boot(),
        deps,
      ),
    );
    const published = done(
      await transitionHiringCycle(
        "publish",
        statusInput(cycle.id, edited.version),
        boot(),
        deps,
      ),
    );
    const opened = done(
      await transitionHiringCycle(
        "open",
        statusInput(cycle.id, published.version),
        boot(),
        deps,
      ),
    );
    expect(
      refused(
        await transitionHiringCycle(
          "open",
          statusInput(cycle.id, opened.version),
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const closed = done(
      await transitionHiringCycle(
        "close",
        statusInput(cycle.id, opened.version, "POSITIONS_FILLED"),
        boot(),
        deps,
      ),
    );
    for (const command of ["publish", "open", "cancel"] as const) {
      expect(
        refused(
          await transitionHiringCycle(
            command,
            statusInput(
              cycle.id,
              closed.version,
              command === "cancel" ? "NO_LONGER_NEEDED" : reason,
            ),
            boot(),
            deps,
          ),
        ),
        command,
      ).toBe("INVALID_TRANSITION");
    }
    const archived = done(
      await transitionHiringCycle(
        "archive",
        statusInput(cycle.id, closed.version),
        boot(),
        deps,
      ),
    );
    expect(
      refused(
        await transitionHiringCycle(
          "open",
          statusInput(cycle.id, archived.version),
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const other = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    done(
      await transitionHiringCycle(
        "cancel",
        statusInput(other.id, other.version, "PUBLISHED_IN_ERROR"),
        boot(),
        deps,
      ),
    );
    expect(await names(cycle.id)).toEqual([
      "hiring_cycle.created",
      "hiring_cycle.updated",
      "hiring_cycle.published",
      "hiring_cycle.opened",
      "hiring_cycle.closed",
      "hiring_cycle.archived",
    ]);
    expect(await names(other.id)).toEqual([
      "hiring_cycle.created",
      "hiring_cycle.cancelled",
    ]);
    const closedEvent = (await eventsFor(cycle.id)).find(
      (e) => e.event_name === "hiring_cycle.closed",
    )!;
    expect(closedEvent.reason_code).toBe("POSITIONS_FILLED");
  });

  it("refuses publish with a draft-only description, a cross-organization placement, or a team outside the branch", async () => {
    const created = done(
      await createPosition(
        {
          commandKey: key(),
          organizationId: tree.org,
          code: "NODESC",
          internalTitle: "TEST",
          publicTitle: "TEST",
          workerPathsAllowed: "W2_ONLY",
        },
        boot(),
        deps,
      ),
    );
    done(
      await changePositionStatus(
        "activate",
        statusInput(created.id, created.version),
        boot(),
        deps,
      ),
    );
    done(
      await createDescriptionDraft(
        {
          commandKey: key(),
          positionId: created.id,
          publicTitle: "TEST",
          summary: "TEST",
          body: "TEST",
        },
        boot(),
        deps,
      ),
    );
    const cycle = await draftCycle(created.id, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    expect(
      refused(
        await transitionHiringCycle(
          "publish",
          statusInput(cycle.id, cycle.version),
          boot(),
          deps,
        ),
      ),
    ).toBe("DESCRIPTION_NOT_PUBLISHED");
    const { rows } = await admin.query(
      "SELECT status, published_at FROM app.hiring_cycle WHERE id = $1",
      [cycle.id],
    );
    expect(rows[0]).toEqual({ status: "DRAFT", published_at: null });
    expect(
      refused(
        await createHiringCycle(
          {
            commandKey: key(),
            positionId: created.id,
            branchId: tree.org2Branch,
            code: "CROSS-ORG",
            internalLabel: "TEST",
            opensAt: local(new Date()),
            closesAt: local(new Date(Date.now() + 86_400_000)),
          },
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      refused(
        await createHiringCycle(
          {
            commandKey: key(),
            positionId: created.id,
            branchId: tree.branch2,
            teamId: tree.team,
            code: "CROSS-TEAM",
            internalLabel: "TEST",
            opensAt: local(new Date()),
            closesAt: local(new Date(Date.now() + 86_400_000)),
          },
          boot(),
          deps,
        ),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("opens only inside the window: refused 1 ms before opens_at, allowed at exactly opens_at", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "BOUNDARY",
    );
    const opensAt = new Date(
      Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000,
    );
    const cycle = await draftCycle(position, {
      opens: opensAt,
      closes: new Date(opensAt.getTime() + 3_600_000),
    });
    const published = done(
      await transitionHiringCycle(
        "publish",
        statusInput(cycle.id, cycle.version),
        boot(),
        deps,
      ),
    );
    const early = { ...deps, clock: () => new Date(opensAt.getTime() - 1) };
    expect(
      refused(
        await transitionHiringCycle(
          "open",
          statusInput(cycle.id, published.version),
          boot(),
          early,
        ),
      ),
    ).toBe("WINDOW_NOT_OPEN");
    const exact = { ...deps, clock: () => new Date(opensAt.getTime()) };
    done(
      await transitionHiringCycle(
        "open",
        statusInput(cycle.id, published.version),
        boot(),
        exact,
      ),
    );
  });

  it("stops accepting at exactly closes_at without any close command or cache refresh", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "CLOSING",
    );
    const closesAt = new Date(
      Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000,
    );
    const opened = await openCycle(position, closesAt);
    const at = (t: number) => publicDeps(() => new Date(t));
    const before = await queryPublicPosition(
      opened.ref,
      at(closesAt.getTime() - 1),
    );
    expect(before.kind === "FOUND" && before.view.availability).toBe(
      "ACCEPTING",
    );
    const exact = await queryPublicPosition(opened.ref, at(closesAt.getTime()));
    expect(exact).toEqual({
      kind: "FOUND",
      view: { reference: opened.ref, availability: "NO_LONGER_ACCEPTING" },
    });
    expect(JSON.stringify(exact)).not.toMatch(/TEST Caregiver|summary/);
    const list = await queryPublicPositions({}, at(closesAt.getTime()));
    expect(
      list.kind === "OK" && list.view.items.map((i) => i.reference),
    ).not.toContain(opened.ref);
    const handoff = await beginApplicationHandoff(
      opened.ref,
      new Headers(),
      at(closesAt.getTime()),
    );
    expect(handoff).toEqual({ kind: "NOT_AVAILABLE" });
    const { rows } = await admin.query(
      "SELECT status FROM app.hiring_cycle WHERE id = $1",
      [opened.id],
    );
    expect(rows[0].status).toBe("OPEN");
  });

  it("rechecks parents inside the transaction: publish racing a branch inactivation is refused", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "RACE-PARENT",
    );
    const cycle = await draftCycle(
      position,
      {
        opens: new Date(Date.now() - 3_600_000),
        closes: new Date(Date.now() + 86_400_000),
      },
      boot(),
      { branchId: tree.branch2 },
    );
    await admin.query("BEGIN");
    await admin.query(
      "UPDATE app.branch SET status = 'INACTIVE', inactivated_at = now(), version = version + 1 WHERE id = $1",
      [tree.branch2],
    );
    const publishing = transitionHiringCycle(
      "publish",
      statusInput(cycle.id, cycle.version),
      boot(),
      deps,
    );
    const { connect } = await import("../support/audit");
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 1);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    expect(refused(await publishing)).toBe("PARENT_NOT_ACTIVE");
    await admin.query(
      "UPDATE app.branch SET status = 'ACTIVE', inactivated_at = NULL, version = version + 1 WHERE id = $1",
      [tree.branch2],
    );
    const { rows } = await admin.query(
      "SELECT status FROM app.hiring_cycle WHERE id = $1",
      [cycle.id],
    );
    expect(rows[0].status).toBe("DRAFT");
  });

  it("lets exactly one of two competing transitions with the same version win", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "RACE-CLOSE",
    );
    const opened = await openCycle(position, new Date(Date.now() + 86_400_000));
    const gate = deferred();
    await admin.query("BEGIN");
    await admin.query(
      "SELECT 1 FROM app.hiring_cycle WHERE id = $1 FOR UPDATE",
      [opened.id],
    );
    const close = transitionHiringCycle(
      "close",
      statusInput(opened.id, opened.version, "NO_LONGER_NEEDED"),
      boot(),
      deps,
    );
    const cancel = transitionHiringCycle(
      "cancel",
      statusInput(opened.id, opened.version, "NO_LONGER_NEEDED"),
      boot(),
      deps,
    );
    const { connect } = await import("../support/audit");
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    gate.resolve();
    const results = await Promise.all([close, cancel]);
    expect(results.filter((r) => r.kind === "DONE")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.kind === "REFUSED")
        .map((r) => r.kind === "REFUSED" && r.reason),
    ).toEqual(["STALE_VERSION"]);
    const events = (await names(opened.id)).filter(
      (n) => n === "hiring_cycle.closed" || n === "hiring_cycle.cancelled",
    );
    expect(events).toHaveLength(1);
  });
});

// --------------------------------------------- idempotency and audit

describe("idempotency, stale versions, atomic audit, and cache invalidation (AC-M2.1-12)", () => {
  it("returns the recorded result for a retried command key with one effect and one event", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "IDEMPOTENT",
    );
    const cycle = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    const input = statusInput(cycle.id, cycle.version);
    const first = done(
      await transitionHiringCycle("publish", input, boot(), deps),
    );
    const retry = await transitionHiringCycle("publish", input, boot(), deps);
    expect(retry).toEqual({
      kind: "DONE",
      targetId: cycle.id,
      version: first.version,
      replayed: true,
    });
    expect(
      (await names(cycle.id)).filter((n) => n === "hiring_cycle.published"),
    ).toHaveLength(1);
    // The same key for another command is refused.
    expect(
      refused(await transitionHiringCycle("open", input, boot(), deps)),
    ).toBe("COMMAND_KEY_CONFLICT");
    // A stale expected version changes nothing.
    expect(
      refused(
        await transitionHiringCycle(
          "open",
          statusInput(cycle.id, cycle.version),
          boot(),
          deps,
        ),
      ),
    ).toBe("STALE_VERSION");
  });

  it("rolls the configuration back when the audit append fails", async () => {
    const failing = configDeps(h, {
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    });
    await expect(
      createPosition(
        {
          commandKey: key(),
          organizationId: tree.org,
          code: "AUDIT-FAIL",
          internalTitle: "TEST",
          publicTitle: "TEST",
          workerPathsAllowed: "W2_ONLY",
        },
        boot(),
        failing,
      ),
    ).rejects.toThrow();
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM app.position WHERE code = 'AUDIT-FAIL'",
    );
    expect(rows[0].n).toBe(0);
    expect(failing.invalidator.tags).toEqual([]);
  });

  it("invalidates public cache tags only after a committed public-affecting change", async () => {
    const recorder = configDeps(h);
    const { position } = await provisionPosition(
      recorder,
      pair.creator,
      tree.org,
      "CACHE",
    );
    const cycle = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    recorder.invalidator.tags.length = 0;
    const published = done(
      await transitionHiringCycle(
        "publish",
        statusInput(cycle.id, cycle.version),
        boot(),
        recorder,
      ),
    );
    const { rows } = await admin.query<{ public_reference: string }>(
      "SELECT public_reference FROM app.hiring_cycle WHERE id = $1",
      [cycle.id],
    );
    expect(recorder.invalidator.tags).toEqual([
      "public-positions",
      `public-position:${rows[0]!.public_reference}`,
    ]);
    recorder.invalidator.tags.length = 0;
    refused(
      await transitionHiringCycle(
        "open",
        statusInput(cycle.id, cycle.version),
        boot(),
        recorder,
      ),
    );
    expect(recorder.invalidator.tags).toEqual([]);
    done(
      await transitionHiringCycle(
        "open",
        statusInput(cycle.id, published.version),
        boot(),
        recorder,
      ),
    );
    expect(recorder.invalidator.tags).toContain("public-positions");
  });

  it("leaves every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});

// ------------------------------------------------ public and handoff

describe("public projections and the start-application handoff (AC-M2.1-10/11/15/16)", () => {
  it("lists and shows only the exact public projection of accepting cycles", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "PUBLIC",
    );
    const opened = await openCycle(position, new Date(Date.now() + 86_400_000));
    const draft = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    const now = () => new Date();
    const list = await queryPublicPositions({}, publicDeps(now));
    expect(list.kind).toBe("OK");
    if (list.kind !== "OK") return;
    const item = list.view.items.find((i) => i.reference === opened.ref)!;
    expect(Object.keys(item).sort()).toEqual([
      "closes",
      "location",
      "reference",
      "summary",
      "title",
      "workerPaths",
    ]);
    const text = JSON.stringify(list);
    for (const internal of [
      position,
      opened.id,
      draft.id,
      tree.org,
      tree.branch,
      "TEST internal",
      "CYCLE-",
      "C-",
    ]) {
      expect(text.includes(internal), "internal value in public list").toBe(
        false,
      );
    }
    const detail = await queryPublicPosition(opened.ref, publicDeps(now));
    expect(detail.kind).toBe("FOUND");
    if (detail.kind !== "FOUND") return;
    if (detail.view.availability !== "ACCEPTING") throw new Error("closed");
    expect(Object.keys(detail.view).sort()).toEqual([
      "availability",
      "blocks",
      "closes",
      "disclaimer",
      "location",
      "reference",
      "summary",
      "title",
      "workerPaths",
    ]);
    expect(detail.view.blocks).toEqual([
      { kind: "paragraph", text: "TEST synthetic description." },
      {
        kind: "list",
        items: ["Assist with daily activities", "Keep accurate notes"],
      },
    ]);
    expect(detail.view.disclaimer).toMatch(
      /does not decide how any individual is classified/,
    );
  });

  it("answers draft, cancelled, never-opened, malformed, and unknown references identically", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "HIDDEN",
    );
    const draft = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    const published = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    done(
      await transitionHiringCycle(
        "publish",
        statusInput(published.id, published.version),
        boot(),
        deps,
      ),
    );
    const cancelled = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    done(
      await transitionHiringCycle(
        "cancel",
        statusInput(cancelled.id, cancelled.version, "PUBLISHED_IN_ERROR"),
        boot(),
        deps,
      ),
    );
    const refs = (
      await admin.query<{ public_reference: string }>(
        "SELECT public_reference FROM app.hiring_cycle WHERE id = ANY($1::uuid[])",
        [[draft.id, published.id, cancelled.id]],
      )
    ).rows.map((r) => r.public_reference);
    const results = [];
    for (const ref of [
      ...refs,
      "zzzzzzzzzzzz",
      "../../etc",
      "<script>",
      draft.id,
    ]) {
      results.push(
        await queryPublicPosition(
          ref,
          publicDeps(() => new Date()),
        ),
      );
      results.push(
        await queryHandoffOpening(
          ref,
          publicDeps(() => new Date()),
        ),
      );
    }
    expect(new Set(results.map((r) => JSON.stringify(r)))).toEqual(
      new Set([JSON.stringify({ kind: "NOT_FOUND" })]),
    );
  });

  it("bounds public filters and rejects unknown, repeated, or out-of-range parameters", async () => {
    const run = (params: Record<string, string | string[]>) =>
      queryPublicPositions(
        params,
        publicDeps(() => new Date()),
      );
    const cases: Record<string, string | string[]>[] = [
      { sort: "internal_label" },
      { select: "*" },
      { page: "0" },
      { page: "999" },
      { page: "1e3" },
      { type: "APPROVED_1099" },
      { location: "Nowhere" },
      { page: ["1", "2"] },
      { status: "DRAFT" },
    ];
    for (const params of cases) {
      expect(await run(params), JSON.stringify(Object.keys(params))).toEqual({
        kind: "INVALID_FILTER",
      });
    }
    const filtered = await run({
      type: "W2_AND_CONTRACTOR_ELIGIBLE",
      page: "1",
    });
    expect(filtered.kind).toBe("OK");
  });

  it("issues a signed handoff only for an accepting opening and creates no business record", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "HANDOFF",
    );
    const opened = await openCycle(position, new Date(Date.now() + 86_400_000));
    const before = await admin.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('app','auth','audit')",
    );
    const issued = await beginApplicationHandoff(
      opened.ref,
      new Headers(),
      publicDeps(() => new Date()),
    );
    expect(issued.kind).toBe("ISSUED");
    if (issued.kind !== "ISSUED") return;
    expect(issued.destination).toBe("/sign-in?next=APPLICATION_START");
    expect(verifyApplicationHandoff(issued.token)).toBe(opened.ref);
    // Tampered and wrong-purpose tokens fail.
    const [part, signature] = issued.token.split(".");
    expect(
      verifyApplicationHandoff(`${part}.${signature!.slice(0, -2)}AA`),
    ).toBeNull();
    const intent = h.runtime.intents.issuePublic();
    expect(verifyApplicationHandoff(intent)).toBeNull();
    // Without a verified candidate session the boundary refuses.
    expect(
      await confirmApplicationHandoff(
        headers(),
        issued.token,
        publicDeps(() => new Date()),
      ),
    ).toEqual({
      kind: "UNAUTHENTICATED",
    });
    // After close, the same opening no longer accepts.
    done(
      await transitionHiringCycle(
        "close",
        statusInput(opened.id, opened.version, "NO_LONGER_NEEDED"),
        boot(),
        deps,
      ),
    );
    expect(
      await beginApplicationHandoff(
        opened.ref,
        new Headers(),
        publicDeps(() => new Date()),
      ),
    ).toEqual({
      kind: "NOT_AVAILABLE",
    });
    const after = await admin.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname IN ('app','auth','audit')",
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const business = await admin.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE tablename ~ '(person|candidacy|application)'",
    );
    expect(business.rows[0].n).toBe(0);
  });
});

// ------------------------------------------------------- staff queries

describe("staff queries return exact scoped projections (AC-M2.1-09/15)", () => {
  it("lists positions in scope, hides them from roles without read, and never returns account or scope references", async () => {
    const hrList = await queryPositionList(headers(staff.hr!.jar), {}, deps);
    expect(hrList.kind).toBe("OK");
    // HR may create positions in its organization; branch-scoped HR may not.
    expect(hrList.kind === "OK" && hrList.view.canCreate).toBe(true);
    const recruiterList = await queryPositionList(
      headers(staff.recruiter!.jar),
      {},
      deps,
    );
    expect(recruiterList.kind).toBe("NOT_FOUND");
    const branchList = await queryPositionList(
      headers(staff.hrBranch!.jar),
      {},
      deps,
    );
    expect(branchList.kind === "OK" && branchList.view.items).toEqual([]);
    expect(branchList.kind === "OK" && branchList.view.canCreate).toBe(false);
    const otherList = await queryPositionList(
      headers(staff.otherManager!.jar),
      {},
      deps,
    );
    expect(otherList.kind === "OK" && otherList.view.items).toEqual([]);
    const text = JSON.stringify(hrList);
    expect(text).not.toMatch(
      /accountId|assignmentId|scopeReferenceId|sessionId|created_by|organization_id/,
    );
  });

  it("returns one NOT_FOUND for unknown, malformed, and out-of-scope position and cycle references", async () => {
    const { position } = await provisionPosition(
      deps,
      pair.creator,
      tree.org,
      "STAFFVIEW",
    );
    const cycle = await draftCycle(position, {
      opens: new Date(Date.now() - 3_600_000),
      closes: new Date(Date.now() + 86_400_000),
    });
    const detail = await queryPositionDetail(
      headers(staff.hr!.jar),
      position,
      deps,
    );
    expect(detail.kind).toBe("OK");
    if (detail.kind === "OK") {
      expect(detail.view.actions).toEqual([
        "position_edit",
        "job_description_edit",
      ]);
    }
    const managerDetail = await queryPositionDetail(
      headers(staff.manager!.jar),
      position,
      deps,
    );
    expect(managerDetail.kind === "OK" && managerDetail.view.actions).toEqual([
      "position_edit",
      "position_activate",
      "position_retire",
      "job_description_edit",
    ]);
    for (const [jar, id] of [
      [staff.otherManager!.jar, position],
      [staff.recruiter!.jar, position],
      [staff.hr!.jar, randomUUID()],
      [staff.hr!.jar, "not-a-uuid"],
    ] as const) {
      expect(await queryPositionDetail(headers(jar), id, deps)).toEqual({
        kind: "NOT_FOUND",
      });
    }
    expect(
      await queryCycleDetail(
        headers(staff.otherManager!.jar),
        position,
        cycle.id,
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(
      await queryCycleDetail(
        headers(staff.hr!.jar),
        randomUUID(),
        cycle.id,
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(await queryPositionDetail(headers(), position, deps)).toEqual({
      kind: "UNAUTHENTICATED",
    });
    const hierarchy = await queryHierarchy(headers(staff.manager!.jar), deps);
    expect(
      hierarchy.kind === "OK" &&
        hierarchy.view.organizations.map((o) => o.code),
    ).toEqual(["ORGCFG"]);
  });
});
