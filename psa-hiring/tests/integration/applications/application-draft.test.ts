import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  assistSaveApplicationSection,
  beginApplicationDraft,
  saveApplicationSection,
} from "@/modules/applications/application/application-commands";
import {
  queryApplicationOverview,
  queryApplicationSection,
} from "@/modules/applications/application/application-queries";
import { createAuditRecorder } from "@/modules/audit";
import {
  createStaffProspect,
  startOwnCandidacy,
} from "@/modules/candidates/application/candidate-commands";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import {
  candidateRateLimits,
  FixedWindowRateLimiter,
} from "@/modules/identity-access/infrastructure/action-rate-limiter";
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

// M2.4 application drafts (packet M2.4 §14–§17; AC-M2.4-01..05, X1, X2).
// Candidates are real verified accounts with real sessions; staff are real
// MFA accounts with real grants; authorization runs through the production
// adapters. Every value is synthetic.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let deps: ReturnType<typeof candidateDeps>;
let pair: BootstrapPair;
let tree: Hierarchy;
let positionId: string;
const staff: Record<string, StaffSession> = {};

const CANARY = "TEST-ANSWER-CANARY-7Q2X";

const as = (name: string): CandidateActor => ({
  kind: "STAFF",
  principal: staff[name]!.principal,
});
const local = (d: Date) => toZonedLocal(d, "America/New_York");
const system = () => bootstrapActor(pair.creator) as CandidateActor;

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
  return rows[0]!.public_reference;
}

type Started = Readonly<{
  candidate: CandidateSession;
  candidacyId: string;
  internalId: string;
  draftId: string | null;
}>;

async function startedCandidate(options = { begin: true }): Promise<Started> {
  const ref = await openCycle(tree.branch);
  const candidate = await candidateSession(h);
  const started = await startOwnCandidacy(
    {
      commandKey: ckey(),
      handoffToken: handoffFor(h, ref),
      legalFirstName: "TEST Ana",
      legalLastName: "TEST Ríos",
    },
    candidate.actor,
    deps,
  );
  if (started.kind !== "DONE") throw new Error("start failed");
  const { rows } = await admin.query<{ public_id: string }>(
    "SELECT public_id FROM app.candidacy WHERE id = $1",
    [started.targetId],
  );
  const candidacyId = rows[0]!.public_id;
  if (options.begin) {
    const begun = await beginApplicationDraft(
      { commandKey: ckey(), candidacyId },
      candidate.actor,
      deps,
    );
    expect(outcome(begun as never)).toBe("CREATED");
  }
  return {
    candidate,
    candidacyId,
    internalId: started.targetId,
    draftId: options.begin ? await draftIdOf(started.targetId) : null,
  };
}

async function draftIdOf(candidacyInternalId: string) {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT id FROM app.application_version WHERE candidacy_id = $1",
    [candidacyInternalId],
  );
  return rows[0]?.id ?? null;
}

const availabilityComplete = {
  available_days: ["monday", "friday"],
  available_shifts: ["morning"],
  hours_preference: "part_time",
  earliest_start_date: "2026-12-01",
};

const save = (
  started: Started,
  answers: unknown,
  expectedVersion = "0",
  section = "availability",
  commandKey = ckey(),
) =>
  saveApplicationSection(
    {
      commandKey,
      candidacyId: started.candidacyId,
      sectionCode: section,
      expectedVersion,
      answers: JSON.stringify(answers),
    },
    started.candidate.actor,
    deps,
  );

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

const sectionsOf = (draftId: string | null) =>
  count(
    "SELECT count(*)::int AS n FROM app.application_draft_section WHERE application_version_id = $1",
    [draftId],
  );

async function eventsFor(internalId: string) {
  const { rows } = await admin.query<{ event_name: string }>(
    "SELECT event_name FROM audit.audit_event WHERE target_id = $1 ORDER BY chain_sequence",
    [internalId],
  );
  return rows.map((r) => r.event_name);
}

const result = (value: unknown) => outcome(value as never);

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "applications",
  ));
  h = createOrganizationHarness();
  deps = candidateDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "APP");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "APP-POS",
  ));
  const accounts = {
    manager: await activateStaff(h, "app-manager"),
    hr: await activateStaff(h, "app-hr"),
    recruiter: await activateStaff(h, "app-recruiter"),
    administrator: await activateStaff(h, "app-admin"),
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
    accounts.recruiter.accountId,
    "RECRUITER",
    "BRANCH",
    tree.branch,
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
});

