import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  beginApplicationDraft,
  saveApplicationSection,
} from "@/modules/applications/application/application-commands";
import {
  queryApplicationReview,
  queryApplicationSection,
} from "@/modules/applications/application/application-queries";
import { returnApplication } from "@/modules/applications/application/application-return";
import { submitApplication } from "@/modules/applications/application/application-submission";
import {
  createStaffProspect,
  startOwnCandidacy,
} from "@/modules/candidates/application/candidate-commands";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  queryCandidateOverview,
  queryCandidateWorkspaceShell,
} from "@/modules/candidates/application/candidate-workspace-queries";
import { queryCandidateHome } from "@/modules/candidates/application/candidate-portal-queries";
import {
  placeCandidacyHold,
  removeCandidacyHold,
} from "@/modules/candidates/application/hold-commands";
import { queryWorkQueue } from "@/modules/candidates/application/work-queue-queries";
import {
  acceptApplicationForPrescreen,
  approvePrescreenException,
  notSelectAtPrescreen,
  passPrescreen,
  savePrescreenResponses,
} from "@/modules/applications/application/prescreen-commands";
import { queryPrescreen } from "@/modules/applications/application/prescreen-queries";
import { createAuditRecorder } from "@/modules/audit";
import { createLogger } from "@/shared/logging";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createMemoryDestination } from "../../fixtures/canaries";
import { connect, failingKeys, verify } from "../support/audit";
import { waitForLockWait } from "../support/barriers";
import {
  createHiringCycle,
  transitionHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import {
  activateStaff,
  createBootstrapPair,
  grant,
  headers,
  prepareAuthorizationDatabase,
  signIn,
  stepUp,
  type AuthorizationHarness,
  type BootstrapPair,
  type StaffMember,
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

// M3.3 application review and prescreen (packet M3.3 §14-§17). Real accounts, sessions,
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
const members: Record<string, StaffMember> = {};

const CANARY = "TEST-PRESCREEN-ANSWER-CANARY";
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
      legalLastName: "TEST Prescreen",
      email: `prescreen-${randomUUID().slice(0, 8)}@example.test`,
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
      legalLastName: "TEST Prescreen",
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

const ALL_MET = JSON.stringify({
  availability_fit: "MET",
  experience_reviewed: "MET",
  references_provided: "NOT_APPLICABLE",
  contact_confirmed: "MET",
});
const ONE_UNMET = JSON.stringify({
  availability_fit: "NOT_MET",
  experience_reviewed: "MET",
  references_provided: "MET",
  contact_confirmed: "MET",
});

async function accept(row: Row, actor = as("recruiter"), d = deps) {
  return acceptApplicationForPrescreen(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(row.version),
    },
    actor,
    d,
  );
}

const reviewOf = async (id: string) =>
  (
    await admin.query(
      "SELECT * FROM app.prescreen_review WHERE candidacy_id = $1 ORDER BY accepted_at DESC, id LIMIT 1",
      [id],
    )
  ).rows[0];

/** A submitted application accepted for prescreen. */
async function accepted() {
  const { candidate, row } = await submitted();
  expect(result(await accept(row))).toBe("UPDATED");
  return { candidate, row: await rowOf(row.id) };
}

async function save(
  row: Row,
  responses: string,
  actor = as("recruiter"),
  over: Record<string, string> = {},
) {
  const review = await reviewOf(row.id);
  return savePrescreenResponses(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(review.version),
      responses,
      internalNotes: "TEST-PRESCREEN-NOTE-CANARY",
      ...over,
    },
    actor,
    deps,
  );
}

async function pass(row: Row, actor = as("recruiter"), d = deps) {
  const review = await reviewOf(row.id);
  return passPrescreen(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(review.version),
    },
    actor,
    d,
  );
}

async function notSelect(row: Row, actor = as("recruiter")) {
  const review = await reviewOf(row.id);
  return notSelectAtPrescreen(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(review.version),
      reasonCode: "POSITION_FILLED",
    },
    actor,
    deps,
  );
}

async function approve(row: Row, actor: CandidateActor, d = deps) {
  const review = await reviewOf(row.id);
  return approvePrescreenException(
    {
      commandKey: ckey(),
      candidacyId: row.public_id,
      expectedVersion: String(review.version),
      reasonCode: "EQUIVALENT_EXPERIENCE",
    },
    actor,
    d,
  );
}

