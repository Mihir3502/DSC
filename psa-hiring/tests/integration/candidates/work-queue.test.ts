import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAuditRecorder } from "@/modules/audit";
import {
  beginApplicationDraft,
  saveApplicationSection,
} from "@/modules/applications/application/application-commands";
import { queryApplicationReview } from "@/modules/applications/application/application-queries";
import { returnApplication } from "@/modules/applications/application/application-return";
import { submitApplication } from "@/modules/applications/application/application-submission";
import {
  assignCandidacyOwnerToSelf,
  createStaffProspect,
  startOwnCandidacy,
} from "@/modules/candidates/application/candidate-commands";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  assignCandidacyOwner,
  releaseCandidacyOwner,
  setWorkItemDueDate,
} from "@/modules/candidates/application/work-queue-commands";
import {
  queryStaffDashboard,
  queryStaffShell,
  queryWorkItem,
  queryWorkQueue,
} from "@/modules/candidates/application/work-queue-queries";
import {
  createHiringCycle,
  transitionHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../fixtures/canaries";
import { connect, failingKeys, verify } from "../support/audit";
import {
  activateStaff,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  signIn,
  type AuthorizationHarness,
  type BootstrapPair,
  type StaffSession,
} from "../support/authorization";
import { waitForLockWait } from "../support/barriers";
import {
  candidateDeps,
  candidateSession,
  ckey,
  handoffFor,
  outcome,
} from "../support/candidates";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";
import {
  bootstrapActor,
  configDeps,
  createOrganizationHarness,
  done,
  key,
  provisionHierarchy,
  provisionPosition,
  reason,
  type Hierarchy,
} from "../support/organization";

// M3.1 staff dashboard and unified work queue (packet M3.1 §14-§17). Real
// accounts, sessions, grants, and PostgreSQL; every value is synthetic.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let deps: ReturnType<typeof candidateDeps>;
let pair: BootstrapPair;
let tree: Hierarchy;
let positionId: string;
let position2Id: string;
let teamCycle: { id: string; ref: string };
let branchCycle: { id: string; ref: string };
let branch2Cycle: { id: string; ref: string };
const staff: Record<string, StaffSession> = {};

const CANARY = "TEST-WORKQUEUE-ANSWER-CANARY";
const local = (d: Date) => toZonedLocal(d, "America/New_York");
const DAY = 86_400_000;
const dayOffset = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const as = (name: string): CandidateActor => ({
  kind: "STAFF",
  principal: staff[name]!.principal,
});
const accountOf = (name: string) => staff[name]!.principal.accountId;
const result = (value: unknown) => outcome(value as never);

async function openCycle(position: string, branchId: string, teamId?: string) {
  const cdeps = configDeps(h);
  const actor = bootstrapActor(pair.creator);
  const cycle = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId: position,
        branchId,
        ...(teamId ? { teamId } : {}),
        code: `C-${randomUUID().slice(0, 8)}`.toUpperCase(),
        internalLabel: "TEST internal cycle",
        opensAt: local(new Date(Date.now() - 3_600_000)),
        closesAt: local(new Date(Date.now() + 7 * DAY)),
      },
      actor,
      cdeps,
    ),
  );
  const published = done(
    await transitionHiringCycle(
      "publish",
      {
        commandKey: key(),
        targetId: cycle.id,
        expectedVersion: String(cycle.version),
        reasonCode: reason,
      },
      actor,
      cdeps,
    ),
  );
  done(
    await transitionHiringCycle(
      "open",
      {
        commandKey: key(),
        targetId: cycle.id,
        expectedVersion: String(published.version),
        reasonCode: reason,
      },
      actor,
      cdeps,
    ),
  );
  const { rows } = await admin.query<{ public_reference: string }>(
    "SELECT public_reference FROM app.hiring_cycle WHERE id = $1",
    [cycle.id],
  );
  return { id: cycle.id, ref: rows[0]!.public_reference };
}

type Row = { id: string; public_id: string; version: number };

async function rowOf(id: string): Promise<Row & Record<string, unknown>> {
  const { rows } = await admin.query(
    "SELECT * FROM app.candidacy WHERE id = $1",
    [id],
  );
  return rows[0];
}

