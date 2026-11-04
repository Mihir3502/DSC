import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  beginApplicationDraft,
  saveApplicationSection,
} from "@/modules/applications/application/application-commands";
import { dispatchApplicationEmails } from "@/modules/applications/application/application-outbox";
import {
  queryApplicationOverview,
  queryApplicationReview,
  queryApplicationSection,
  queryStaffApplicationReview,
} from "@/modules/applications/application/application-queries";
import { returnApplication } from "@/modules/applications/application/application-return";
import { submitApplication } from "@/modules/applications/application/application-submission";
import { createAuditRecorder } from "@/modules/audit";
import { startOwnCandidacy } from "@/modules/candidates/application/candidate-commands";
import { queryCandidateHome } from "@/modules/candidates/application/candidate-portal-queries";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  uploadApplicationAttachment,
  type DocumentDependencies,
} from "@/modules/documents/application/attachment-commands";
import { TestMalwareScanner } from "@/modules/documents/infrastructure/document-providers";
import { LocalDocumentStorage } from "@/modules/documents/infrastructure/local-document-storage";
import { renderAuthEmail } from "@/modules/identity-access/infrastructure/auth-email";
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
  type CandidateSession,
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

// M2.7 return and correction (packet M2.7 §14-§17; AC-M2.7-01..05, X1, X2).
// Real accounts, sessions, and PostgreSQL. Every value is synthetic.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let deps: DocumentDependencies;
let pair: BootstrapPair;
let tree: Hierarchy;
let positionId: string;
let root: string;
const staff: Record<string, StaffSession> = {};

const CANARY = "TEST-ANSWER-CANARY-M26";
const local = (d: Date) => toZonedLocal(d, "America/New_York");
const pdf = (text = "TEST document") =>
  new TextEncoder().encode(`%PDF-1.7\n${text}\n`);

