import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  beginApplicationDraft,
  saveApplicationSection,
} from "@/modules/applications/application/application-commands";
import { queryApplicationReview } from "@/modules/applications/application/application-queries";
import { returnApplication } from "@/modules/applications/application/application-return";
import { submitApplication } from "@/modules/applications/application/application-submission";
import {
  closeProspect,
  createStaffProspect,
  startOwnCandidacy,
} from "@/modules/candidates/application/candidate-commands";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  queryCandidateOverview,
  queryCandidateWorkspaceShell,
} from "@/modules/candidates/application/candidate-workspace-queries";
import {
  assignCandidacyOwner,
  setWorkItemDueDate,
} from "@/modules/candidates/application/work-queue-commands";
import { queryStaffShell } from "@/modules/candidates/application/work-queue-queries";
import {
  createHiringCycle,
  transitionHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import { closeDatabasePool } from "@/shared/database";
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

// M3.2 candidate workspace shell (packet M3.2 §14-§17). Real accounts, sessions,
// grants, and PostgreSQL; every value is synthetic.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let deps: ReturnType<typeof candidateDeps>;
let pair: BootstrapPair;
let tree: Hierarchy;
let cycle: { id: string; ref: string };
const staff: Record<string, StaffSession> = {};

const CANARY = "TEST-WORKSPACE-ANSWER-CANARY";
const PHONE = "555-0100";
const DAY = 86_400_000;
const local = (d: Date) => toZonedLocal(d, "America/New_York");
const as = (name: string): CandidateActor => ({
  kind: "STAFF",
  principal: staff[name]!.principal,
});
const accountOf = (name: string) => staff[name]!.principal.accountId;
const result = (value: unknown) => outcome(value as never);

async function openCycle(position: string, branchId: string) {
  const cdeps = configDeps(h);
  const actor = bootstrapActor(pair.creator);
  const created = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId: position,
        branchId,
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
        targetId: created.id,
        expectedVersion: String(created.version),
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
        targetId: created.id,
        expectedVersion: String(published.version),
        reasonCode: reason,
      },
      actor,
      cdeps,
    ),
  );
  const { rows } = await admin.query<{ public_reference: string }>(
    "SELECT public_reference FROM app.hiring_cycle WHERE id = $1",
    [created.id],
  );
  return { id: created.id, ref: rows[0]!.public_reference };
}

type Row = { id: string; public_id: string; version: number };

async function rowOf(id: string): Promise<Row & Record<string, unknown>> {
  const { rows } = await admin.query(
    "SELECT * FROM app.candidacy WHERE id = $1",
    [id],
  );
  return rows[0];
}

async function prospect(): Promise<Row> {
  const created = await createStaffProspect(
    {
      commandKey: ckey(),
      cycleReference: cycle.ref,
      legalFirstName: "TEST Pat",
      legalLastName: "TEST Workspace",
      email: `workspace-${randomUUID().slice(0, 8)}@example.test`,
      phone: PHONE,
    },
    as("manager"),
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
    reference_1_phone: PHONE,
  },
};

async function started() {
  const candidate = await candidateSession(h);
  const begun = await startOwnCandidacy(
    {
      commandKey: ckey(),
      handoffToken: handoffFor(h, cycle.ref),
      legalFirstName: "TEST Ana",
      legalLastName: "TEST Workspace",
    },
    candidate.actor,
    deps,
  );
  if (begun.kind !== "DONE") throw new Error("start");
  return { candidate, row: await rowOf(begun.targetId) };
}

async function submitted() {
  const { candidate, row } = await started();
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
  const finished = await submitApplication(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      certificationVersion: String(review.view.certification.version),
      certified: "yes",
      signature: "TEST Ana Workspace",
      reviewToken: review.view.reviewToken,
    },
    candidate.actor,
    deps,
  );
  if (result(finished) !== "SUBMITTED") throw new Error("submit");
  return { candidate, row: await rowOf(row.id) };
}

