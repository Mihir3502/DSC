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
  queryApplicationReceipt,
  queryApplicationReview,
  queryApplicationSection,
} from "@/modules/applications/application/application-queries";
import { submitApplication } from "@/modules/applications/application/application-submission";
import { createAuditRecorder } from "@/modules/audit";
import { startOwnCandidacy } from "@/modules/candidates/application/candidate-commands";
import {
  queryCandidateHome,
  queryCandidateTasks,
} from "@/modules/candidates/application/candidate-portal-queries";
import { querySubmittedQueue } from "@/modules/candidates/application/candidate-queries";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  removeApplicationAttachment,
  uploadApplicationAttachment,
  type DocumentDependencies,
} from "@/modules/documents/application/attachment-commands";
import { queryApplicationAttachments } from "@/modules/documents/application/attachment-queries";
import { TestMalwareScanner } from "@/modules/documents/infrastructure/document-providers";
import { LocalDocumentStorage } from "@/modules/documents/infrastructure/local-document-storage";
import {
  candidateRateLimits,
  FixedWindowRateLimiter,
} from "@/modules/identity-access/infrastructure/action-rate-limiter";
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

// M2.6 review, certification, and submission (packet M2.6 §14-§17; AC-M2.6-01
// to 06, X1, X2). Real accounts, sessions, and PostgreSQL. Every value is
// synthetic.

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
    "submission",
  ));
  h = createOrganizationHarness();
  root = mkdtempSync(path.join(tmpdir(), "psa-submission-"));
  deps = {
    ...candidateDeps(h),
    storage: new LocalDocumentStorage(root),
    scanner: new TestMalwareScanner(),
  };
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "SUB");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "SUB-POS",
  ));
  const accounts = {
    recruiter: await activateStaff(h, "sub-recruiter"),
    recruiterOther: await activateStaff(h, "sub-recruiter-other"),
    manager: await activateStaff(h, "sub-manager"),
    administrator: await activateStaff(h, "sub-admin"),
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

describe("submitting (AC-M2.6-01/02/03/04/05)", () => {
  it("freezes answers, clean files, and certification, moves the stage, and swaps the tasks, all at once", async () => {
    const s = await started();
    await uploadApplicationAttachment(
      {
        commandKey: ckey(),
        candidacyId: s.candidacyId,
        category: "RESUME",
        fileName: "TEST resume.pdf",
        declaredType: "application/pdf",
        bytes: pdf(),
      },
      s.candidate.actor,
      deps,
    );
    expect(result(await submit(s))).toBe("SUBMITTED");
    expect(await stateOf(s.internalId)).toEqual({
      current_stage: "APPLICATION_SUBMITTED",
      candidate_visible_status: "APPLICATION_SUBMITTED",
      version_status: "SUBMITTED",
    });
    expect(await tasksOf(s.internalId)).toEqual([
      {
        work_type_code: "COMPLETE_APPLICATION",
        status: "COMPLETED",
        candidate_action_required: true,
      },
      {
        work_type_code: "REVIEW_SUBMITTED_APPLICATION",
        status: "OPEN",
        candidate_action_required: false,
      },
    ]);
    const { rows } = await admin.query(
      `SELECT s.answers, s.certified_name, s.receipt_number, c.version_number, c.review_status,
              (SELECT count(*)::int FROM app.application_submission_attachment a WHERE a.submission_id = s.id) AS files
         FROM app.application_submission s
         JOIN app.application_certification_version c ON c.id = s.certification_version_id
        WHERE s.candidacy_id = $1`,
      [s.internalId],
    );
    expect(rows[0]).toMatchObject({
      certified_name: "TEST Ana Ríos",
      version_number: 1,
      review_status: "DRAFT_UNREVIEWED",
      files: 1,
    });
    expect(rows[0].answers.availability.availability_notes).toBe(CANARY);
    expect(rows[0].receipt_number).toMatch(/^R-[0-9A-HJKMNP-TV-Z]{8}$/);
    const events = await eventsOf(s.internalId);
    expect(events).toContain("application.submitted");
    expect(events).toContain("candidacy.stage_changed");
    const audit = await admin.query(
      "SELECT row_to_json(e)::text AS row FROM audit.audit_event e WHERE target_id = $1",
      [s.internalId],
    );
    const text = audit.rows.map((r) => r.row).join("");
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("TEST Ana");
  });

  it("gives the candidate a receipt and read-only status, and nothing left to do", async () => {
    const s = await started();
    await submit(s);
    const session = headers(s.candidate.jar);
    const receipt = await queryApplicationReceipt(session, s.candidacyId, deps);
    expect(receipt).toMatchObject({
      kind: "OK",
      view: {
        certifiedName: "TEST Ana Ríos",
        certificationVersion: 1,
        sectionCount: 4,
        attachmentCount: 0,
      },
    });
    expect(
      await queryApplicationOverview(session, s.candidacyId, deps),
    ).toMatchObject({
      kind: "OK",
      view: {
        submitted: true,
        editable: false,
        status: "Application submitted",
      },
    });
    expect(
      await queryCandidateHome(session, s.candidacyId, deps),
    ).toMatchObject({
      kind: "OK",
      view: {
        nextAction: null,
        current: { status: { code: "APPLICATION_SUBMITTED" } },
        taskCounts: { actionNeeded: 0, underReview: 1 },
      },
    });
    expect(
      await queryCandidateTasks(session, "under_review", deps),
    ).toMatchObject({
      kind: "OK",
      view: { tasks: [{ status: "Submitted", href: null }] },
    });
    // A receipt before submission doesn't exist.
    const other = await started({ fill: false });
    expect(
      await queryApplicationReceipt(
        headers(other.candidate.jar),
        other.candidacyId,
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
  });

  it("freezes the application: no later save, upload, removal, or review", async () => {
    const s = await started();
    await uploadApplicationAttachment(
      {
        commandKey: ckey(),
        candidacyId: s.candidacyId,
        category: "RESUME",
        fileName: "TEST resume.pdf",
        declaredType: "application/pdf",
        bytes: pdf(),
      },
      s.candidate.actor,
      deps,
    );
    const session = headers(s.candidate.jar);
    const listed = await queryApplicationAttachments(
      session,
      s.candidacyId,
      deps,
    );
    if (listed.kind !== "OK") throw new Error("no list");
    const file = listed.view.attachments[0]!;
    expect(result(await submit(s))).toBe("SUBMITTED");
    expect(result(await save(s, "availability", {}, "1"))).toBe(
      "NOT_AUTHORIZED",
    );
    expect(
      await queryApplicationSection(
        session,
        s.candidacyId,
        "availability",
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(await queryApplicationReview(session, s.candidacyId, deps)).toEqual({
      kind: "NOT_FOUND",
    });
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
    ).toMatchObject({ kind: "REFUSED" });
    expect(
      await removeApplicationAttachment(
        {
          commandKey: ckey(),
          candidacyId: s.candidacyId,
          documentId: file.documentId,
          expectedVersion: String(file.version),
        },
        s.candidate.actor,
        deps,
      ),
    ).toMatchObject({ kind: "REFUSED" });
  });
});

describe("what blocks submission (AC-M2.6-01/02)", () => {
  it("names what's missing and changes nothing when the application is incomplete", async () => {
    const s = await started({ fill: false });
    await save(s, "availability", complete.availability);
    const view = await review(s);
    expect(view.complete).toBe(false);
    expect(view.sections.find((x) => x.code === "experience")!.missing).toEqual(
      ["How much caregiving experience do you have?"],
    );
    const refused = await submitApplication(
      {
        commandKey: ckey(),
        candidacyId: s.candidacyId,
        certificationVersion: "1",
        certified: "yes",
        signature: "TEST Ana Ríos",
        reviewToken: view.reviewToken,
      },
      s.candidate.actor,
      deps,
    );
    expect(refused).toMatchObject({ kind: "INCOMPLETE" });
    expect(await submissions(s.internalId)).toBe(0);
    expect(await stateOf(s.internalId)).toMatchObject({
      current_stage: "APPLICATION_INCOMPLETE",
      version_status: "DRAFT",
    });
  });

  it("requires the certification, a typed name, and a current version", async () => {
    const s = await started();
    for (const over of [
      { certified: undefined },
      { certified: "no" },
      { signature: undefined },
      { signature: " " },
      { signature: "TEST‮name" },
      { certificationVersion: "abc" },
      { reviewToken: "not-a-token" },
      { commandKey: "not-a-key" },
    ]) {
      expect(result(await submit(s, over)), JSON.stringify(over)).toBe(
        "INVALID_INPUT",
      );
    }
    expect(result(await submit(s, { certificationVersion: "99" }))).toBe(
      "STALE_VERSION",
    );
    expect(await submissions(s.internalId)).toBe(0);
  });

  it("refuses when answers or files changed after the review page was read", async () => {
    const s = await started();
    const view = await review(s);
    await save(s, "education", { highest_education: "associate" }, "1");
    const stale = await submitApplication(
      {
        commandKey: ckey(),
        candidacyId: s.candidacyId,
        certificationVersion: String(view.certification.version),
        certified: "yes",
        signature: "TEST Ana Ríos",
        reviewToken: view.reviewToken,
      },
      s.candidate.actor,
      deps,
    );
    expect(result(stale)).toBe("STALE_VERSION");
    expect(await submissions(s.internalId)).toBe(0);
    expect(result(await submit(s))).toBe("SUBMITTED");
  });

  it("refuses once the hiring cycle closes, and keeps the draft", async () => {
    const s = await started();
    const view = await review(s);
    expect(view.accepting).toBe(true);
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
    expect((await review(s)).accepting).toBe(false);
    expect(result(await submit(s))).toBe("OPENING_UNAVAILABLE");
    expect(await stateOf(s.internalId)).toMatchObject({
      current_stage: "APPLICATION_INCOMPLETE",
      version_status: "DRAFT",
    });
    expect(await outboxOf(s.internalId)).toEqual([]);
  });

  it("freezes only clean files and tells the candidate which are left out", async () => {
    const s = await started();
    const broken: DocumentDependencies = {
      ...deps,
      scanner: {
        scannerCode: "TEST_BROKEN",
        scan: async () => {
          throw new Error("scanner offline");
        },
      },
    };
    await uploadApplicationAttachment(
      {
        commandKey: ckey(),
        candidacyId: s.candidacyId,
        category: "CREDENTIAL",
        fileName: "TEST unchecked.pdf",
        declaredType: "application/pdf",
        bytes: pdf("TEST unchecked"),
      },
      s.candidate.actor,
      broken,
    );
    const view = await review(s);
    expect(view.attachments).toEqual([]);
    expect(view.excludedAttachments).toEqual([
      { name: "TEST unchecked.pdf", status: "Could not be checked" },
    ]);
    expect(result(await submit(s))).toBe("SUBMITTED");
    expect(
      await count(
        `SELECT count(*)::int AS n FROM app.application_submission_attachment a
           JOIN app.application_submission s ON s.id = a.submission_id WHERE s.candidacy_id = $1`,
        [s.internalId],
      ),
    ).toBe(0);
  });
});

describe("idempotency and concurrency (AC-M2.6-X2)", () => {
  it("replays the same key once and rejects it with a different request", async () => {
    const s = await started();
    const k = ckey();
    const view = await review(s);
    const send = (signature: string) =>
      submitApplication(
        {
          commandKey: k,
          candidacyId: s.candidacyId,
          certificationVersion: String(view.certification.version),
          certified: "yes",
          signature,
          reviewToken: view.reviewToken,
        },
        s.candidate.actor,
        deps,
      );
    expect(result(await send("TEST Ana Ríos"))).toBe("SUBMITTED");
    expect(await send("TEST Ana Ríos")).toMatchObject({
      outcome: "SUBMITTED",
      replayed: true,
    });
    expect(result(await send("TEST Someone Else"))).toBe(
      "COMMAND_KEY_CONFLICT",
    );
    expect(await submissions(s.internalId)).toBe(1);
    expect(await outboxOf(s.internalId)).toHaveLength(1);
  });

  it("serializes concurrent submissions so only one applies", async () => {
    const s = await started();
    const view = await review(s);
    const send = () =>
      submitApplication(
        {
          commandKey: ckey(),
          candidacyId: s.candidacyId,
          certificationVersion: String(view.certification.version),
          certified: "yes",
          signature: "TEST Ana Ríos",
          reviewToken: view.reviewToken,
        },
        s.candidate.actor,
        deps,
      );
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.candidacy WHERE id = $1 FOR UPDATE", [
      s.internalId,
    ]);
    const race = [send(), send()];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const outcomes = (await Promise.all(race)).map(result).sort();
    expect(outcomes).toContain("SUBMITTED");
    expect(outcomes.filter((o) => o === "SUBMITTED")).toHaveLength(1);
    expect(await submissions(s.internalId)).toBe(1);
    expect(await tasksOf(s.internalId)).toHaveLength(2);
  });

  it("rolls everything back when the audit append fails", async () => {
    const s = await started();
    const failing: DocumentDependencies = {
      ...deps,
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    };
    await expect(submit(s, {}, s.candidate.actor, failing)).rejects.toThrow();
    expect(await submissions(s.internalId)).toBe(0);
    expect(await outboxOf(s.internalId)).toEqual([]);
    expect(await stateOf(s.internalId)).toMatchObject({
      current_stage: "APPLICATION_INCOMPLETE",
      version_status: "DRAFT",
    });
    expect((await tasksOf(s.internalId)).map((t) => t.status)).toEqual([
      "OPEN",
    ]);
  });

  it("limits submission attempts per account", async () => {
    const s = await started();
    const limiter = new FixedWindowRateLimiter();
    for (
      let n = 0;
      n < candidateRateLimits.applicationSubmitPerAccount.limit;
      n += 1
    ) {
      limiter.consume("applicationSubmitPerAccount", s.candidate.accountId);
    }
    expect(
      result(await submit(s, {}, s.candidate.actor, { ...deps, limiter })),
    ).toBe("RATE_LIMITED");
  });
});

describe("confirmation email (AC-M2.6-06)", () => {
  const dispatch = (send: (to: string, reference: string) => Promise<void>) =>
    dispatchApplicationEmails(deps, send, 200);

  it("delivers once to the verified address, with the reference and no answers", async () => {
    const s = await started();
    await submit(s);
    expect(await outboxOf(s.internalId)).toEqual([
      {
        event_type: "APPLICATION_RECEIVED_EMAIL",
        status: "PENDING",
        attempt_count: 0,
        last_error_code: null,
      },
    ]);
    const sent: [string, string][] = [];
    await dispatch(async (to, reference) => {
      sent.push([to, reference]);
    });
    const mine = sent.filter(([to]) => to === s.candidate.email);
    expect(mine).toHaveLength(1);
    expect(await outboxOf(s.internalId)).toEqual([
      expect.objectContaining({ status: "SENT", attempt_count: 1 }),
    ]);
    await dispatch(async (to, reference) => {
      if (to === s.candidate.email) sent.push([to, reference]);
    });
    expect(sent.filter(([to]) => to === s.candidate.email)).toHaveLength(1);
    const rendered = renderAuthEmail(
      {
        template: "APPLICATION_RECEIVED",
        to: mine[0]![0],
        reference: mine[0]![1],
      },
      "http://127.0.0.1:3000",
    );
    expect(rendered.text).toContain(mine[0]![1]);
    expect(rendered.text).not.toContain(CANARY);
    expect(rendered.text).not.toContain("TEST Ana");
  });

  it("retries a failed delivery without undoing the submission, then stops", async () => {
    const s = await started();
    await submit(s);
    const fail = async (to: string) => {
      if (to === s.candidate.email) throw new Error("smtp down");
    };
    await dispatch(fail);
    expect(await outboxOf(s.internalId)).toEqual([
      expect.objectContaining({
        status: "PENDING",
        attempt_count: 1,
        last_error_code: "DELIVERY_FAILED",
      }),
    ]);
    expect((await stateOf(s.internalId)).current_stage).toBe(
      "APPLICATION_SUBMITTED",
    );
    // A leased row isn't retried until its lease ends.
    await dispatch(fail);
    expect((await outboxOf(s.internalId))[0].attempt_count).toBe(1);
    await admin.query(
      "UPDATE app.outbox_event SET attempt_count = 4, available_at = now() - interval '1 minute' WHERE aggregate_id = $1",
      [s.internalId],
    );
    await dispatch(fail);
    expect(await outboxOf(s.internalId)).toEqual([
      expect.objectContaining({ status: "FAILED", attempt_count: 5 }),
    ]);
  });
});

describe("staff queue (AC-M2.6-05/X1)", () => {
  it("lists a submission for scoped staff only, with no answers or names", async () => {
    const s = await started();
    await submit(s);
    const { rows } = await admin.query<{ candidate_reference: string }>(
      "SELECT candidate_reference FROM app.candidacy WHERE id = $1",
      [s.internalId],
    );
    const reference = rows[0]!.candidate_reference;
    for (const name of ["recruiter", "manager"]) {
      const queue = await querySubmittedQueue(headers(staff[name]!.jar), deps);
      if (queue.kind !== "OK") throw new Error(`no queue for ${name}`);
      const text = JSON.stringify(queue.view);
      expect(text, name).toContain(reference);
      expect(text, name).not.toContain(CANARY);
      expect(text, name).not.toContain("TEST Ana");
      expect(text, name).not.toContain(s.internalId);
    }
    const other = await querySubmittedQueue(
      headers(staff.recruiterOther!.jar),
      deps,
    );
    if (other.kind !== "OK") throw new Error("no queue");
    expect(JSON.stringify(other.view)).not.toContain(reference);
    expect(
      await querySubmittedQueue(headers(staff.administrator!.jar), deps),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(await querySubmittedQueue(headers(), deps)).toEqual({
      kind: "UNAUTHENTICATED",
    });
    expect(await querySubmittedQueue(headers(s.candidate.jar), deps)).toEqual({
      kind: "UNAUTHENTICATED",
    });
  });
});

describe("authorization and nondisclosure (AC-M2.6-X1)", () => {
  it("gives another candidate and an unknown reference the same result, with no change", async () => {
    const owner = await started();
    const other = await started();
    const view = await review(owner);
    for (const id of [owner.candidacyId, "abcdefghjkmn"]) {
      expect(
        await queryApplicationReview(headers(other.candidate.jar), id, deps),
      ).toEqual({ kind: "NOT_FOUND" });
      expect(
        await queryApplicationReceipt(headers(other.candidate.jar), id, deps),
      ).toEqual({ kind: "NOT_FOUND" });
    }
    const attempt = await submitApplication(
      {
        commandKey: ckey(),
        candidacyId: owner.candidacyId,
        certificationVersion: String(view.certification.version),
        certified: "yes",
        signature: "TEST Intruder",
        reviewToken: view.reviewToken,
      },
      other.candidate.actor,
      deps,
    );
    expect(attempt).toMatchObject({ kind: "REFUSED" });
    expect(await submissions(owner.internalId)).toBe(0);
    expect(
      await queryApplicationReview(headers(), owner.candidacyId, deps),
    ).toEqual({ kind: "UNAUTHENTICATED" });
  });

  it("denies every staff role the candidate's submission", async () => {
    const s = await started();
    for (const name of ["recruiter", "manager", "administrator"]) {
      const actor: CandidateActor = {
        kind: "STAFF",
        principal: staff[name]!.principal,
      };
      expect(result(await submit(s, {}, actor)), name).toBe("NOT_AUTHORIZED");
    }
    expect(await submissions(s.internalId)).toBe(0);
  });
});

describe("database integrity (AC-M2.6-X2)", () => {
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

  it("makes a submission immutable and refuses a version submitted without one", async () => {
    const s = await started();
    await submit(s);
    const draftOnly = await started();
    for (const table of [
      "application_submission",
      "application_submission_attachment",
      "application_certification_version",
    ]) {
      expect(await sqlstate(`DELETE FROM app.${table}`), table).toBe("42501");
      expect(
        await sqlstate(
          `UPDATE app.${table} SET ${table === "application_submission_attachment" ? "submission_id = submission_id" : "id = id"}`,
        ),
        table,
      ).toBe("42501");
    }
    expect(await sqlstate("DELETE FROM app.outbox_event")).toBe("42501");
    expect(
      await sqlstate(
        "UPDATE app.application_version SET status = 'DRAFT' WHERE candidacy_id = $1",
        [s.internalId],
      ),
    ).toBe("CN005");
    expect(
      await sqlstate(
        "UPDATE app.application_version SET status = 'SUBMITTED' WHERE candidacy_id = $1",
        [draftOnly.internalId],
      ),
    ).toBe("CN005");
    expect(
      await sqlstate(
        `INSERT INTO app.application_submission (application_version_id, candidacy_id, template_version_id, certification_version_id, answers, content_hash, certified_name, receipt_number, submitted_by_account_id, submitted_at)
         SELECT v.id, v.candidacy_id, v.template_version_id, (SELECT id FROM app.application_certification_version LIMIT 1), '{}', repeat('a', 64), 'TEST', 'R-AAAAAAAA', v.created_by_account_id, now()
           FROM app.application_version v WHERE v.candidacy_id = $1`,
        [s.internalId],
      ),
    ).toBe("CN005");
    const owner = await connect(db.urls.migrator);
    try {
      await expect(
        owner.query(
          "UPDATE app.application_submission SET certified_name = 'x'",
        ),
      ).rejects.toMatchObject({ code: "CN002" });
    } finally {
      await owner.end();
    }
  });

  it("keeps every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});