const reviewDate = () =>
  new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);

async function hold(row: Row, actor = as("hr")) {
  const fresh = await rowOf(row.id);
  return placeCandidacyHold(
    {
      commandKey: ckey(),
      candidacyId: fresh.public_id,
      expectedVersion: String(fresh.version),
      reasonCode: "INTERNAL_REVIEW",
      internalReason: "TEST-HOLD-REASON-CANARY",
      reviewDate: reviewDate(),
    },
    actor,
    deps,
  );
}

const holdsOf = async (id: string) =>
  (
    await admin.query(
      "SELECT * FROM app.candidacy_hold WHERE candidacy_id = $1 ORDER BY placed_at, id",
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

const stageOf = async (id: string) => {
  const r = await rowOf(id);
  return [r.current_stage, r.status, r.candidate_visible_status];
};

const tasksOf = async (id: string) =>
  (
    await admin.query(
      "SELECT work_type_code, status FROM app.work_item WHERE candidacy_id = $1 AND candidate_action_required = false ORDER BY created_at, id",
      [id],
    )
  ).rows;

const view = async (name: string, publicId: string) => {
  const found = await queryPrescreen(headers(staff[name]!.jar), publicId, deps);
  if (found.kind !== "OK") throw new Error(`prescreen ${found.kind}`);
  return found.view;
};

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "prescreen",
  ));
  h = createOrganizationHarness();
  deps = candidateDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "PS");
  const { position } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "PS-POS",
  );
  const accounts = {
    manager: await activateStaff(h, "ps-manager"),
    hr: await activateStaff(h, "ps-hr"),
    recruiter: await activateStaff(h, "ps-recruiter"),
    recruiterOther: await activateStaff(h, "ps-recruiter-other"),
    compliance: await activateStaff(h, "ps-compliance"),
    classification: await activateStaff(h, "ps-classification"),
    trainer: await activateStaff(h, "ps-trainer"),
    administrator: await activateStaff(h, "ps-admin"),
    otherManager: await activateStaff(h, "ps-other-manager"),
    secondManager: await activateStaff(h, "ps-second-manager"),
    auditor: await activateStaff(h, "ps-auditor"),
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
    ["secondManager", "PSA_MANAGER", "ORGANIZATION", tree.org],
  ] as const;
  for (const [name, role, scope, reference] of grants) {
    await grant(h, pair, accounts[name].accountId, role, scope, reference);
  }
  for (const [name, member] of Object.entries(accounts)) {
    members[name] = member;
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

describe("accept for review", () => {
  it("moves to prescreen, pins the version and checklist, and swaps staff work", async () => {
    const { row } = await submitted();
    expect((await view("recruiter", row.public_id)).actions).toContain(
      "accept",
    );
    expect(result(await accept(row))).toBe("UPDATED");
    expect(await stageOf(row.id)).toEqual([
      "PRESCREEN_REVIEW",
      "ACTIVE",
      "UNDER_REVIEW",
    ]);
    const review = await reviewOf(row.id);
    expect(review.status).toBe("IN_PROGRESS");
    expect(review.accepted_by_account_id).toBe(accountOf("recruiter"));
    expect(review.reviewer_account_id).toBeNull();
    const version = await admin.query(
      "SELECT id FROM app.application_version WHERE candidacy_id = $1 AND status = 'SUBMITTED'",
      [row.id],
    );
    expect(review.application_version_id).toBe(version.rows[0].id);
    expect(await tasksOf(row.id)).toEqual([
      { work_type_code: "REVIEW_SUBMITTED_APPLICATION", status: "COMPLETED" },
      { work_type_code: "COMPLETE_PRESCREEN", status: "OPEN" },
    ]);
    expect(await eventsOf(row.id)).toContain("prescreen.accepted");
    const shown = await view("recruiter", row.public_id);
    expect(shown.checklistDraft).toBe(true);
    expect(shown.items.map((i) => i.code)).toEqual([
      "availability_fit",
      "experience_reviewed",
      "references_provided",
      "contact_confirmed",
    ]);
  });

  it("refuses the wrong stage, role, scope, and a stale or repeated request", async () => {
    const draft = await prospect();
    expect(result(await accept(draft))).toMatch(
      /NOT_AUTHORIZED|INVALID_TRANSITION/,
    );
    const { row } = await submitted();
    for (const name of [
      "manager",
      "compliance",
      "administrator",
      "trainer",
      "otherManager",
      "recruiterOther",
    ]) {
      expect(result(await accept(row, as(name))), name).toMatch(
        /NOT_AUTHORIZED|NOT_FOUND/,
      );
    }
    expect(result(await accept({ ...row, version: row.version + 9 }))).toBe(
      "STALE_VERSION",
    );
    const commandKey = ckey();
    const send = () =>
      acceptApplicationForPrescreen(
        {
          commandKey,
          candidacyId: row.public_id,
          expectedVersion: String(row.version),
        },
        as("recruiter"),
        deps,
      );
    expect(result(await send())).toBe("UPDATED");
    expect(await send()).toMatchObject({ kind: "DONE", replayed: true });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM app.prescreen_review WHERE candidacy_id = $1",
          [row.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(result(await accept(await rowOf(row.id)))).toMatch(
      /NOT_AUTHORIZED|INVALID_TRANSITION/,
    );
  });
});

describe("checklist answers", () => {
  it("saves exact answers and records the reviewer, and refuses anything else", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    const saved = await reviewOf(row.id);
    expect(saved.reviewer_account_id).toBe(accountOf("recruiter"));
    expect(saved.responses_version).toBe(1);
    expect(saved.responses.availability_fit).toBe("MET");
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ made_up_item: "MET" }),
      JSON.stringify({ availability_fit: "MAYBE" }),
      "x".repeat(5000),
    ]) {
      expect(result(await save(row, bad)), bad.slice(0, 20)).toBe(
        "INVALID_INPUT",
      );
    }
    expect(
      result(
        await save(row, ALL_MET, as("recruiter"), {
          internalNotes: "x".repeat(2001),
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      result(
        await save(row, ALL_MET, as("recruiter"), {
          internalNotes: "TEST \u0007 bell",
        }),
      ),
    ).toBe("INVALID_INPUT");
    for (const name of ["compliance", "administrator", "recruiterOther"]) {
      expect(result(await save(row, ALL_MET, as(name))), name).toMatch(
        /NOT_AUTHORIZED|NOT_FOUND/,
      );
    }
    const unchanged = await reviewOf(row.id);
    expect(unchanged.responses_version).toBe(1);
    expect(
      result(
        await savePrescreenResponses(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(unchanged.version + 5),
            responses: ALL_MET,
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("STALE_VERSION");
  });
});

describe("pass and not selected", () => {
  it("passes only with every answer in, moves to Interview, and creates no downstream record", async () => {
    const { row } = await accepted();
    expect(result(await pass(row))).toBe("PRESCREEN_INCOMPLETE");
    expect(
      result(await save(row, JSON.stringify({ availability_fit: "MET" }))),
    ).toBe("UPDATED");
    expect(result(await pass(row))).toBe("PRESCREEN_INCOMPLETE");
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    expect((await view("recruiter", row.public_id)).actions).toContain("pass");
    expect(result(await pass(row))).toBe("UPDATED");
    expect(await stageOf(row.id)).toEqual([
      "INTERVIEW",
      "ACTIVE",
      "INTERVIEW_STEP",
    ]);
    const done = await reviewOf(row.id);
    expect(done.status).toBe("PASSED");
    expect(done.decided_by_account_id).toBe(accountOf("recruiter"));
    // No open staff work, and no invented interview step.
    expect(
      (await tasksOf(row.id)).filter(
        (t: { status: string }) => t.status === "OPEN",
      ),
    ).toEqual([]);
    expect(await eventsOf(row.id)).toContain("prescreen.passed");
    // A finished prescreen can't change.
    expect(result(await save(row, ONE_UNMET))).toMatch(
      /NOT_AUTHORIZED|INVALID_TRANSITION/,
    );
    await expect(
      admin.query(
        "UPDATE app.prescreen_review SET internal_notes = 'x', version = version + 1 WHERE id = $1",
        [done.id],
      ),
    ).rejects.toMatchObject({ code: "CN005" });
  });

  it("closes as not selected, keeps the reason internal, and sends nothing", async () => {
    const { row, candidate } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    expect(
      result(
        await notSelectAtPrescreen(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String((await reviewOf(row.id)).version),
            reasonCode: "MADE_UP",
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(result(await notSelect(row))).toBe("UPDATED");
    const closed = await rowOf(row.id);
    expect([closed.status, closed.candidate_visible_status]).toEqual([
      "TERMINAL",
      "CLOSED",
    ]);
    expect(closed.closure_reason_code).toBe("POSITION_FILLED");
    expect((await reviewOf(row.id)).not_selected_reason_code).toBe(
      "POSITION_FILLED",
    );
    expect(await eventsOf(row.id)).toContain("prescreen.not_selected");
    const { rows } = await admin.query(
      "SELECT event_type FROM app.outbox_event WHERE aggregate_id = $1",
      [row.id],
    );
    expect(rows.map((r) => r.event_type)).not.toContain(
      "APPLICATION_RETURNED_EMAIL",
    );
    expect(rows).toHaveLength(1); // Only the application-received email.

    // The candidate's own view has the generic status and no internal words.
    const home = await queryCandidateHome(
      headers(candidate.jar),
      undefined,
      deps,
    );
    const text = JSON.stringify(home);
    expect(text).toContain("Application not continuing");
    expect(text).not.toContain("POSITION_FILLED");
    expect(text).not.toContain("Position filled");
    expect(text).not.toContain("TEST-PRESCREEN-NOTE-CANARY");
  });

  it("lets exactly one of a concurrent pass and not-selected win", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.candidacy WHERE id = $1 FOR UPDATE", [
      row.id,
    ]);
    const race = [pass(row), notSelect(row)];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const outcomes = (await Promise.all(race)).map(result);
    expect(outcomes.filter((o) => o === "UPDATED")).toHaveLength(1);
    expect(
      outcomes.filter(
        (o) => o === "UPDATED" || /STALE|INVALID|NOT_AUTHORIZED/.test(o),
      ),
    ).toHaveLength(2);
  });

  it("rolls everything back when the audit write fails", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    const failing = {
      ...deps,
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    };
    await expect(pass(row, as("recruiter"), failing)).rejects.toThrow();
    expect((await stageOf(row.id))[0]).toBe("PRESCREEN_REVIEW");
    expect((await reviewOf(row.id)).status).toBe("IN_PROGRESS");
    expect((await verify(db)).ok).toBe(true);
  });
});

describe("authorized exception", () => {
  it("leaves completing a prescreen to Recruiters and HR until a manager is designated", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ALL_MET, as("manager")))).toBe(
      "NOT_AUTHORIZED",
    );
    expect(result(await save(row, ALL_MET, as("hr")))).toBe("UPDATED");
    expect(result(await pass(row, as("manager")))).toBe("NOT_AUTHORIZED");
    const seen = (await view("manager", row.public_id)).actions;
    expect(seen).not.toContain("save");
    expect(seen).not.toContain("pass");
    expect(seen).toContain("place_hold");
  });

  it("needs a manager, and a different person from the reviewer", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ONE_UNMET))).toBe("UPDATED");
    expect(result(await pass(row))).toBe("EXCEPTION_REQUIRED");
    for (const name of ["recruiter", "hr", "administrator", "otherManager"]) {
      expect(result(await approve(row, as(name))), name).toMatch(
        /NOT_AUTHORIZED|NOT_FOUND/,
      );
    }
    // Recent sign-in is required.
    expect(result(await approve(row, as("manager")))).toBe(
      "REAUTHENTICATION_REQUIRED",
    );
    await stepUp(h, members.manager!, staff.manager!, "PRESCREEN_EXCEPTION");
    await stepUp(
      h,
      members.secondManager!,
      staff.secondManager!,
      "PRESCREEN_EXCEPTION",
    );

    // Managers can't answer a checklist without a designation, and none exist
    // yet, so stand in the database's state for one who did.
    await admin.query(
      "UPDATE app.prescreen_review SET reviewer_account_id = $2, version = version + 1 WHERE id = $1",
      [(await reviewOf(row.id)).id, accountOf("manager")],
    );
    expect(result(await approve(row, as("manager")))).toBe(
      "EXCEPTION_SELF_APPROVAL",
    );
    expect((await view("manager", row.public_id)).actions).not.toContain(
      "exception",
    );

    expect((await view("secondManager", row.public_id)).actions).toContain(
      "exception",
    );
    expect(result(await approve(row, as("secondManager")))).toBe("UPDATED");
    const approved = await reviewOf(row.id);
    expect(approved.exception_by_account_id).toBe(accountOf("secondManager"));
    expect(approved.exception_reason_code).toBe("EQUIVALENT_EXPERIENCE");
    expect(await eventsOf(row.id)).toContain("prescreen.exception_approved");
    expect(result(await approve(row, as("secondManager")))).toBe(
      "EXCEPTION_NOT_NEEDED",
    );

    expect(result(await pass(row, as("recruiter")))).toBe("UPDATED");
    expect((await stageOf(row.id))[0]).toBe("INTERVIEW");
    expect((await view("recruiter", row.public_id)).exception?.reason).toBe(
      "Equivalent experience",
    );
  });

  it("is void once the answers change, and the database refuses self-approval", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ONE_UNMET))).toBe("UPDATED");
    await stepUp(
      h,
      members.secondManager!,
      staff.secondManager!,
      "PRESCREEN_EXCEPTION",
    );
    expect(result(await approve(row, as("secondManager")))).toBe("UPDATED");
    expect(result(await save(row, ONE_UNMET))).toBe("UPDATED");
    const voided = await reviewOf(row.id);
    expect(voided.exception_reason_code).toBeNull();
    expect(result(await pass(row))).toBe("EXCEPTION_REQUIRED");
    expect(await eventsOf(row.id)).toContain("prescreen.responses_saved");
    await expect(
      admin.query(
        "UPDATE app.prescreen_review SET exception_reason_code = 'X', exception_by_account_id = reviewer_account_id, exception_at = now(), exception_responses_version = responses_version, version = version + 1 WHERE id = $1",
        [voided.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("isn't available when nothing is unmet", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    await stepUp(
      h,
      members.secondManager!,
      staff.secondManager!,
      "PRESCREEN_EXCEPTION",
    );
    expect(result(await approve(row, as("secondManager")))).toBe(
      "EXCEPTION_NOT_NEEDED",
    );
  });
});