let serial = 0;
async function prospect(cycleRef: string, actor = as("manager")): Promise<Row> {
  serial += 1;
  const created = await createStaffProspect(
    {
      commandKey: ckey(),
      cycleReference: cycleRef,
      legalFirstName: "TEST Pat",
      legalLastName: `TEST Queue${String.fromCharCode(65 + (serial % 26))}`,
      email: `queue-${serial}-${randomUUID().slice(0, 6)}@example.test`,
    },
    actor,
    // Fixtures create many records; the limit has its own test in M2.2.
    { ...deps, limiter: { consume: () => true } as never },
  );
  if (created.kind !== "DONE") throw new Error(`prospect ${result(created)}`);
  return rowOf(created.targetId);
}

const answers: Record<string, Record<string, unknown>> = {
  availability: {
    available_days: ["monday"],
    available_shifts: ["morning"],
    hours_preference: "part_time",
    earliest_start_date: "2026-12-01",
    availability_notes: CANARY,
  },
  experience: { caregiving_experience: "one_to_three_years" },
  education: { highest_education: "high_school" },
  references: {
    reference_1_name: "TEST Reference",
    reference_1_relationship: "TEST Supervisor",
    reference_1_phone: "555-0100",
  },
};

/** A real candidate's real submitted application. */
async function submitted(cycleRef: string) {
  const candidate = await candidateSession(h);
  const started = await startOwnCandidacy(
    {
      commandKey: ckey(),
      handoffToken: handoffFor(h, cycleRef),
      legalFirstName: "TEST Ana",
      legalLastName: "TEST Submitted",
    },
    candidate.actor,
    deps,
  );
  if (started.kind !== "DONE") throw new Error("start");
  const row = await rowOf(started.targetId);
  await beginApplicationDraft(
    { commandKey: ckey(), candidacyId: row.public_id },
    candidate.actor,
    deps,
  );
  for (const [sectionCode, value] of Object.entries(answers)) {
    await saveApplicationSection(
      {
        commandKey: ckey(),
        candidacyId: row.public_id,
        sectionCode,
        expectedVersion: "0",
        answers: JSON.stringify(value),
      },
      candidate.actor,
      deps,
    );
  }
  const review = await queryApplicationReview(
    headers(candidate.jar),
    row.public_id,
    deps,
  );
  if (review.kind !== "OK") throw new Error("review");
  const done = await submitApplication(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      certificationVersion: String(review.view.certification.version),
      certified: "yes",
      signature: "TEST Ana Submitted",
      reviewToken: review.view.reviewToken,
    },
    candidate.actor,
    deps,
  );
  if (result(done) !== "SUBMITTED") throw new Error(`submit ${result(done)}`);
  return { candidate, row: await rowOf(row.id) };
}

const queue = async (name: string, search: Record<string, string> = {}) =>
  queryWorkQueue(headers(staff[name]!.jar), search, deps);

async function listed(name: string, search: Record<string, string> = {}) {
  const view = await queue(name, search);
  if (view.kind !== "OK") throw new Error(`queue ${view.kind}`);
  return view.view;
}

const references = async (name: string, search: Record<string, string> = {}) =>
  (await listed(name, search)).items.map((i) => i.id);

const itemOf = async (id: string) => {
  const { rows } = await admin.query(
    "SELECT * FROM app.work_item WHERE candidacy_id = $1 AND candidate_action_required = false AND status IN ('OPEN','IN_PROGRESS','BLOCKED')",
    [id],
  );
  return rows[0];
};

const historyOf = async (id: string) =>
  (
    await admin.query<{ change_code: string; reason_code: string | null }>(
      "SELECT change_code, reason_code FROM app.work_responsibility_history WHERE candidacy_id = $1 ORDER BY occurred_at, id",
      [id],
    )
  ).rows;

const eventsOf = async (id: string) =>
  (
    await admin.query<{ event_name: string }>(
      "SELECT event_name FROM audit.audit_event WHERE target_id = $1 ORDER BY chain_sequence",
      [id],
    )
  ).rows.map((r) => r.event_name);

const assign = (
  row: Row,
  target: string,
  actor: CandidateActor,
  over: Record<string, string> = {},
) =>
  assignCandidacyOwner(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(row.version),
      ownerAccountId: target,
      reasonCode: "COVERAGE",
      ...over,
    },
    actor,
    deps,
  );