const complete: Record<string, Record<string, unknown>> = {
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

async function openCycle(branchId: string) {
  const cdeps = configDeps(h);
  const actor = bootstrapActor(pair.creator);
  const cycle = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId,
        branchId,
        code: `C-${randomUUID().slice(0, 8)}`.toUpperCase(),
        internalLabel: "TEST internal cycle",
        opensAt: local(new Date(Date.now() - 3_600_000)),
        closesAt: local(new Date(Date.now() + 7 * 86_400_000)),
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

type Started = Readonly<{
  candidate: CandidateSession;
  candidacyId: string;
  internalId: string;
  cycleId: string;
}>;

async function started(options = { fill: true }): Promise<Started> {
  const opened = await openCycle(tree.branch);
  const candidate = await candidateSession(h);
  const result = await startOwnCandidacy(
    {
      commandKey: ckey(),
      handoffToken: handoffFor(h, opened.ref),
      legalFirstName: "TEST Ana",
      legalLastName: "TEST Ríos",
    },
    candidate.actor,
    deps,
  );
  if (result.kind !== "DONE") throw new Error("start failed");
  const { rows } = await admin.query<{ public_id: string }>(
    "SELECT public_id FROM app.candidacy WHERE id = $1",
    [result.targetId],
  );
  const candidacyId = rows[0]!.public_id;
  await beginApplicationDraft(
    { commandKey: ckey(), candidacyId },
    candidate.actor,
    deps,
  );
  const s = {
    candidate,
    candidacyId,
    internalId: result.targetId,
    cycleId: opened.id,
  };
  if (options.fill) {
    for (const [section, answers] of Object.entries(complete)) {
      await save(s, section, answers);
    }
  }
  return s;
}

const save = (
  s: Pick<Started, "candidate" | "candidacyId">,
  section: string,
  answers: unknown,
  expectedVersion = "0",
) =>
  saveApplicationSection(
    {
      commandKey: ckey(),
      candidacyId: s.candidacyId,
      sectionCode: section,
      expectedVersion,
      answers: JSON.stringify(answers),
    },
    s.candidate.actor,
    deps,
  );

async function review(s: Started) {
  const result = await queryApplicationReview(
    headers(s.candidate.jar),
    s.candidacyId,
    deps,
  );
  if (result.kind !== "OK") throw new Error(`no review: ${result.kind}`);
  return result.view;
}

async function submit(
  s: Started,
  over: Record<string, string | undefined> = {},
  actor: CandidateActor = s.candidate.actor,
  useDeps: DocumentDependencies = deps,
) {
  const view = await review(s);
  return submitApplication(
    {
      commandKey: ckey(),
      candidacyId: s.candidacyId,
      certificationVersion: String(view.certification.version),
      certified: "yes",
      signature: "TEST Ana Ríos",
      reviewToken: view.reviewToken,
      ...over,
    },
    actor,
    useDeps,
  );
}

const result = (value: unknown) => outcome(value as never);

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

const submissions = (candidacy: string) =>
  count(
    "SELECT count(*)::int AS n FROM app.application_submission WHERE candidacy_id = $1",
    [candidacy],
  );

const stateOf = async (candidacy: string) => {
  const { rows } = await admin.query(
    `SELECT c.current_stage, c.candidate_visible_status, v.status AS version_status
       FROM app.candidacy c JOIN app.application_version v ON v.candidacy_id = c.id
      WHERE c.id = $1`,
    [candidacy],
  );
  return rows[0];
};

const tasksOf = async (candidacy: string) =>
  (
    await admin.query(
      "SELECT work_type_code, status, candidate_action_required FROM app.work_item WHERE candidacy_id = $1 ORDER BY work_type_code",
      [candidacy],
    )
  ).rows;

const outboxOf = async (candidacy: string) =>
  (
    await admin.query(
      "SELECT event_type, status, attempt_count, last_error_code FROM app.outbox_event WHERE aggregate_id = $1",
      [candidacy],
    )
  ).rows;

const eventsOf = async (candidacy: string) =>
  (
    await admin.query<{ event_name: string }>(
      "SELECT event_name FROM audit.audit_event WHERE target_id = $1 ORDER BY chain_sequence",
      [candidacy],
    )
  ).rows.map((r) => r.event_name);

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "correction",
  ));
  h = createOrganizationHarness();
  root = mkdtempSync(path.join(tmpdir(), "psa-correction-"));
  deps = {
    ...candidateDeps(h),
    storage: new LocalDocumentStorage(root),
    scanner: new TestMalwareScanner(),
  };
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "COR");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "COR-POS",
  ));
  const accounts = {
    recruiter: await activateStaff(h, "cor-recruiter"),
    recruiterOther: await activateStaff(h, "cor-recruiter-other"),
    manager: await activateStaff(h, "cor-manager"),
    administrator: await activateStaff(h, "cor-admin"),
  };
  await grant(
    h,
    pair,
    accounts.recruiter.accountId,
    "RECRUITER",
    "BRANCH",
    tree.branch,
  );
  await grant(
    h,
    pair,
    accounts.recruiterOther.accountId,
    "RECRUITER",
    "BRANCH",
    tree.branch2,
  );
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
    accounts.administrator.accountId,
    "SYSTEM_ADMINISTRATOR",
    "ORGANIZATION",
    tree.org,
  );
  for (const [name, member] of Object.entries(accounts))
    staff[name] = await signIn(h, member);
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) await dropOwnedDatabase(ctx, db.name);
  if (root) rmSync(root, { recursive: true, force: true });
});

const INSTRUCTIONS = "TEST-INSTRUCTION-CANARY: please add your start date.";

const versionOf = async (candidacy: string) =>
  (
    await admin.query<{ version: number }>(
      "SELECT version FROM app.candidacy WHERE id = $1",
      [candidacy],
    )
  ).rows[0]!.version;

const staffActor = (name: string): CandidateActor => ({
  kind: "STAFF",
  principal: staff[name]!.principal,
});

async function sendBack(
  s: Started,
  over: Record<string, string | undefined> = {},
  actor: CandidateActor = staffActor("recruiter"),
  useDeps: DocumentDependencies = deps,
) {
  return returnApplication(
    {
      commandKey: ckey(),
      candidacyId: s.candidacyId,
      expectedVersion: String(await versionOf(s.internalId)),
      reasonCode: "INCOMPLETE_INFORMATION",
      instructions: INSTRUCTIONS,
      selection: JSON.stringify({ availability: ["earliest_start_date"] }),
      ...over,
    },
    actor,
    useDeps,
  );
}