describe("beginning a draft (AC-M2.4-01)", () => {
  it("pins the effective template version once, audits it, and repeats safely", async () => {
    const started = await startedCandidate({ begin: false });
    const key1 = ckey();
    const first = await beginApplicationDraft(
      { commandKey: key1, candidacyId: started.candidacyId },
      started.candidate.actor,
      deps,
    );
    expect(result(first)).toBe("CREATED");
    const { rows } = await admin.query(
      `SELECT v.status, v.version_number, tv.version_number AS template_version
         FROM app.application_version v
         JOIN app.application_template_version tv ON tv.id = v.template_version_id
        WHERE v.candidacy_id = $1`,
      [started.internalId],
    );
    expect(rows).toEqual([
      { status: "DRAFT", version_number: 1, template_version: 1 },
    ]);
    expect(await eventsFor(started.internalId)).toContain(
      "application.started",
    );
    // Same key replays; a new key finds the existing draft.
    const replay = await beginApplicationDraft(
      { commandKey: key1, candidacyId: started.candidacyId },
      started.candidate.actor,
      deps,
    );
    expect(replay).toMatchObject({ outcome: "CREATED", replayed: true });
    expect(
      result(
        await beginApplicationDraft(
          { commandKey: ckey(), candidacyId: started.candidacyId },
          started.candidate.actor,
          deps,
        ),
      ),
    ).toBe("EXISTING");
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.application_version WHERE candidacy_id = $1",
        [started.internalId],
      ),
    ).toBe(1);
    expect(
      (await eventsFor(started.internalId)).filter(
        (e) => e === "application.started",
      ),
    ).toHaveLength(1);
  });

  it("lets concurrent begins create exactly one draft", async () => {
    const started = await startedCandidate({ begin: false });
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        beginApplicationDraft(
          { commandKey: ckey(), candidacyId: started.candidacyId },
          started.candidate.actor,
          deps,
        ),
      ),
    );
    expect(outcomes.map(result).sort()).toEqual([
      "CREATED",
      "EXISTING",
      "EXISTING",
    ]);
  });

  it("never writes on a read: viewing an application creates no draft or audit event", async () => {
    const started = await startedCandidate({ begin: false });
    const before = await eventsFor(started.internalId);
    const view = await queryApplicationOverview(
      headers(started.candidate.jar),
      started.candidacyId,
      deps,
    );
    expect(view).toMatchObject({
      kind: "OK",
      view: { started: false, editable: true, completeCount: 0 },
    });
    expect(await draftIdOf(started.internalId)).toBeNull();
    expect(await eventsFor(started.internalId)).toEqual(before);
    // No draft means no section form yet.
    expect(
      await queryApplicationSection(
        headers(started.candidate.jar),
        started.candidacyId,
        "availability",
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
  });

  it("refuses a candidacy that is still a staff prospect", async () => {
    const ref = await openCycle(tree.branch);
    const prospect = await createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: ref,
        legalFirstName: "TEST Prospect",
        legalLastName: "TEST Person",
        email: `test.app.${randomUUID().slice(0, 8)}@example.test`,
      },
      as("hr"),
      deps,
    );
    if (prospect.kind !== "DONE") throw new Error("prospect failed");
    const { rows } = await admin.query<{ public_id: string }>(
      "SELECT public_id FROM app.candidacy WHERE id = $1",
      [prospect.targetId],
    );
    expect(
      result(
        await beginApplicationDraft(
          { commandKey: ckey(), candidacyId: rows[0]!.public_id },
          system(),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    expect(await draftIdOf(prospect.targetId)).toBeNull();
  });
});

describe("saving sections (AC-M2.4-02/03/04)", () => {
  it("saves a partial section In progress, then Complete, with versions and audit that hold no answer", async () => {
    const started = await startedCandidate();
    const partial = await save(started, {
      availability_notes: CANARY,
    });
    expect(partial).toMatchObject({ outcome: "SAVED", version: 1 });
    const middle = await queryApplicationSection(
      headers(started.candidate.jar),
      started.candidacyId,
      "availability",
      deps,
    );
    expect(middle).toMatchObject({
      kind: "OK",
      view: { status: "In progress", version: 1 },
    });
    const done2 = await save(
      started,
      { ...availabilityComplete, availability_notes: CANARY },
      "1",
    );
    expect(done2).toMatchObject({ outcome: "SAVED", version: 2 });
    const overview = await queryApplicationOverview(
      headers(started.candidate.jar),
      started.candidacyId,
      deps,
    );
    if (overview.kind !== "OK") throw new Error("no overview");
    expect(overview.view.completeCount).toBe(1);
    expect(overview.view.sections.map((s) => s.status)).toEqual([
      "Complete",
      "Not started",
      "Not started",
      "Not started",
    ]);
    expect(overview.view.lastSaved).toMatch(/UTC$/);
    expect(
      (await eventsFor(started.internalId)).filter(
        (e) => e === "application.section_saved",
      ),
    ).toHaveLength(2);
    const audit = await admin.query(
      "SELECT row_to_json(e)::text AS row FROM audit.audit_event e WHERE target_id = $1",
      [started.internalId],
    );
    expect(audit.rows.map((r) => r.row).join("")).not.toContain(CANARY);
  });

  it("refuses a stale version with no change and keeps sections independent", async () => {
    const started = await startedCandidate();
    await save(started, { availability_notes: "TEST first" });
    expect(
      result(await save(started, { availability_notes: "TEST stale" })),
    ).toBe("STALE_VERSION");
    expect(
      result(await save(started, { availability_notes: "TEST ahead" }, "7")),
    ).toBe("STALE_VERSION");
    const { rows } = await admin.query(
      "SELECT answers, version FROM app.application_draft_section WHERE application_version_id = $1",
      [started.draftId],
    );
    expect(rows).toEqual([
      { answers: { availability_notes: "TEST first" }, version: 1 },
    ]);
    // Another section has its own version.
    expect(
      result(
        await save(
          started,
          { highest_education: "high_school" },
          "0",
          "education",
        ),
      ),
    ).toBe("SAVED");
  });

  it("replays the same key and request once, and rejects the same key with a different request", async () => {
    const started = await startedCandidate();
    const k = ckey();
    const answers = { availability_notes: "TEST retry" };
    const first = await save(started, answers, "0", "availability", k);
    const retry = await save(started, answers, "0", "availability", k);
    expect(first).toMatchObject({ outcome: "SAVED", replayed: false });
    expect(retry).toMatchObject({
      outcome: "SAVED",
      version: 1,
      replayed: true,
    });
    expect(
      result(
        await save(
          started,
          { availability_notes: "TEST changed" },
          "0",
          "availability",
          k,
        ),
      ),
    ).toBe("COMMAND_KEY_CONFLICT");
    expect(
      (await eventsFor(started.internalId)).filter(
        (e) => e === "application.section_saved",
      ),
    ).toHaveLength(1);
  });

  it("serializes concurrent saves of the same version so only one applies", async () => {
    const started = await startedCandidate();
    await admin.query("BEGIN");
    await admin.query("SELECT 1 FROM app.candidacy WHERE id = $1 FOR UPDATE", [
      started.internalId,
    ]);
    const race = [
      save(started, { availability_notes: "TEST racer one" }),
      save(started, { availability_notes: "TEST racer two" }),
    ];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const outcomes = (await Promise.all(race)).map(result).sort();
    expect(outcomes).toEqual(["SAVED", "STALE_VERSION"]);
    expect(await sectionsOf(started.draftId)).toBe(1);
  });

  it("reports invalid answers by field without saving or echoing them", async () => {
    const started = await startedCandidate();
    const invalid = await save(
      started,
      {
        reference_1_email: `${CANARY}-not-an-email`,
        reference_1_name: "TEST Reference",
      },
      "0",
      "references",
    );
    expect(invalid).toEqual({
      kind: "INVALID_INPUT",
      fields: { reference_1_email: "INVALID_EMAIL" },
    });
    expect(JSON.stringify(invalid)).not.toContain(CANARY);
    expect(await sectionsOf(started.draftId)).toBe(0);
  });

  it("rejects mass assignment, malformed JSON, oversized input, unknown sections, and bad keys with no change", async () => {
    const started = await startedCandidate();
    const attempt = (over: Record<string, string | undefined>) =>
      saveApplicationSection(
        {
          commandKey: ckey(),
          candidacyId: started.candidacyId,
          sectionCode: "availability",
          expectedVersion: "0",
          answers: "{}",
          ...over,
        },
        started.candidate.actor,
        deps,
      );
    for (const answers of [
      JSON.stringify({ completion_status: "COMPLETE" }),
      JSON.stringify({ candidacy_id: "x", saved_by_account_id: "y" }),
      JSON.stringify([]),
      "null",
      "{not json",
      JSON.stringify({ availability_notes: "x".repeat(50_000) }),
    ]) {
      expect(result(await attempt({ answers }))).toBe("INVALID_INPUT");
    }
    expect(result(await attempt({ sectionCode: "attachments" }))).toBe(
      "NOT_FOUND",
    );
    expect(result(await attempt({ expectedVersion: "-1" }))).toBe(
      "INVALID_INPUT",
    );
    expect(result(await attempt({ expectedVersion: "abc" }))).toBe(
      "INVALID_INPUT",
    );
    expect(result(await attempt({ commandKey: "not-a-key" }))).toBe(
      "INVALID_INPUT",
    );
    expect(await sectionsOf(started.draftId)).toBe(0);
  });

  it("rolls the save back when the audit append fails", async () => {
    const started = await startedCandidate();
    const failing = candidateDeps(h, {
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    });
    await expect(
      saveApplicationSection(
        {
          commandKey: ckey(),
          candidacyId: started.candidacyId,
          sectionCode: "availability",
          expectedVersion: "0",
          answers: JSON.stringify({ availability_notes: "TEST rollback" }),
        },
        started.candidate.actor,
        failing,
      ),
    ).rejects.toThrow();
    expect(await sectionsOf(started.draftId)).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidate_command_receipt WHERE actor_account_id = $1 AND command_name = 'save_application_section'",
        [started.candidate.accountId],
      ),
    ).toBe(0);
  });

  it("limits saves per account before touching any record", async () => {
    const started = await startedCandidate();
    const limiter = new FixedWindowRateLimiter();
    const { limit } = candidateRateLimits.applicationSavePerAccount;
    for (let n = 0; n < limit; n += 1) {
      limiter.consume("applicationSavePerAccount", started.candidate.accountId);
    }
    expect(
      result(
        await saveApplicationSection(
          {
            commandKey: ckey(),
            candidacyId: started.candidacyId,
            sectionCode: "availability",
            expectedVersion: "0",
            answers: "{}",
          },
          started.candidate.actor,
          candidateDeps(h, { limiter }),
        ),
      ),
    ).toBe("RATE_LIMITED");
    expect(await sectionsOf(started.draftId)).toBe(0);
  });
});