const shellFor = (name: string, publicId: string, d = deps) =>
  queryCandidateWorkspaceShell(headers(staff[name]!.jar), publicId, d);
const overviewFor = (name: string, publicId: string, d = deps) =>
  queryCandidateOverview(headers(staff[name]!.jar), publicId, d);

async function shell(name: string, publicId: string) {
  const view = await shellFor(name, publicId);
  if (view.kind !== "OK") throw new Error(`shell ${view.kind}`);
  return view.view;
}
async function overview(name: string, publicId: string, d = deps) {
  const view = await overviewFor(name, publicId, d);
  if (view.kind !== "OK") throw new Error(`overview ${view.kind}`);
  return view.view;
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "workspace",
  ));
  h = createOrganizationHarness();
  deps = candidateDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "WS");
  const { position } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "WS-POS",
  );
  const accounts = {
    manager: await activateStaff(h, "ws-manager"),
    hr: await activateStaff(h, "ws-hr"),
    recruiter: await activateStaff(h, "ws-recruiter"),
    recruiterOther: await activateStaff(h, "ws-recruiter-other"),
    compliance: await activateStaff(h, "ws-compliance"),
    classification: await activateStaff(h, "ws-classification"),
    trainer: await activateStaff(h, "ws-trainer"),
    administrator: await activateStaff(h, "ws-admin"),
    otherManager: await activateStaff(h, "ws-other-manager"),
    auditor: await activateStaff(h, "ws-auditor"),
  };
  const grants = [
    ["manager", "PSA_MANAGER", "ORGANIZATION", tree.org],
    ["hr", "HR_SPECIALIST", "ORGANIZATION", tree.org],
    ["recruiter", "RECRUITER", "BRANCH", tree.branch],
    ["recruiterOther", "RECRUITER", "BRANCH", tree.branch2],
    ["compliance", "COMPLIANCE_REVIEWER", "ORGANIZATION", tree.org],
    ["classification", "CLASSIFICATION_REVIEWER", "ORGANIZATION", tree.org],
    ["trainer", "TRAINER_EVALUATOR", "ORGANIZATION", tree.org],
    ["administrator", "SYSTEM_ADMINISTRATOR", "ORGANIZATION", tree.org],
    ["otherManager", "PSA_MANAGER", "ORGANIZATION", tree.org2],
  ] as const;
  for (const [name, role, scope, reference] of grants) {
    await grant(h, pair, accounts[name].accountId, role, scope, reference);
  }
  for (const [name, member] of Object.entries(accounts)) {
    staff[name] = await signIn(h, member);
  }
  cycle = await openCycle(position, tree.branch);
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) await dropOwnedDatabase(ctx, db.name);
});