async function submittedCandidate() {
  const s = await started();
  expect(result(await submit(s))).toBe("SUBMITTED");
  return s;
}

const versions = async (candidacy: string) =>
  (
    await admin.query(
      "SELECT version_number, status FROM app.application_version WHERE candidacy_id = $1 ORDER BY version_number",
      [candidacy],
    )
  ).rows;

const beginCorrection = (s: Started) =>
  beginApplicationDraft(
    { commandKey: ckey(), candidacyId: s.candidacyId },
    s.candidate.actor,
    deps,
  );

const sectionVersion = async (s: Started, section: string) => {
  const view = await queryApplicationSection(
    headers(s.candidate.jar),
    s.candidacyId,
    section,
    deps,
  );
  if (view.kind !== "OK") throw new Error(`no section ${section}`);
  return view.view;
};

describe("returning (AC-M2.7-01/02)", () => {
  it("records the reason and selection, moves the stage back, swaps tasks, and keeps the submission", async () => {
    const s = await submittedCandidate();
    expect(result(await sendBack(s))).toBe("RETURNED");
    expect(await stateOf(s.internalId)).toEqual({
      current_stage: "APPLICATION_INCOMPLETE",
      candidate_visible_status: "APPLICATION_STARTED",
      version_status: "RETURNED",
    });
    expect(
      (await tasksOf(s.internalId)).map((t) => [t.work_type_code, t.status]),
    ).toEqual([
      ["COMPLETE_APPLICATION", "COMPLETED"],
      ["CORRECT_APPLICATION", "OPEN"],
      ["REVIEW_SUBMITTED_APPLICATION", "COMPLETED"],
    ]);
    expect(await submissions(s.internalId)).toBe(1);
    const { rows } = await admin.query(
      "SELECT reason_code, instructions, reopened, attachments_reopened FROM app.application_return WHERE candidacy_id = $1",
      [s.internalId],
    );
    expect(rows).toEqual([
      {
        reason_code: "INCOMPLETE_INFORMATION",
        instructions: INSTRUCTIONS,
        reopened: { availability: ["earliest_start_date"] },
        attachments_reopened: false,
      },
    ]);
    const events = await eventsOf(s.internalId);
    expect(events).toContain("application.returned");
    const audit = await admin.query(
      "SELECT row_to_json(e)::text AS row FROM audit.audit_event e WHERE target_id = $1",
      [s.internalId],
    );
    expect(audit.rows.map((r) => r.row).join("")).not.toContain(INSTRUCTIONS);
    expect(
      (await outboxOf(s.internalId)).map((o) => o.event_type).sort(),
    ).toEqual(["APPLICATION_RECEIVED_EMAIL", "APPLICATION_RETURNED_EMAIL"]);
  });

  it("refuses a bad selection, reason, or instructions, and changes nothing", async () => {
    const s = await submittedCandidate();
    for (const [over, expected] of [
      [{ selection: "{}" }, "INVALID_INPUT"],
      [{ selection: "not json" }, "INVALID_INPUT"],
      [{ selection: JSON.stringify({ made_up: [] }) }, "INVALID_INPUT"],
      [
        { selection: JSON.stringify({ availability: ["made_up"] }) },
        "INVALID_INPUT",
      ],
      [{ selection: JSON.stringify(["availability"]) }, "INVALID_INPUT"],
      [{ reasonCode: "BECAUSE" }, "INVALID_INPUT"],
      [{ reasonCode: "__proto__" }, "INVALID_INPUT"],
      [{ instructions: " " }, "INVALID_INPUT"],
      [{ instructions: "x".repeat(1001) }, "INVALID_INPUT"],
      [{ instructions: "TEST‮bidi" }, "INVALID_INPUT"],
      [{ attachments: "maybe" }, "INVALID_INPUT"],
      [{ expectedVersion: "abc" }, "INVALID_INPUT"],
      [{ expectedVersion: "999" }, "STALE_VERSION"],
      [{ commandKey: "not-a-key" }, "INVALID_INPUT"],
    ] as const) {
      expect(result(await sendBack(s, over)), JSON.stringify(over)).toBe(
        expected,
      );
    }
    expect(await stateOf(s.internalId)).toMatchObject({
      current_stage: "APPLICATION_SUBMITTED",
      version_status: "SUBMITTED",
    });
    // Attachments alone are a valid selection.
    expect(
      result(await sendBack(s, { selection: "{}", attachments: "yes" })),
    ).toBe("RETURNED");
  });

  it("refuses an application that isn't submitted, and a second return", async () => {
    const draft = await started();
    expect(result(await sendBack(draft))).toBe("NOT_AUTHORIZED");
    const s = await submittedCandidate();
    expect(result(await sendBack(s))).toBe("RETURNED");
    expect(result(await sendBack(s))).toBe("NOT_AUTHORIZED");
  });

  it("replays the same key once, and serializes concurrent returns", async () => {
    const s = await submittedCandidate();
    const k = ckey();
    const version = String(await versionOf(s.internalId));
    const send = (commandKey: string, instructions = INSTRUCTIONS) =>
      returnApplication(
        {
          commandKey,
          candidacyId: s.candidacyId,
          expectedVersion: version,
          reasonCode: "OTHER",
          instructions,
          selection: JSON.stringify({ education: [] }),
        },
        staffActor("recruiter"),
        deps,
      );
    expect(result(await send(k))).toBe("RETURNED");
    expect(await send(k)).toMatchObject({ replayed: true });
    expect(result(await send(k, "TEST different"))).toBe(
      "COMMAND_KEY_CONFLICT",
    );

    const raced = await submittedCandidate();
    const racedVersion = String(await versionOf(raced.internalId));
    const attempt = () =>
      returnApplication(
        {
          commandKey: ckey(),
          candidacyId: raced.candidacyId,
          expectedVersion: racedVersion,
          reasonCode: "OTHER",
          instructions: INSTRUCTIONS,
          selection: JSON.stringify({ education: [] }),
        },
        staffActor("recruiter"),
        deps,
      );
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.candidacy WHERE id = $1 FOR UPDATE", [
      raced.internalId,
    ]);
    const race = [attempt(), attempt()];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const outcomes = (await Promise.all(race)).map(result);
    expect(outcomes.filter((o) => o === "RETURNED")).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.application_return WHERE candidacy_id = $1",
        [raced.internalId],
      ),
    ).toBe(1);
  });

  it("rolls everything back when the audit append fails", async () => {
    const s = await submittedCandidate();
    const failing: DocumentDependencies = {
      ...deps,
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    };
    await expect(
      sendBack(s, {}, staffActor("recruiter"), failing),
    ).rejects.toThrow();
    expect(await stateOf(s.internalId)).toMatchObject({
      current_stage: "APPLICATION_SUBMITTED",
      version_status: "SUBMITTED",
    });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.application_return WHERE candidacy_id = $1",
        [s.internalId],
      ),
    ).toBe(0);
  });
});