describe("authorization and nondisclosure (AC-M2.4-X1)", () => {
  it("gives another candidate the same result as an unknown reference, with no read or write", async () => {
    const owner = await startedCandidate();
    await save(owner, { availability_notes: CANARY });
    const other = await candidateSession(h);
    const unknown = "abcdefghjkmn";
    for (const id of [owner.candidacyId, unknown]) {
      expect(
        await queryApplicationOverview(headers(other.jar), id, deps),
      ).toEqual({ kind: "NOT_FOUND" });
      expect(
        await queryApplicationSection(
          headers(other.jar),
          id,
          "availability",
          deps,
        ),
      ).toEqual({ kind: "NOT_FOUND" });
    }
    const write = await saveApplicationSection(
      {
        commandKey: ckey(),
        candidacyId: owner.candidacyId,
        sectionCode: "availability",
        expectedVersion: "1",
        answers: JSON.stringify({ availability_notes: "TEST intruder" }),
      },
      other.actor,
      deps,
    );
    expect(write).toMatchObject({ kind: "REFUSED" });
    const { rows } = await admin.query(
      "SELECT answers, version FROM app.application_draft_section WHERE application_version_id = $1",
      [owner.draftId],
    );
    expect(rows).toEqual([
      { answers: { availability_notes: CANARY }, version: 1 },
    ]);
    expect(
      await queryApplicationOverview(headers(), owner.candidacyId, deps),
    ).toEqual({ kind: "UNAUTHENTICATED" });
  });

  it("returns exact candidate projections with no internal ID, stage, or staff field", async () => {
    const started = await startedCandidate();
    await save(started, { availability_notes: "TEST projection" });
    const view = await queryApplicationSection(
      headers(started.candidate.jar),
      started.candidacyId,
      "availability",
      deps,
    );
    if (view.kind !== "OK") throw new Error("no section");
    expect(Object.keys(view.view).sort()).toEqual([
      "candidacyId",
      "code",
      "description",
      "fields",
      "lastSaved",
      "next",
      "previous",
      "reference",
      "status",
      "title",
      "version",
    ]);
    const text = JSON.stringify(view.view);
    expect(text).not.toContain(started.internalId);
    expect(text).not.toContain(started.draftId!);
    expect(text).not.toContain(started.candidate.accountId);
    expect(text).not.toMatch(/APPLICATION_INCOMPLETE|STAFF_ASSIST/);
    const overview = await queryApplicationOverview(
      headers(started.candidate.jar),
      started.candidacyId,
      deps,
    );
    expect(JSON.stringify(overview)).not.toContain(started.internalId);
    expect(JSON.stringify(overview)).not.toContain("TEST projection");
    expect(
      await queryApplicationSection(
        headers(started.candidate.jar),
        started.candidacyId,
        "not_a_section",
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
  });

  it("denies every staff role the candidate commands and, with no grant, the assist command", async () => {
    const started = await startedCandidate();
    for (const name of ["manager", "hr", "recruiter", "administrator"]) {
      expect(
        result(
          await saveApplicationSection(
            {
              commandKey: ckey(),
              candidacyId: started.candidacyId,
              sectionCode: "availability",
              expectedVersion: "0",
              answers: "{}",
            },
            as(name),
            deps,
          ),
        ),
        name,
      ).toBe("NOT_AUTHORIZED");
      expect(
        result(
          await beginApplicationDraft(
            { commandKey: ckey(), candidacyId: started.candidacyId },
            as(name),
            deps,
          ),
        ),
        name,
      ).toBe("NOT_AUTHORIZED");
      expect(
        result(
          await assistSaveApplicationSection(
            {
              commandKey: ckey(),
              candidacyId: started.candidacyId,
              sectionCode: "availability",
              expectedVersion: "0",
              answers: "{}",
              reasonCode: "CANDIDATE_REQUESTED_ASSISTANCE",
            },
            as(name),
            deps,
          ),
        ),
        name,
      ).toBe("NOT_AUTHORIZED");
    }
    expect(await sectionsOf(started.draftId)).toBe(0);
    expect(await eventsFor(started.internalId)).not.toContain(
      "application.section_assisted",
    );
  });
});

describe("staff-assisted saves (AC-M2.4-05)", () => {
  const assist = (
    started: Started,
    over: Record<string, string | undefined> = {},
    actor: CandidateActor = system(),
  ) =>
    assistSaveApplicationSection(
      {
        commandKey: ckey(),
        candidacyId: started.candidacyId,
        sectionCode: "availability",
        expectedVersion: "0",
        answers: JSON.stringify({ availability_notes: "TEST assisted" }),
        reasonCode: "ACCESSIBILITY_ACCOMMODATION",
        ...over,
      },
      actor,
      deps,
    );

  it("records who assisted and why, and audits it separately, once a grant allows the command", async () => {
    // The test-harness actor stands in for a future approved grant.
    const started = await startedCandidate();
    expect(result(await assist(started))).toBe("SAVED");
    const { rows } = await admin.query(
      "SELECT saved_by_kind, assist_reason_code, saved_by_account_id FROM app.application_draft_section WHERE application_version_id = $1",
      [started.draftId],
    );
    expect(rows).toEqual([
      {
        saved_by_kind: "STAFF_ASSIST",
        assist_reason_code: "ACCESSIBILITY_ACCOMMODATION",
        saved_by_account_id: pair.creator,
      },
    ]);
    expect(await eventsFor(started.internalId)).toContain(
      "application.section_assisted",
    );
    const audit = await admin.query(
      "SELECT reason_code FROM audit.audit_event WHERE target_id = $1 AND event_name = 'application.section_assisted'",
      [started.internalId],
    );
    expect(audit.rows).toEqual([
      { reason_code: "ACCESSIBILITY_ACCOMMODATION" },
    ]);
  });

  it("requires a listed reason and refuses a candidate actor", async () => {
    const started = await startedCandidate();
    for (const reasonCode of [undefined, "", "BECAUSE", "../other"]) {
      expect(result(await assist(started, { reasonCode }))).toBe(
        "INVALID_INPUT",
      );
    }
    expect(result(await assist(started, {}, started.candidate.actor))).toBe(
      "NOT_AUTHORIZED",
    );
    expect(await sectionsOf(started.draftId)).toBe(0);
  });
});

describe("database integrity (AC-M2.4-X2)", () => {
  async function sqlstate(sql: string, params: unknown[] = []) {
    const runtime = await connect(db.urls.app);
    try {
      await runtime.query(sql, params);
      return "OK";
    } catch (error) {
      return (error as { code?: string }).code ?? "UNKNOWN";
    } finally {
      await runtime.end();
    }
  }

  it("denies the runtime role template writes and any delete, and refuses bad writes", async () => {
    const started = await startedCandidate();
    await save(started, { availability_notes: "TEST integrity" });
    for (const table of [
      "application_template",
      "application_template_version",
    ]) {
      expect(await sqlstate(`UPDATE app.${table} SET id = id`), table).toBe(
        "42501",
      );
      expect(await sqlstate(`DELETE FROM app.${table}`), table).toBe("42501");
    }
    for (const table of ["application_version", "application_draft_section"]) {
      expect(await sqlstate(`DELETE FROM app.${table}`), table).toBe("42501");
    }
    // A second draft, a skipped version, a moved section, a moved draft.
    expect(
      await sqlstate(
        `INSERT INTO app.application_version (candidacy_id, template_version_id, version_number, status, created_by_account_id, created_at)
         SELECT candidacy_id, template_version_id, 2, 'DRAFT', created_by_account_id, now() FROM app.application_version WHERE id = $1`,
        [started.draftId],
      ),
    ).toBe("23505");
    expect(
      await sqlstate(
        "UPDATE app.application_draft_section SET version = version + 5 WHERE application_version_id = $1",
        [started.draftId],
      ),
    ).toBe("CN005");
    expect(
      await sqlstate(
        "UPDATE app.application_draft_section SET section_code = 'education', version = version + 1 WHERE application_version_id = $1",
        [started.draftId],
      ),
    ).toBe("CN004");
    expect(
      await sqlstate(
        "UPDATE app.application_version SET version_number = 9 WHERE id = $1",
        [started.draftId],
      ),
    ).toBe("CN004");
    expect(
      await sqlstate(
        "UPDATE app.application_version SET status = 'SUBMITTED' WHERE id = $1",
        [started.draftId],
      ),
    ).toBe("23514");
    expect(
      await sqlstate(
        "UPDATE app.application_draft_section SET saved_by_kind = 'STAFF_ASSIST', version = version + 1 WHERE application_version_id = $1",
        [started.draftId],
      ),
    ).toBe("23514");
  });

  it("refuses even the migration owner when it edits a published template", async () => {
    const owner = await connect(db.urls.migrator);
    try {
      await expect(
        owner.query(
          "UPDATE app.application_template_version SET version_number = 99",
        ),
      ).rejects.toMatchObject({ code: "CN002" });
    } finally {
      await owner.end();
    }
  });

  it("keeps a started draft on its template version when a newer one takes effect, and refuses a malformed one", async () => {
    const started = await startedCandidate();
    const owner = await connect(db.urls.migrator);
    try {
      await owner.query(
        `INSERT INTO app.application_template_version (application_template_id, version_number, schema_json, published_at, effective_from)
         SELECT application_template_id, 2, $1::jsonb, now(), now()
           FROM app.application_template_version WHERE version_number = 1`,
        [
          JSON.stringify({
            sections: [
              {
                code: "only_v2",
                title: "TEST v2",
                description: "TEST v2 section",
                fields: [
                  {
                    code: "answer",
                    label: "TEST",
                    type: "short_text",
                    required: true,
                  },
                ],
              },
            ],
          }),
        ],
      );
      const pinned = await queryApplicationOverview(
        headers(started.candidate.jar),
        started.candidacyId,
        deps,
      );
      if (pinned.kind !== "OK") throw new Error("no overview");
      expect(pinned.view.sections.map((s) => s.code)).toContain("availability");
      const newer = await startedCandidate();
      const view = await queryApplicationOverview(
        headers(newer.candidate.jar),
        newer.candidacyId,
        deps,
      );
      if (view.kind !== "OK") throw new Error("no overview");
      expect(view.view.sections.map((s) => s.code)).toEqual(["only_v2"]);

      await owner.query(
        `INSERT INTO app.application_template_version (application_template_id, version_number, schema_json, published_at, effective_from)
         SELECT application_template_id, 3, '{"sections":"broken"}'::jsonb, now(), now()
           FROM app.application_template_version WHERE version_number = 1`,
      );
      const refused = await startedCandidate({ begin: false });
      expect(
        result(
          await beginApplicationDraft(
            { commandKey: ckey(), candidacyId: refused.candidacyId },
            refused.candidate.actor,
            deps,
          ),
        ),
      ).toBe("TEMPLATE_UNAVAILABLE");
      expect(await draftIdOf(refused.internalId)).toBeNull();
    } finally {
      await owner.end();
    }
  });

  it("keeps every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});