const claim = (row: Row, actor: CandidateActor) =>
  assignCandidacyOwnerToSelf(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(row.version),
    },
    actor,
    deps,
  );

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "work_queue",
  ));
  h = createOrganizationHarness();
  deps = candidateDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "WQ");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "WQ-POS",
  ));
  ({ position: position2Id } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "WQ-POS2",
  ));
  const accounts = {
    manager: await activateStaff(h, "wq-manager"),
    hr: await activateStaff(h, "wq-hr"),
    recruiter: await activateStaff(h, "wq-recruiter"),
    teamRecruiter: await activateStaff(h, "wq-team-recruiter"),
    recruiterOther: await activateStaff(h, "wq-recruiter-other"),
    administrator: await activateStaff(h, "wq-admin"),
    otherManager: await activateStaff(h, "wq-other-manager"),
  };
  const grants = [
    ["manager", "PSA_MANAGER", "ORGANIZATION", tree.org],
    ["hr", "HR_SPECIALIST", "ORGANIZATION", tree.org],
    ["recruiter", "RECRUITER", "BRANCH", tree.branch],
    ["teamRecruiter", "RECRUITER", "TEAM", tree.team],
    ["recruiterOther", "RECRUITER", "BRANCH", tree.branch2],
    ["administrator", "SYSTEM_ADMINISTRATOR", "ORGANIZATION", tree.org],
    ["otherManager", "PSA_MANAGER", "ORGANIZATION", tree.org2],
  ] as const;
  for (const [name, role, scope, reference] of grants) {
    await grant(h, pair, accounts[name].accountId, role, scope, reference);
  }
  for (const [name, member] of Object.entries(accounts)) {
    staff[name] = await signIn(h, member);
  }
  branchCycle = await openCycle(positionId, tree.branch);
  teamCycle = await openCycle(position2Id, tree.branch, tree.team);
  branch2Cycle = await openCycle(positionId, tree.branch2);
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) await dropOwnedDatabase(ctx, db.name);
});