describe("summary header", () => {
  it("shows exact safe fields, with no hold and a proposal-only worker path", async () => {
    const row = await prospect();
    const view = await shell("recruiter", row.public_id);
    expect(Object.keys(view).sort()).toEqual(
      [
        "branch",
        "closed",
        "displayName",
        "dueDate",
        "hold",
        "id",
        "nextAction",
        "owner",
        "position",
        "reference",
        "stage",
        "status",
        "tabs",
        "workerPath",
      ].sort(),
    );
    expect(view).toMatchObject({
      id: row.public_id,
      stage: "Prospect",
      owner: "Unassigned",
      workerPath: "Undecided",
      hold: null,
      closed: false,
      dueDate: null,
    });
    await admin.query(
      "UPDATE app.candidacy SET proposed_worker_path = 'CONTRACTOR' WHERE id = $1",
      [row.id],
    );
    const proposed = await shell("recruiter", row.public_id);
    expect(proposed.workerPath).toBe("Proposed contractor");
    expect(JSON.stringify(proposed)).not.toMatch(/approved|1099/i);
  });

  it("stays stable across tabs' states and shows the owner and due date", async () => {
    const { row } = await submitted();
    expect(
      result(
        await assignCandidacyOwner(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(row.version),
            ownerAccountId: accountOf("recruiter"),
            reasonCode: "COVERAGE",
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    const { rows } = await admin.query(
      "SELECT version FROM app.work_item WHERE candidacy_id = $1 AND candidate_action_required = false AND status = 'OPEN'",
      [row.id],
    );
    const dueDate = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    expect(
      result(
        await setWorkItemDueDate(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(rows[0].version),
            dueDate,
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    const own = await shell("recruiter", row.public_id);
    expect(own).toMatchObject({ owner: "You", dueDate });
    const other = await shell("manager", row.public_id);
    expect(other.owner).not.toBe("You");
    expect(Object.keys(other).sort()).toEqual(Object.keys(own).sort());
  });

  it("shows a closed record as closed, with no next action", async () => {
    const row = await prospect();
    expect(
      result(
        await closeProspect(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(row.version),
            reasonCode: "UNREACHABLE",
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    const view = await shell("recruiter", row.public_id);
    expect(view.closed).toBe(true);
    expect(view.nextAction).toMatch(/closed/);
    const details = await overview("recruiter", row.public_id);
    expect(details.blockers).toEqual([]);
    expect(details.canManageWork).toBe(false);
  });
});

describe("permission-aware tabs", () => {
  it("offers Application only after a submission, to everyone who may read it", async () => {
    const draft = await prospect();
    expect(
      (await shell("recruiter", draft.public_id)).tabs.map((t) => t.key),
    ).toEqual(["overview"]);
    const { row } = await submitted();
    for (const name of [
      "manager",
      "hr",
      "recruiter",
      "compliance",
      "classification",
    ]) {
      expect(
        (await shell(name, row.public_id)).tabs.map((t) => t.key),
        name,
      ).toEqual(["overview", "application"]);
    }
  });

  it("gives every reader the same fields and no tab counts, however many records sit behind a tab", async () => {
    const quiet = await submitted();
    const busy = await submitted();
    for (let i = 0; i < 3; i += 1) {
      const fresh = await rowOf(busy.row.id);
      await assignCandidacyOwner(
        {
          commandKey: ckey(),
          candidacyId: fresh.public_id,
          expectedVersion: String(fresh.version),
          ownerAccountId: accountOf(i % 2 ? "manager" : "recruiter"),
          reasonCode: "COVERAGE",
        },
        as("manager"),
        deps,
      );
    }
    const a = await shell("compliance", quiet.row.public_id);
    const b = await shell("compliance", busy.row.public_id);
    const shape = (view: typeof a) =>
      view.tabs.map((t) => ({ ...t, href: t.href.replace(view.id, "ID") }));
    expect(shape(a)).toEqual(shape(b));
    for (const tab of b.tabs) {
      expect(Object.keys(tab).sort()).toEqual(["href", "key", "label"]);
      expect(tab.label).not.toMatch(/\d/);
    }
    // Hidden work isn't summarized for this reader, in count or in detail.
    const hidden = await overview("compliance", busy.row.public_id);
    expect(hidden.canManageWork).toBe(false);
    for (const entry of hidden.timeline) expect(entry.detail).toBeNull();
  });
});

describe("overview", () => {
  it("derives blockers from stored facts at each stage", async () => {
    const codes = async (name: string, id: string, d = deps) =>
      (await overview(name, id, d)).blockers.map((b) => b.code);

    const pending = await prospect();
    expect(await codes("recruiter", pending.public_id)).toEqual(["NO_OWNER"]);

    const { row: drafting } = await started();
    expect(await codes("recruiter", drafting.public_id)).toEqual([
      "WAITING_FOR_SUBMISSION",
      "NO_OWNER",
    ]);

    const { row } = await submitted();
    expect(await codes("recruiter", row.public_id)).toEqual(["NO_OWNER"]);

    const { rows } = await admin.query(
      "SELECT version FROM app.work_item WHERE candidacy_id = $1 AND candidate_action_required = false AND status = 'OPEN'",
      [row.id],
    );
    await setWorkItemDueDate(
      {
        commandKey: ckey(),
        candidacyId: row.public_id,
        expectedVersion: String(rows[0].version),
        dueDate: new Date().toISOString().slice(0, 10),
      },
      as("recruiter"),
      deps,
    );
    expect(await codes("recruiter", row.public_id)).toEqual(["NO_OWNER"]);
    // Overdue comes from the server's clock.
    expect(
      await codes("recruiter", row.public_id, {
        ...deps,
        clock: () => new Date(Date.now() + 2 * DAY),
      }),
    ).toEqual(["STAFF_WORK_OVERDUE", "NO_OWNER"]);

    const fresh = await rowOf(row.id);
    expect(
      result(
        await returnApplication(
          {
            commandKey: ckey(),
            candidacyId: fresh.public_id,
            expectedVersion: String(fresh.version),
            reasonCode: "OTHER",
            instructions: "TEST please correct this",
            selection: JSON.stringify({ availability: [] }),
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("RETURNED");
    expect(await codes("recruiter", row.public_id)).toEqual([
      "RETURNED_FOR_CORRECTION",
      "NO_OWNER",
    ]);
  });

  it("shows a possible duplicate only to readers who could already see it", async () => {
    const email = `dupe-${randomUUID().slice(0, 8)}@example.test`;
    const make = () =>
      createStaffProspect(
        {
          commandKey: ckey(),
          cycleReference: cycle.ref,
          legalFirstName: "TEST Dee",
          legalLastName: "TEST Duplicate",
          email,
          acknowledgeDuplicate: "yes",
        },
        as("manager"),
        { ...deps, limiter: { consume: () => true } as never },
      );
    const first = await make();
    if (first.kind !== "DONE") throw new Error("first");
    const firstRow = await rowOf(first.targetId);
    const second = await make();
    if (second.kind !== "DONE") throw new Error("second");
    const codes = async (name: string) =>
      (await overview(name, firstRow.public_id)).blockers.map((b) => b.code);
    expect(await codes("recruiter")).toContain("POSSIBLE_DUPLICATE");
    expect(await codes("compliance")).not.toContain("POSSIBLE_DUPLICATE");
  });

  it("merges history newest first, keeps it bounded, and limits who and why", async () => {
    const row = await prospect();
    expect(
      result(
        await assignCandidacyOwner(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(row.version),
            ownerAccountId: accountOf("recruiter"),
            reasonCode: "COVERAGE",
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    const manager = await overview("manager", row.public_id);
    expect(manager.timeline.map((t) => t.event)).toEqual([
      "Owner assigned",
      "Prospect created",
    ]);
    expect(manager.timeline[0]!.detail).toContain("Covering for someone away");
    const when = manager.timeline.map((t) => Date.parse(t.when));
    expect([...when].sort((a, b) => b - a)).toEqual(when);
    const reviewer = await overview("compliance", row.public_id);
    expect(reviewer.timeline.map((t) => t.event)).toEqual(
      manager.timeline.map((t) => t.event),
    );
    expect(reviewer.timeline.every((t) => t.detail === null)).toBe(true);

    for (let i = 0; i < 60; i += 1) {
      await admin.query(
        "INSERT INTO app.work_responsibility_history (candidacy_id, change_code, previous_owner_account_id, actor_account_id, reason_code, occurred_at) VALUES ($1, 'OWNER_RELEASED', $2, $2, 'COVERAGE', now())",
        [row.id, accountOf("recruiter")],
      );
    }
    expect((await overview("manager", row.public_id)).timeline).toHaveLength(
      50,
    );
  });

  it("reads write nothing", async () => {
    const { row } = await submitted();
    const snapshot = async () =>
      (
        await admin.query(
          `SELECT (SELECT count(*) FROM audit.audit_event) AS audit,
                  (SELECT count(*) FROM app.work_responsibility_history) AS history,
                  (SELECT version FROM app.candidacy WHERE id = $1) AS version`,
          [row.id],
        )
      ).rows[0];
    const before = await snapshot();
    await shell("manager", row.public_id);
    await overview("manager", row.public_id);
    expect(await snapshot()).toEqual(before);
  });
});

describe("staff menu", () => {
  it("shows each role only the screens it may open", async () => {
    const menu = async (name: string) => {
      const shell = await queryStaffShell(headers(staff[name]!.jar), deps);
      if (shell.kind !== "OK") throw new Error(`${name} ${shell.kind}`);
      return shell.view.navigation.map((e) => e.label);
    };
    expect(await menu("recruiter")).toEqual([
      "Dashboard",
      "Work Queue",
      "Add Candidate",
      "Submitted Applications",
      "Security",
    ]);
    expect(await menu("hr")).toEqual([
      "Dashboard",
      "Work Queue",
      "Add Candidate",
      "Submitted Applications",
      "Positions",
      "Security",
    ]);
    expect(await menu("manager")).toEqual([
      "Dashboard",
      "Work Queue",
      "Add Candidate",
      "Submitted Applications",
      "Positions",
      "Possible Duplicates",
      "Security",
    ]);
    for (const name of ["compliance", "classification"]) {
      expect(await menu(name), name).toEqual([
        "Submitted Applications",
        "Security",
      ]);
    }
    for (const name of ["administrator", "trainer", "auditor"]) {
      expect(await menu(name), name).toEqual(["Security"]);
    }
    const candidate = await candidateSession(h);
    expect((await queryStaffShell(headers(candidate.jar), deps)).kind).toBe(
      "UNAUTHENTICATED",
    );
  });
});

describe("authorization and nondisclosure", () => {
  it("gives one identical not-found for every outsider and a missing record", async () => {
    const row = await prospect();
    const candidate = await candidateSession(h);
    const missing = "0123456789ab";
    for (const name of [
      "administrator",
      "trainer",
      "otherManager",
      "recruiterOther",
    ]) {
      expect(await shellFor(name, row.public_id), name).toEqual({
        kind: "NOT_FOUND",
      });
      expect(await overviewFor(name, row.public_id), name).toEqual({
        kind: "NOT_FOUND",
      });
      expect(await shellFor(name, missing), name).toEqual({
        kind: "NOT_FOUND",
      });
    }
    for (const bad of ["../etc", "x".repeat(500), "", "ABC", "0123456789AB"]) {
      expect(await shellFor("manager", bad)).toEqual({ kind: "NOT_FOUND" });
    }
    expect(
      (
        await queryCandidateWorkspaceShell(
          headers(candidate.jar),
          row.public_id,
          deps,
        )
      ).kind,
    ).toBe("UNAUTHENTICATED");
    expect(
      (
        await queryCandidateOverview(
          headers(candidate.jar),
          row.public_id,
          deps,
        )
      ).kind,
    ).toBe("UNAUTHENTICATED");
  });

  it("denies an auditor, because no real audit assignment can cover a candidate yet", async () => {
    const row = await prospect();
    const attempt = await grant(
      h,
      pair,
      accountOf("auditor"),
      "AUDITOR_READ_ONLY",
      "AUDIT_ASSIGNMENT",
      randomUUID(),
    ).then(
      () => "GRANTED",
      () => "REFUSED",
    );
    expect(attempt).toBe("REFUSED");
    expect(await shellFor("auditor", row.public_id)).toEqual({
      kind: "NOT_FOUND",
    });
    expect(await overviewFor("auditor", row.public_id)).toEqual({
      kind: "NOT_FOUND",
    });
  });

  it("keeps answers, contact details, and ids out of every workspace view", async () => {
    const { row } = await submitted();
    for (const name of ["manager", "compliance", "classification"]) {
      const text = JSON.stringify([
        await shell(name, row.public_id),
        await overview(name, row.public_id),
      ]);
      expect(text, name).not.toContain(CANARY);
      expect(text, name).not.toContain("@example.test");
      expect(text, name).not.toContain(PHONE);
      expect(text, name).not.toContain(row.id);
      expect(text, name).not.toContain(accountOf(name));
    }
  });
});