describe("authorization (AC-M2.7-X1)", () => {
  it("limits reading and returning to scoped staff, and hides it from everyone else the same way", async () => {
    const s = await submittedCandidate();
    const review = (name: string) =>
      queryStaffApplicationReview(
        headers(staff[name]!.jar),
        s.candidacyId,
        deps,
      );
    const seen = await review("recruiter");
    if (seen.kind !== "OK") throw new Error("no review");
    expect(seen.view.canReturn).toBe(true);
    expect(JSON.stringify(seen.view)).toContain(CANARY);
    expect(JSON.stringify(seen.view)).not.toContain(s.internalId);
    for (const name of ["recruiterOther", "administrator"]) {
      expect(await review(name), name).toEqual({ kind: "NOT_FOUND" });
      expect(result(await sendBack(s, {}, staffActor(name))), name).toBe(
        "NOT_AUTHORIZED",
      );
    }
    expect(
      await queryStaffApplicationReview(
        headers(staff.recruiter!.jar),
        "abcdefghjkmn",
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(
      await queryStaffApplicationReview(
        headers(s.candidate.jar),
        s.candidacyId,
        deps,
      ),
    ).toEqual({ kind: "UNAUTHENTICATED" });
    // A candidate can't return their own application.
    expect(result(await sendBack(s, {}, s.candidate.actor))).toBe(
      "NOT_AUTHORIZED",
    );
    expect((await stateOf(s.internalId)).current_stage).toBe(
      "APPLICATION_SUBMITTED",
    );
  });

  it("hides a candidate's correction from another candidate", async () => {
    const s = await submittedCandidate();
    await sendBack(s);
    const other = await started({ fill: false });
    expect(
      await queryApplicationOverview(
        headers(other.candidate.jar),
        s.candidacyId,
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    const attempt = await beginApplicationDraft(
      { commandKey: ckey(), candidacyId: s.candidacyId },
      other.candidate.actor,
      deps,
    );
    expect(attempt).toMatchObject({ kind: "REFUSED" });
    expect(await versions(s.internalId)).toHaveLength(1);
  });
});

describe("correcting (AC-M2.7-02/03/04)", () => {
  it("shows the reason, creates a pre-filled new version, and reopens only what was selected", async () => {
    const s = await submittedCandidate();
    await sendBack(s);
    const session = headers(s.candidate.jar);
    const before = await queryApplicationOverview(session, s.candidacyId, deps);
    expect(before).toMatchObject({
      kind: "OK",
      view: {
        started: false,
        submitted: false,
        correction: {
          reason: "Some information is missing",
          instructions: INSTRUCTIONS,
        },
      },
    });
    expect(
      await queryCandidateHome(session, s.candidacyId, deps),
    ).toMatchObject({
      kind: "OK",
      view: { nextAction: { title: "Correct your application" } },
    });
    expect(result(await beginCorrection(s))).toBe("CORRECTION_STARTED");
    expect(result(await beginCorrection(s))).toBe("EXISTING");
    expect(await versions(s.internalId)).toEqual([
      { version_number: 1, status: "RETURNED" },
      { version_number: 2, status: "DRAFT" },
    ]);
    const open = await sectionVersion(s, "availability");
    expect(open.correction?.instructions).toBe(INSTRUCTIONS);
    expect(
      open.fields.find((f) => f.code === "earliest_start_date"),
    ).toMatchObject({ flagged: true, value: "2026-12-01" });
    expect(open.fields.find((f) => f.code === "available_days")).toMatchObject({
      flagged: false,
      value: ["monday"],
    });
    expect(open.status).toBe("Needs correction");
    // Other sections stay closed, on both read and write.
    expect(
      await queryApplicationSection(session, s.candidacyId, "education", deps),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(
      result(
        await save(s, "education", { highest_education: "associate" }, "1"),
      ),
    ).toBe("INVALID_TRANSITION");
    expect(
      await uploadApplicationAttachment(
        {
          commandKey: ckey(),
          candidacyId: s.candidacyId,
          category: "RESUME",
          fileName: "TEST later.pdf",
          declaredType: "application/pdf",
          bytes: pdf("TEST later"),
        },
        s.candidate.actor,
        deps,
      ),
    ).toEqual({ kind: "REFUSED", reason: "INVALID_TRANSITION" });
    // The reopened section saves as usual.
    expect(
      result(
        await save(
          s,
          "availability",
          { ...complete.availability, earliest_start_date: "2027-01-15" },
          String(open.version),
        ),
      ),
    ).toBe("SAVED");
  });

  it("allows attachments to change only when staff reopened them", async () => {
    const s = await submittedCandidate();
    await sendBack(s, { selection: "{}", attachments: "yes" });
    await beginCorrection(s);
    expect(
      await uploadApplicationAttachment(
        {
          commandKey: ckey(),
          candidacyId: s.candidacyId,
          category: "CREDENTIAL",
          fileName: "TEST license.pdf",
          declaredType: "application/pdf",
          bytes: pdf("TEST license"),
        },
        s.candidate.actor,
        deps,
      ),
    ).toMatchObject({ status: "CLEAN" });
    expect(result(await submit(s))).toBe("SUBMITTED");
  });

  it("resubmits as a new frozen version, supersedes the prior one, and preserves both", async () => {
    const s = await submittedCandidate();
    await sendBack(s);
    await beginCorrection(s);
    const open = await sectionVersion(s, "availability");
    await save(
      s,
      "availability",
      { ...complete.availability, earliest_start_date: "2027-01-15" },
      String(open.version),
    );
    expect(result(await submit(s, { signature: "TEST Ana Corrected" }))).toBe(
      "SUBMITTED",
    );
    expect(await versions(s.internalId)).toEqual([
      { version_number: 1, status: "SUPERSEDED" },
      { version_number: 2, status: "SUBMITTED" },
    ]);
    const { rows } = await admin.query(
      `SELECT v.version_number, s.answers->'availability'->>'earliest_start_date' AS start_date, s.certified_name, s.receipt_number
         FROM app.application_submission s JOIN app.application_version v ON v.id = s.application_version_id
        WHERE s.candidacy_id = $1 ORDER BY v.version_number`,
      [s.internalId],
    );
    expect(
      rows.map((r) => [r.version_number, r.start_date, r.certified_name]),
    ).toEqual([
      [1, "2026-12-01", "TEST Ana Ríos"],
      [2, "2027-01-15", "TEST Ana Corrected"],
    ]);
    expect(rows[0].receipt_number).not.toBe(rows[1].receipt_number);
    expect(
      (await tasksOf(s.internalId))
        .map((t) => [t.work_type_code, t.status])
        .sort(),
    ).toEqual(
      [
        ["COMPLETE_APPLICATION", "COMPLETED"],
        ["CORRECT_APPLICATION", "COMPLETED"],
        ["REVIEW_SUBMITTED_APPLICATION", "COMPLETED"],
        ["REVIEW_SUBMITTED_APPLICATION", "OPEN"],
      ].sort(),
    );
    const staffView = await queryStaffApplicationReview(
      headers(staff.recruiter!.jar),
      s.candidacyId,
      deps,
    );
    if (staffView.kind !== "OK") throw new Error("no review");
    expect(staffView.view.earlierReturns).toHaveLength(1);
    expect(JSON.stringify(staffView.view.sections)).toContain("2027-01-15");
    expect(staffView.view.canReturn).toBe(true);
    expect(await eventsOf(s.internalId)).toEqual(
      expect.arrayContaining([
        "application.correction_started",
        "application.returned",
      ]),
    );
    // A second round works the same way.
    expect(result(await sendBack(s))).toBe("RETURNED");
    await beginCorrection(s);
    expect(await versions(s.internalId)).toEqual([
      { version_number: 1, status: "SUPERSEDED" },
      { version_number: 2, status: "RETURNED" },
      { version_number: 3, status: "DRAFT" },
    ]);
  });

  it("keeps showing staff the last submission while a correction is under way", async () => {
    const s = await submittedCandidate();
    const staffRead = () =>
      queryStaffApplicationReview(
        headers(staff.recruiter!.jar),
        s.candidacyId,
        deps,
      );
    expect(await staffRead()).toMatchObject({
      kind: "OK",
      view: { awaitingCorrection: false, canReturn: true },
    });
    await sendBack(s);
    expect(await staffRead()).toMatchObject({
      kind: "OK",
      view: { awaitingCorrection: true, canReturn: false },
    });
    await beginCorrection(s);
    const open = await sectionVersion(s, "availability");
    await save(
      s,
      "availability",
      { ...complete.availability, earliest_start_date: "2027-03-03" },
      String(open.version),
    );
    const during = await staffRead();
    if (during.kind !== "OK") throw new Error("staff lost the application");
    expect(during.view).toMatchObject({
      awaitingCorrection: true,
      canReturn: false,
    });
    // The unsubmitted draft stays out of the frozen view.
    expect(JSON.stringify(during.view.sections)).toContain("2026-12-01");
    expect(JSON.stringify(during.view.sections)).not.toContain("2027-03-03");
  });

  it("lets a correction finish after the hiring cycle closes", async () => {
    const s = await submittedCandidate();
    await sendBack(s);
    await beginCorrection(s);
    const { rows } = await admin.query<{ version: number }>(
      "SELECT version FROM app.hiring_cycle WHERE id = $1",
      [s.cycleId],
    );
    done(
      await transitionHiringCycle(
        "close",
        {
          commandKey: key(),
          targetId: s.cycleId,
          expectedVersion: String(rows[0]!.version),
          reasonCode: "NO_LONGER_NEEDED",
        },
        bootstrapActor(pair.creator),
        configDeps(h),
      ),
    );
    expect((await review(s)).accepting).toBe(true);
    expect(result(await submit(s))).toBe("SUBMITTED");
  });
});

describe("notification (AC-M2.7-05)", () => {
  it("emails a return with no instructions, and a resubmission separately", async () => {
    const s = await submittedCandidate();
    await sendBack(s);
    const sent: [string, string, string][] = [];
    const capture = async (to: string, reference: string, template: string) => {
      if (to === s.candidate.email) sent.push([to, reference, template]);
    };
    await dispatchApplicationEmails(deps, capture as never, 200);
    expect(sent.map((m) => m[2]).sort()).toEqual([
      "APPLICATION_RECEIVED",
      "APPLICATION_RETURNED",
    ]);
    const rendered = renderAuthEmail(
      {
        template: "APPLICATION_RETURNED",
        to: sent[0]![0],
        reference: sent[0]![1],
      },
      "http://127.0.0.1:3000",
    );
    expect(rendered.text).not.toContain(INSTRUCTIONS);
    expect(rendered.text).toContain(sent[0]![1]);
    await beginCorrection(s);
    await submit(s);
    await dispatchApplicationEmails(deps, capture as never, 200);
    expect(sent.filter((m) => m[2] === "APPLICATION_RECEIVED")).toHaveLength(2);
  });
});

describe("database integrity (AC-M2.7-X2)", () => {
  const sqlstate = async (sql: string, params: unknown[] = []) => {
    const runtime = await connect(db.urls.app);
    try {
      await runtime.query(sql, params);
      return "ok";
    } catch (error) {
      return String((error as { code?: string }).code);
    } finally {
      await runtime.end();
    }
  };

  it("protects the return record and the version lifecycle", async () => {
    const s = await submittedCandidate();
    await sendBack(s);
    expect(await sqlstate("DELETE FROM app.application_return")).toBe("42501");
    expect(await sqlstate("UPDATE app.application_return SET id = id")).toBe(
      "42501",
    );
    const fresh = await submittedCandidate();
    const draftOnly = await started();
    for (const [sql, params, code] of [
      [
        "UPDATE app.application_version SET status = 'RETURNED' WHERE candidacy_id = $1",
        [fresh.internalId],
        "CN005",
      ],
      [
        "UPDATE app.application_version SET status = 'SUPERSEDED' WHERE candidacy_id = $1",
        [fresh.internalId],
        "CN005",
      ],
      [
        "UPDATE app.application_version SET status = 'SUPERSEDED' WHERE candidacy_id = $1",
        [s.internalId],
        "CN005",
      ],
      [
        "UPDATE app.application_version SET status = 'DRAFT' WHERE candidacy_id = $1",
        [s.internalId],
        "CN005",
      ],
      [
        `INSERT INTO app.application_return (application_version_id, candidacy_id, reason_code, instructions, reopened, attachments_reopened, returned_by_account_id, returned_at)
         SELECT v.id, v.candidacy_id, 'OTHER', 'TEST', '{"education":[]}', false, v.created_by_account_id, now()
           FROM app.application_version v WHERE v.candidacy_id = $1`,
        [draftOnly.internalId],
        "CN005",
      ],
    ] as const) {
      expect(await sqlstate(sql, [...params]), sql).toBe(code);
    }
    const owner = await connect(db.urls.migrator);
    try {
      await expect(
        owner.query("UPDATE app.application_return SET instructions = 'x'"),
      ).rejects.toMatchObject({ code: "CN002" });
    } finally {
      await owner.end();
    }
  });

  it("keeps every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});