describe("work queue filters", () => {
  it("filters assigned, team, and unassigned work from the caller's own scope", async () => {
    const mine = await prospect(branchCycle.ref);
    expect(result(await claim(mine, as("recruiter")))).toBe("UPDATED");
    const open = await prospect(branchCycle.ref);
    const inTeam = await prospect(teamCycle.ref);

    const assigned = await references("recruiter", { assignment: "MINE" });
    expect(assigned).toContain(mine.public_id);
    expect(assigned).not.toContain(open.public_id);

    const unassigned = await references("recruiter", {
      assignment: "UNASSIGNED",
    });
    expect(unassigned).toContain(open.public_id);
    expect(unassigned).not.toContain(mine.public_id);

    // A branch-scoped recruiter has no team scope, so "my team" is empty.
    const branchOnly = await listed("recruiter", { assignment: "TEAM" });
    expect(branchOnly.hasTeamScope).toBe(false);
    expect(branchOnly.items).toEqual([]);

    const team = await listed("teamRecruiter", { assignment: "TEAM" });
    expect(team.hasTeamScope).toBe(true);
    expect(team.items.map((i) => i.id)).toContain(inTeam.public_id);
    expect(team.items.map((i) => i.id)).not.toContain(open.public_id);
  });

  it("filters by stage, branch, position, proposed worker path, due date, and exception", async () => {
    const plain = await prospect(branchCycle.ref);
    const otherBranch = await prospect(branch2Cycle.ref);
    const otherPosition = await prospect(teamCycle.ref);
    const { row: filed } = await submitted(branchCycle.ref);

    const stage = await references("manager", {
      stage: "APPLICATION_SUBMITTED",
    });
    expect(stage).toContain(filed.public_id);
    expect(stage).not.toContain(plain.public_id);

    const branch = await references("manager", { branch: tree.branch2 });
    expect(branch).toContain(otherBranch.public_id);
    expect(branch).not.toContain(plain.public_id);

    const position = await references("manager", { position: position2Id });
    expect(position).toContain(otherPosition.public_id);
    expect(position).not.toContain(plain.public_id);

    await admin.query(
      "UPDATE app.candidacy SET proposed_worker_path = 'W2' WHERE id = $1",
      [plain.id],
    );
    const worker = await listed("manager", { workerPath: "W2" });
    expect(worker.items.map((i) => i.id)).toEqual([plain.public_id]);
    // A proposal stays a proposal: nothing reads as an approved path.
    expect(worker.items[0]!.workerPath).toBe("Proposed W-2");
    expect(JSON.stringify(worker.items)).not.toMatch(/approved|1099/i);

    const item = await itemOf(filed.id);
    expect(
      result(
        await setWorkItemDueDate(
          {
            commandKey: ckey(),
            candidacyId: filed.public_id,
            expectedVersion: String(item.version),
            dueDate: dayOffset(0),
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    expect(await references("manager", { due: "TODAY" })).toContain(
      filed.public_id,
    );
    expect(await references("manager", { due: "NEXT_7" })).toContain(
      filed.public_id,
    );
    const none = await references("manager", { due: "NONE" });
    expect(none).toContain(plain.public_id);
    expect(none).not.toContain(filed.public_id);

    // Overdue comes from the server's clock, not from anything the client sends.
    const late = await queryWorkQueue(
      headers(staff.manager!.jar),
      { due: "OVERDUE" },
      { ...deps, clock: () => new Date(Date.now() + 2 * DAY) },
    );
    if (late.kind !== "OK") throw new Error(late.kind);
    const overdue = late.view.items.find((i) => i.id === filed.public_id);
    expect(overdue?.overdue).toBe(true);

    const refreshed = await rowOf(filed.id);
    expect(
      result(
        await returnApplication(
          {
            commandKey: ckey(),
            candidacyId: filed.public_id,
            expectedVersion: String(refreshed.version),
            reasonCode: "OTHER",
            instructions: "TEST please correct this",
            selection: JSON.stringify({ availability: [] }),
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("RETURNED");
    const returned = await listed("manager", { exception: "RETURNED" });
    expect(returned.items.map((i) => i.id)).toContain(filed.public_id);
    expect(returned.items.map((i) => i.id)).not.toContain(plain.public_id);
    const row = returned.items.find((i) => i.id === filed.public_id)!;
    expect(row.nextAction).toBe("Wait for the candidate's correction");
    // The finished review item takes its due date with it.
    expect(row.dueDate).toBeNull();
  });

  it("refuses unknown, repeated, malformed, and oversized filters", async () => {
    for (const search of [
      { stage: "OFFER" },
      { assignment: "ANYONE" },
      { due: "YESTERDAY" },
      { workerPath: "APPROVED_1099" },
      { exception: "ESCALATED" },
      { branch: "not-a-uuid" },
      { position: "1; DROP TABLE app.candidacy" },
      { owner: accountOf("manager") },
      { organization: tree.org2 },
      { after: "x".repeat(500) },
      { after: "none~bad~bad" },
      { stage: ["PROSPECT", "PROSPECT"] },
    ]) {
      const view = await queue(
        "manager",
        search as unknown as Record<string, string>,
      );
      expect(view.kind, JSON.stringify(search).slice(0, 40)).toBe(
        "INVALID_FILTERS",
      );
    }
  });

  it("a filter naming an out-of-scope branch can't widen the caller's scope", async () => {
    const elsewhere = await prospect(branch2Cycle.ref);
    expect(
      await references("recruiter", { branch: tree.branch2 }),
    ).not.toContain(elsewhere.public_id);
    expect((await listed("recruiter", { branch: tree.org2Branch })).total).toBe(
      0,
    );
    expect((await listed("recruiter")).branches.map((b) => b.id)).not.toContain(
      tree.branch2,
    );
  });
});

describe("work queue paging", () => {
  it("pages with a bound and a stable order, without repeats or gaps, while rows change", async () => {
    const cycle = await openCycle(position2Id, tree.branch2);
    const ids: string[] = [];
    for (let i = 0; i < 27; i += 1) {
      ids.push((await prospect(cycle.ref)).public_id);
    }
    const filter = { assignment: "UNASSIGNED", branch: tree.branch2 };
    const first = await listed("manager", filter);
    expect(first.items).toHaveLength(25);
    expect(first.total).toBeGreaterThanOrEqual(27);
    expect(first.nextCursor).not.toBeNull();

    const again = await listed("manager", filter);
    expect(again.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));

    // A record claimed between pages can't shift or repeat the rest.
    const moved = first.items[0]!.id;
    const movedRow = (
      await admin.query("SELECT * FROM app.candidacy WHERE public_id = $1", [
        moved,
      ])
    ).rows[0];
    expect(result(await claim(movedRow, as("recruiterOther")))).toBe("UPDATED");

    const seen = new Set(first.items.map((i) => i.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await listed("manager", { ...filter, after: cursor });
      for (const item of page.items) {
        expect(seen.has(item.id), "no repeats").toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
    }
    for (const id of ids) expect(seen.has(id), "no gaps").toBe(true);
  });
});

describe("safe summary fields", () => {
  it("returns exact fields with no contact details, answers, or account ids", async () => {
    const { row } = await submitted(branchCycle.ref);
    expect(
      result(await assign(row, accountOf("recruiter"), as("manager"))),
    ).toBe("UPDATED");
    const view = await listed("hr", { stage: "APPLICATION_SUBMITTED" });
    const item = view.items.find((i) => i.id === row.public_id)!;
    expect(Object.keys(item).sort()).toEqual(
      [
        "ageDays",
        "branch",
        "displayName",
        "dueDate",
        "id",
        "nextAction",
        "overdue",
        "owner",
        "position",
        "reference",
        "returned",
        "stage",
        "workerPath",
      ].sort(),
    );
    const text = JSON.stringify(view);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("@example.test");
    expect(text).not.toContain("555-0100");
    expect(text).not.toContain(accountOf("recruiter"));
    expect(text).not.toContain(row.id);

    const detail = await queryWorkItem(
      headers(staff.hr!.jar),
      row.public_id,
      deps,
    );
    if (detail.kind !== "OK") throw new Error(detail.kind);
    expect(detail.view.actions).toEqual([]);
    expect(detail.view.eligibleOwners).toEqual([]);
    const detailText = JSON.stringify(detail.view);
    expect(detailText).not.toContain(CANARY);
    expect(detailText).not.toContain("@example.test");
  });

  it("gives a candidate, an administrator, and a wrong-organization manager nothing", async () => {
    const row = await prospect(branchCycle.ref);
    const candidate = await candidateSession(h);
    for (const jar of [candidate.jar, staff.administrator!.jar]) {
      expect((await queryWorkQueue(headers(jar), {}, deps)).kind).toMatch(
        /UNAUTHENTICATED|NOT_FOUND/,
      );
      expect(
        (await queryWorkItem(headers(jar), row.public_id, deps)).kind,
      ).toMatch(/UNAUTHENTICATED|NOT_FOUND/);
    }
    expect(
      (await queryStaffDashboard(headers(staff.administrator!.jar), deps)).kind,
    ).toBe("NO_QUEUE");
    const shell = await queryStaffShell(
      headers(staff.administrator!.jar),
      deps,
    );
    if (shell.kind !== "OK") throw new Error(shell.kind);
    expect(shell.view.navigation.map((e) => e.label)).toEqual(["Security"]);

    // Out of scope and nonexistent are the same answer.
    const hidden = await queryWorkItem(
      headers(staff.otherManager!.jar),
      row.public_id,
      deps,
    );
    const missing = await queryWorkItem(
      headers(staff.otherManager!.jar),
      "0123456789ab",
      deps,
    );
    expect(hidden).toEqual(missing);
    expect(hidden.kind).toBe("NOT_FOUND");
    expect(await references("otherManager")).not.toContain(row.public_id);
    const wrongBranch = await queryWorkItem(
      headers(staff.recruiterOther!.jar),
      row.public_id,
      deps,
    );
    expect(wrongBranch.kind).toBe("NOT_FOUND");
  });

  it("counts the dashboard only within the caller's scope", async () => {
    const before = await queryStaffDashboard(
      headers(staff.otherManager!.jar),
      deps,
    );
    if (before.kind !== "OK") throw new Error(before.kind);
    await submitted(branchCycle.ref);
    const after = await queryStaffDashboard(
      headers(staff.otherManager!.jar),
      deps,
    );
    expect(after).toEqual(before);

    const manager = await queryStaffDashboard(
      headers(staff.manager!.jar),
      deps,
    );
    if (manager.kind !== "OK") throw new Error(manager.kind);
    expect(manager.view.unassignedSubmitted).toBeGreaterThan(0);
    expect(Object.keys(manager.view).sort()).toEqual([
      "myDueToday",
      "overdue",
      "returned",
      "unassignedSubmitted",
    ]);
  });
});

describe("assignment and ownership", () => {
  it("lets a manager assign and reassign with a reason, writing history and audit once", async () => {
    const row = await prospect(branchCycle.ref);
    expect(
      result(await assign(row, accountOf("recruiter"), as("manager"))),
    ).toBe("UPDATED");
    const next = await rowOf(row.id);
    expect(next.owner_account_id).toBe(accountOf("recruiter"));
    expect(next.version).toBe(row.version + 1);
    expect(
      result(
        await assign(next, accountOf("manager"), as("manager"), {
          reasonCode: "WORKLOAD_BALANCE",
        }),
      ),
    ).toBe("UPDATED");
    expect(await historyOf(row.id)).toEqual([
      { change_code: "OWNER_ASSIGNED", reason_code: "COVERAGE" },
      { change_code: "OWNER_REASSIGNED", reason_code: "WORKLOAD_BALANCE" },
    ]);
    const events = await eventsOf(row.id);
    expect(events.filter((e) => e === "candidacy.owner_assigned")).toHaveLength(
      2,
    );
    const { rows } = await admin.query(
      "SELECT metadata_json::text AS m FROM audit.audit_event WHERE target_id = $1 AND event_name = 'candidacy.owner_assigned'",
      [row.id],
    );
    for (const { m } of rows) {
      expect(m).not.toContain(accountOf("recruiter"));
      expect(m).not.toContain("example.test");
    }
  });

  it("allows only the manager to assign others, and denies every other role and scope", async () => {
    const row = await prospect(branchCycle.ref);
    for (const name of [
      "recruiter",
      "hr",
      "administrator",
      "otherManager",
      "recruiterOther",
    ]) {
      expect(
        result(await assign(row, accountOf("recruiter"), as(name))),
        name,
      ).toMatch(/NOT_AUTHORIZED|NOT_FOUND/);
    }
    const candidate = await candidateSession(h);
    expect(
      result(await assign(row, accountOf("recruiter"), candidate.actor)),
    ).toBe("NOT_AUTHORIZED");
    const unchanged = await rowOf(row.id);
    expect(unchanged.owner_account_id).toBeNull();
    expect(unchanged.version).toBe(row.version);
    expect(await historyOf(row.id)).toEqual([]);
  });

  it("refuses an owner who isn't eligible at this record", async () => {
    const row = await prospect(branchCycle.ref);
    for (const name of [
      "hr",
      "recruiterOther",
      "administrator",
      "otherManager",
    ]) {
      expect(
        result(await assign(row, accountOf(name), as("manager"))),
        name,
      ).toBe("OWNER_NOT_ELIGIBLE");
    }
    expect(result(await assign(row, randomUUID(), as("manager")))).toBe(
      "OWNER_NOT_ELIGIBLE",
    );
    expect(result(await assign(row, "not-a-uuid", as("manager")))).toBe(
      "INVALID_INPUT",
    );
    expect(
      result(
        await assign(row, accountOf("recruiter"), as("manager"), {
          reasonCode: "BECAUSE",
        }),
      ),
    ).toBe("INVALID_INPUT");

    const detail = await queryWorkItem(
      headers(staff.manager!.jar),
      row.public_id,
      deps,
    );
    if (detail.kind !== "OK") throw new Error(detail.kind);
    const offered = detail.view.eligibleOwners.map((e) => e.id);
    expect(offered).toContain(accountOf("recruiter"));
    expect(offered).toContain(accountOf("manager"));
    expect(offered).not.toContain(accountOf("hr"));
    expect(offered).not.toContain(accountOf("recruiterOther"));
    expect(offered).not.toContain(accountOf("otherManager"));
  });

  it("stops a claim from taking a record someone else owns", async () => {
    const row = await prospect(branchCycle.ref);
    expect(result(await claim(row, as("manager")))).toBe("UPDATED");
    const owned = await rowOf(row.id);
    expect(result(await claim(owned, as("recruiter")))).toBe(
      "INVALID_TRANSITION",
    );
    expect((await rowOf(row.id)).owner_account_id).toBe(accountOf("manager"));
    expect(await historyOf(row.id)).toEqual([
      { change_code: "OWNER_ASSIGNED", reason_code: "WORKLOAD_BALANCE" },
    ]);
  });

  it("lets owners release their own record and only a manager release someone else's", async () => {
    const row = await prospect(branchCycle.ref);
    expect(result(await claim(row, as("recruiter")))).toBe("UPDATED");
    const owned = await rowOf(row.id);
    const release = (actor: CandidateActor, r: Row, reasonCode = "COVERAGE") =>
      releaseCandidacyOwner(
        {
          commandKey: ckey(),
          candidacyId: r.public_id,
          expectedVersion: String(r.version),
          reasonCode,
        },
        actor,
        deps,
      );
    expect(result(await release(as("hr"), owned))).toMatch(
      /NOT_AUTHORIZED|NOT_FOUND/,
    );
    expect(result(await release(as("recruiter"), owned))).toBe("UPDATED");
    const free = await rowOf(row.id);
    expect(free.owner_account_id).toBeNull();
    expect(result(await release(as("recruiter"), free))).toMatch(
      /NOT_AUTHORIZED|INVALID_TRANSITION/,
    );
    expect(result(await claim(free, as("recruiter")))).toBe("UPDATED");
    expect(result(await release(as("manager"), await rowOf(row.id)))).toBe(
      "UPDATED",
    );
    expect(await eventsOf(row.id)).toContain("candidacy.owner_released");
    expect((await historyOf(row.id)).map((h) => h.change_code)).toEqual([
      "OWNER_ASSIGNED",
      "OWNER_RELEASED",
      "OWNER_ASSIGNED",
      "OWNER_RELEASED",
    ]);
  });

  it("refuses a stale version with no partial state", async () => {
    const row = await prospect(branchCycle.ref);
    expect(
      result(await assign(row, accountOf("recruiter"), as("manager"))),
    ).toBe("UPDATED");
    expect(result(await assign(row, accountOf("manager"), as("manager")))).toBe(
      "STALE_VERSION",
    );
    expect((await rowOf(row.id)).owner_account_id).toBe(accountOf("recruiter"));
    expect(await historyOf(row.id)).toHaveLength(1);
  });

  it("returns the original result for a repeat and rejects a changed request with the same key", async () => {
    const row = await prospect(branchCycle.ref);
    const commandKey = ckey();
    const first = await assign(row, accountOf("recruiter"), as("manager"), {
      commandKey,
    });
    const again = await assign(row, accountOf("recruiter"), as("manager"), {
      commandKey,
    });
    expect(result(first)).toBe("UPDATED");
    expect(again).toMatchObject({ kind: "DONE", replayed: true });
    expect(await historyOf(row.id)).toHaveLength(1);
    expect(
      result(
        await assign(row, accountOf("manager"), as("manager"), { commandKey }),
      ),
    ).toBe("COMMAND_KEY_CONFLICT");
    expect((await rowOf(row.id)).owner_account_id).toBe(accountOf("recruiter"));
  });

  it("lets exactly one of two concurrent changes win", async () => {
    const row = await prospect(branchCycle.ref);
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.candidacy WHERE id = $1 FOR UPDATE", [
      row.id,
    ]);
    const race = [
      assign(row, accountOf("recruiter"), as("manager")),
      claim(row, as("recruiter")),
    ];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const outcomes = (await Promise.all(race)).map(result);
    expect(outcomes.filter((o) => o === "UPDATED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "STALE_VERSION")).toHaveLength(1);
    expect(await historyOf(row.id)).toHaveLength(1);
  });

  it("rolls everything back when the audit write fails", async () => {
    const row = await prospect(branchCycle.ref);
    const failing = {
      ...deps,
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    };
    await expect(
      assignCandidacyOwner(
        {
          commandKey: ckey(),
          candidacyId: row.public_id,
          expectedVersion: String(row.version),
          ownerAccountId: accountOf("recruiter"),
          reasonCode: "COVERAGE",
        },
        as("manager"),
        failing,
      ),
    ).rejects.toThrow();
    const after = await rowOf(row.id);
    expect(after.owner_account_id).toBeNull();
    expect(after.version).toBe(row.version);
    expect(await historyOf(row.id)).toEqual([]);
    expect((await verify(db)).ok).toBe(true);
  });
});

describe("due dates", () => {
  const setDue = (
    row: Row,
    expectedVersion: number,
    dueDate: string,
    actor: CandidateActor,
  ) =>
    setWorkItemDueDate(
      {
        commandKey: ckey(),
        candidacyId: row.public_id,
        expectedVersion: String(expectedVersion),
        dueDate,
      },
      actor,
      deps,
    );

  it("sets, changes, and clears a staff item's due date with history, and never invents one", async () => {
    const { row } = await submitted(branchCycle.ref);
    const item = await itemOf(row.id);
    expect(item.due_at).toBeNull();
    expect(
      result(await setDue(row, item.version, dayOffset(3), as("recruiter"))),
    ).toBe("UPDATED");
    const dated = await itemOf(row.id);
    expect((dated.due_at as Date).toISOString()).toBe(
      `${dayOffset(3)}T23:59:59.999Z`,
    );
    expect(
      result(await setDue(row, dated.version, dayOffset(5), as("manager"))),
    ).toBe("UPDATED");
    const changed = await itemOf(row.id);
    expect(result(await setDue(row, changed.version, "", as("manager")))).toBe(
      "UPDATED",
    );
    expect((await itemOf(row.id)).due_at).toBeNull();
    expect((await historyOf(row.id)).map((h) => h.change_code)).toEqual([
      "DUE_DATE_SET",
      "DUE_DATE_SET",
      "DUE_DATE_CLEARED",
    ]);
    expect(
      (await eventsOf(row.id)).filter(
        (e) => e === "work_item.due_date_changed",
      ),
    ).toHaveLength(3);
    const { rows } = await admin.query(
      "SELECT metadata_json::text AS m FROM audit.audit_event WHERE target_id = $1 AND event_name = 'work_item.due_date_changed'",
      [row.id],
    );
    for (const { m } of rows) expect(m).not.toContain(dayOffset(3));
  });

  it("refuses bad dates, wrong roles, stale versions, and records with no staff item", async () => {
    const { row } = await submitted(branchCycle.ref);
    const item = await itemOf(row.id);
    for (const bad of [
      dayOffset(-1),
      dayOffset(400),
      "2027-02-31",
      "tomorrow",
      "2027-01-01T00:00:00Z",
    ]) {
      expect(
        result(await setDue(row, item.version, bad, as("manager"))),
        bad,
      ).toBe("INVALID_INPUT");
    }
    for (const name of [
      "hr",
      "administrator",
      "otherManager",
      "recruiterOther",
    ]) {
      expect(
        result(await setDue(row, item.version, dayOffset(1), as(name))),
        name,
      ).toMatch(/NOT_AUTHORIZED|NOT_FOUND/);
    }
    expect(
      result(await setDue(row, item.version + 5, dayOffset(1), as("manager"))),
    ).toBe("STALE_VERSION");
    expect(result(await setDue(row, item.version, "", as("manager")))).toBe(
      "INVALID_TRANSITION",
    );
    const unchanged = await itemOf(row.id);
    expect(unchanged.due_at).toBeNull();
    expect(unchanged.version).toBe(item.version);

    const noItem = await prospect(branchCycle.ref);
    expect(result(await setDue(noItem, 1, dayOffset(1), as("manager")))).toBe(
      "INVALID_TRANSITION",
    );
    expect(await historyOf(noItem.id)).toEqual([]);
  });
});

describe("database rules", () => {
  it("keeps responsibility history append-only and refuses incoherent rows", async () => {
    const row = await prospect(branchCycle.ref);
    expect(result(await claim(row, as("manager")))).toBe("UPDATED");
    const runtime = await connect(db.urls.app);
    const refused = async (
      client: Client,
      statement: string,
      values: unknown[] = [],
    ) =>
      client.query(statement, values).then(
        () => "OK",
        (error: { code: string }) => error.code,
      );
    try {
      expect(
        await refused(
          runtime,
          "UPDATE app.work_responsibility_history SET reason_code = 'COVERAGE'",
        ),
      ).toBe("42501");
      expect(
        await refused(runtime, "DELETE FROM app.work_responsibility_history"),
      ).toBe("42501");
      expect(await refused(runtime, "DELETE FROM app.work_item")).toBe("42501");
    } finally {
      await runtime.end();
    }
    expect(
      await refused(admin, "DELETE FROM app.work_responsibility_history"),
    ).toBe("CN002");
    // An owner change can't carry a due date, and a due change needs an item.
    expect(
      await refused(
        admin,
        "INSERT INTO app.work_responsibility_history (candidacy_id, change_code, new_owner_account_id, new_due_at, actor_account_id, occurred_at) VALUES ($1, 'OWNER_ASSIGNED', $2, now(), $2, now())",
        [row.id, accountOf("manager")],
      ),
    ).toBe("23514");
    expect(
      await refused(
        admin,
        "INSERT INTO app.work_responsibility_history (candidacy_id, change_code, new_due_at, actor_account_id, occurred_at) VALUES ($1, 'DUE_DATE_SET', now(), $2, now())",
        [row.id, accountOf("manager")],
      ),
    ).toBe("23514");
    // A candidate task can't get a due date, and history can't point elsewhere.
    const { row: filed } = await submitted(branchCycle.ref);
    const owner = await candidateSession(h);
    const started = await startOwnCandidacy(
      {
        commandKey: ckey(),
        handoffToken: handoffFor(h, branchCycle.ref),
        legalFirstName: "TEST Ana",
        legalLastName: "TEST Task",
      },
      owner.actor,
      deps,
    );
    if (started.kind !== "DONE") throw new Error("start");
    expect(
      await refused(
        admin,
        "UPDATE app.work_item SET due_at = now(), version = version + 1 WHERE candidacy_id = $1 AND candidate_action_required = true AND status = 'OPEN'",
        [started.targetId],
      ),
    ).toBe("23514");
    const item = await itemOf(filed.id);
    expect(
      await refused(
        admin,
        "INSERT INTO app.work_responsibility_history (candidacy_id, work_item_id, change_code, new_due_at, actor_account_id, occurred_at) VALUES ($1, $2, 'DUE_DATE_SET', now(), $3, now())",
        [row.id, item.id, accountOf("manager")],
      ),
    ).toBe("23503");
  });
});