describe("holds", () => {
  it("lets only HR and PSA Managers place one, and blocks every decision while it's active", async () => {
    const { row } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    for (const name of [
      "recruiter",
      "compliance",
      "classification",
      "trainer",
      "administrator",
      "otherManager",
    ]) {
      expect(result(await hold(row, as(name))), name).toMatch(
        /NOT_AUTHORIZED|NOT_FOUND/,
      );
    }
    expect(await holdsOf(row.id)).toEqual([]);

    const before = await rowOf(row.id);
    expect(result(await hold(row, as("hr")))).toBe("UPDATED");
    const [active] = await holdsOf(row.id);
    expect(active.status).toBe("ACTIVE");
    expect(active.placed_by_account_id).toBe(accountOf("hr"));
    // The stage and what the candidate sees don't change.
    expect(await stageOf(row.id)).toEqual([
      "PRESCREEN_REVIEW",
      "ACTIVE",
      "UNDER_REVIEW",
    ]);
    expect((await rowOf(row.id)).version).toBe(before.version);
    expect(result(await hold(row, as("manager")))).toBe("ALREADY_ON_HOLD");

    expect(result(await pass(row))).toBe("ON_HOLD");
    expect(result(await notSelect(row))).toBe("ON_HOLD");
    expect(result(await save(row, ONE_UNMET))).toBe("ON_HOLD");
    const blocked = await view("recruiter", row.public_id);
    expect(blocked.hold?.reason).toBe("TEST-HOLD-REASON-CANARY");
    expect(blocked.actions).toEqual([]);

    // The header and queue show the category, not the reason.
    const shell = await queryCandidateWorkspaceShell(
      headers(staff.recruiter!.jar),
      row.public_id,
      deps,
    );
    if (shell.kind !== "OK") throw new Error(shell.kind);
    expect(shell.view.hold).toEqual({ label: "Internal review" });
    expect(JSON.stringify(shell.view)).not.toContain("CANARY");
    const overview = await queryCandidateOverview(
      headers(staff.compliance!.jar),
      row.public_id,
      deps,
    );
    if (overview.kind !== "OK") throw new Error(overview.kind);
    expect(
      overview.view.blockers.map((b: { code: string }) => b.code),
    ).toContain("ON_HOLD");
    expect(JSON.stringify(overview.view)).not.toContain("CANARY");
    const queue = await queryWorkQueue(
      headers(staff.manager!.jar),
      { exception: "ON_HOLD" },
      deps,
    );
    if (queue.kind !== "OK") throw new Error(queue.kind);
    expect(queue.view.items.map((i) => i.id)).toContain(row.public_id);

    expect(
      result(
        await removeCandidacyHold(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(active.version),
            reasonCode: "RESOLVED",
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toMatch(/NOT_AUTHORIZED|NOT_FOUND/);
    expect(
      result(
        await removeCandidacyHold(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(active.version),
            reasonCode: "RESOLVED",
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    expect(result(await pass(row))).toBe("UPDATED");
    const events = await eventsOf(row.id);
    expect(events).toContain("candidacy.hold_placed");
    expect(events).toContain("candidacy.hold_removed");
    const [removed] = await holdsOf(row.id);
    expect(removed.status).toBe("REMOVED");
    expect(removed.internal_reason).toBe("TEST-HOLD-REASON-CANARY");
    const { rows } = await admin.query(
      "SELECT metadata_json::text AS m FROM audit.audit_event WHERE target_id = $1",
      [row.id],
    );
    for (const { m } of rows) {
      expect(m).not.toContain("CANARY");
    }
  });

  it("refuses bad input, other stages, and changes to a hold's history", async () => {
    const { row } = await accepted();
    const fresh = await rowOf(row.id);
    const place = (over: Readonly<Record<string, string | undefined>>) =>
      placeCandidacyHold(
        {
          commandKey: ckey(),
          candidacyId: fresh.public_id,
          expectedVersion: String(fresh.version),
          reasonCode: "INTERNAL_REVIEW",
          internalReason: "TEST reason",
          reviewDate: reviewDate(),
          ...over,
        },
        as("hr"),
        deps,
      );
    for (const over of [
      { reasonCode: "MADE_UP" },
      { internalReason: "" },
      { internalReason: "x".repeat(1001) },
      { reviewDate: "2020-01-01" },
      { reviewDate: "someday" },
      {
        reviewDate: new Date(Date.now() + 400 * DAY).toISOString().slice(0, 10),
      },
    ]) {
      expect(result(await place(over)), JSON.stringify(over).slice(0, 30)).toBe(
        "INVALID_INPUT",
      );
    }
    expect(await holdsOf(row.id)).toEqual([]);
    const notYet = await submitted();
    expect(result(await hold(notYet.row, as("hr")))).toMatch(
      /NOT_AUTHORIZED|INVALID_TRANSITION/,
    );

    expect(result(await hold(row, as("hr")))).toBe("UPDATED");
    const [active] = await holdsOf(row.id);
    await expect(
      admin.query(
        "UPDATE app.candidacy_hold SET internal_reason = 'x', version = version + 1 WHERE id = $1",
        [active.id],
      ),
    ).rejects.toMatchObject({ code: "CN004" });
    const runtime = await connect(db.urls.app);
    const code = (statement: string) =>
      runtime.query(statement).then(
        () => "OK",
        (error: { code: string }) => error.code,
      );
    try {
      for (const table of ["candidacy_hold", "prescreen_review"]) {
        expect(await code(`DELETE FROM app.${table}`), table).toBe("42501");
      }
      expect(
        await code(
          "UPDATE app.prescreen_checklist_version SET review_status = 'APPROVED'",
        ),
      ).toBe("42501");
      expect(await code("DELETE FROM app.prescreen_checklist_version")).toBe(
        "42501",
      );
    } finally {
      await runtime.end();
    }
  });
});

describe("additional information", () => {
  it("reuses the return flow, ends this review, and starts a new one on resubmission", async () => {
    const { row, candidate } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    const fresh = await rowOf(row.id);
    const send = () =>
      returnApplication(
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
      );
    expect(result(await hold(row, as("hr")))).toBe("UPDATED");
    expect(result(await send())).toBe("ON_HOLD");
    const [active] = await holdsOf(row.id);
    await removeCandidacyHold(
      {
        commandKey: ckey(),
        candidacyId: row.public_id,
        expectedVersion: String(active.version),
        reasonCode: "RESOLVED",
      },
      as("hr"),
      deps,
    );
    expect(result(await send())).toBe("RETURNED");
    expect((await reviewOf(row.id)).status).toBe("RETURNED");
    expect((await stageOf(row.id))[0]).toBe("APPLICATION_INCOMPLETE");
    expect(
      (await tasksOf(row.id)).filter(
        (t: { status: string }) => t.status === "OPEN",
      ),
    ).toEqual([]);

    // The candidate corrects and resubmits, and staff start a fresh review. The
    // first one stays as history, tied to the version it covered.
    await beginApplicationDraft(
      { commandKey: ckey(), candidacyId: row.public_id },
      candidate.actor,
      deps,
    );
    const section = await queryApplicationSection(
      headers(candidate.jar),
      row.public_id,
      "availability",
      deps,
    );
    if (section.kind !== "OK") throw new Error(section.kind);
    await saveApplicationSection(
      {
        commandKey: ckey(),
        candidacyId: row.public_id,
        sectionCode: "availability",
        expectedVersion: String(section.view.version),
        answers: JSON.stringify({
          ...answers.availability,
          earliest_start_date: "2027-01-15",
        }),
      },
      candidate.actor,
      deps,
    );
    const review = await queryApplicationReview(
      headers(candidate.jar),
      row.public_id,
      deps,
    );
    if (review.kind !== "OK") throw new Error(review.kind);
    expect(
      result(
        await submitApplication(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            certificationVersion: String(review.view.certification.version),
            certified: "yes",
            signature: "TEST Ana Prescreen",
            reviewToken: review.view.reviewToken,
          },
          candidate.actor,
          deps,
        ),
      ),
    ).toBe("SUBMITTED");
    const first = await reviewOf(row.id);
    expect(result(await accept(await rowOf(row.id)))).toBe("UPDATED");
    const { rows } = await admin.query(
      "SELECT status, application_version_id FROM app.prescreen_review WHERE candidacy_id = $1 ORDER BY accepted_at, id",
      [row.id],
    );
    expect(rows.map((r) => r.status)).toEqual(["RETURNED", "IN_PROGRESS"]);
    expect(rows[1].application_version_id).not.toBe(
      first.application_version_id,
    );
  });
});

describe("nondisclosure", () => {
  it("gives outsiders one identical not-found and keeps notes out of other views", async () => {
    const { row, candidate } = await accepted();
    expect(result(await save(row, ALL_MET))).toBe("UPDATED");
    for (const name of [
      "administrator",
      "trainer",
      "compliance",
      "classification",
      "otherManager",
      "recruiterOther",
    ]) {
      expect(
        await queryPrescreen(headers(staff[name]!.jar), row.public_id, deps),
        name,
      ).toEqual({ kind: "NOT_FOUND" });
    }
    expect(
      await queryPrescreen(headers(staff.manager!.jar), "0123456789ab", deps),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(
      (await queryPrescreen(headers(candidate.jar), row.public_id, deps)).kind,
    ).toBe("UNAUTHENTICATED");

    const shown = await view("hr", row.public_id);
    expect(shown.notes).toBe("TEST-PRESCREEN-NOTE-CANARY");
    const text = JSON.stringify(shown);
    expect(text).not.toContain(accountOf("recruiter"));
    expect(text).not.toContain(row.id);
    expect(text).not.toContain("@example.test");

    const compliance = await queryCandidateWorkspaceShell(
      headers(staff.compliance!.jar),
      row.public_id,
      deps,
    );
    if (compliance.kind !== "OK") throw new Error(compliance.kind);
    expect(
      compliance.view.tabs.map((t: { key: string }) => t.key),
    ).not.toContain("prescreen");
    const manager = await queryCandidateWorkspaceShell(
      headers(staff.manager!.jar),
      row.public_id,
      deps,
    );
    if (manager.kind !== "OK") throw new Error(manager.kind);
    expect(manager.view.tabs.map((t: { key: string }) => t.key)).toContain(
      "prescreen",
    );
    const candidateHome = JSON.stringify(
      await queryCandidateHome(headers(candidate.jar), undefined, deps),
    );
    expect(candidateHome).toContain("Application under review");
    expect(candidateHome).not.toContain("CANARY");
    const { rows } = await admin.query(
      "SELECT metadata_json::text AS m FROM audit.audit_event WHERE target_id = $1",
      [row.id],
    );
    for (const { m } of rows) expect(m).not.toContain("CANARY");
  });
});
