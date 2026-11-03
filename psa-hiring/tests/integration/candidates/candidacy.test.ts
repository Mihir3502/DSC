import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAuditRecorder } from "@/modules/audit";
import {
  assignCandidacyOwnerToSelf,
  closeProspect,
  createStaffProspect,
  mergePeople,
  reviewDuplicateMatch,
  startApplicationFromProspect,
  startOwnCandidacy,
} from "@/modules/candidates/application/candidate-commands";
import {
  queryCandidateStart,
  queryDuplicateQueue,
  queryDuplicateReview,
  queryProspectDetail,
  queryProspectForm,
} from "@/modules/candidates/application/candidate-queries";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
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
  type CandidateSession,
} from "../support/candidates";
import { waitForLockWait } from "../support/barriers";
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
import {
  candidateRateLimits,
  FixedWindowRateLimiter,
} from "@/modules/identity-access/infrastructure/action-rate-limiter";

// M2.2 person, ownership, candidacy, stages, duplicates, review, and merge
// (packet M2.2 §7–§23, §28, §30; AC-M2.2-01..15). Candidates are real
// verified accounts with real sessions; staff are real MFA accounts with
// real grants on real hierarchy rows; authorization runs through the
// production organization, candidacy, and ownership adapters. Every
// value is synthetic.

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
let managerMember: StaffMember;

const as = (name: string): CandidateActor => ({
  kind: "STAFF",
  principal: staff[name]!.principal,
});
const local = (d: Date) => toZonedLocal(d, "America/New_York");

/** An OPEN cycle in a branch (optionally team), returning its references. */
async function openCycle(branchId: string, teamId?: string) {
  const cdeps = configDeps(h);
  const actor = bootstrapActor(pair.creator);
  const cycle = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId,
        branchId,
        ...(teamId ? { teamId } : {}),
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
  const opened = done(
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
  return {
    id: cycle.id,
    version: opened.version,
    ref: rows[0]!.public_reference,
  };
}

const names = { legalFirstName: "TEST Ana", legalLastName: "TEST Ríos" };

async function selfStart(
  candidate: CandidateSession,
  ref: string,
  extra: Record<string, string> = {},
  commandKey = ckey(),
) {
  return startOwnCandidacy(
    { commandKey, handoffToken: handoffFor(h, ref), ...names, ...extra },
    candidate.actor,
    deps,
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

async function eventNames(targetId: string) {
  const { rows } = await admin.query<{ event_name: string }>(
    "SELECT event_name FROM audit.audit_event WHERE target_id = $1 ORDER BY chain_sequence",
    [targetId],
  );
  return rows.map((r) => r.event_name);
}

async function candidacyOf(id: string) {
  const { rows } = await admin.query(
    "SELECT id, public_id, person_id, current_stage, status, version, owner_account_id FROM app.candidacy WHERE id = $1",
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "candidates",
  ));
  h = createOrganizationHarness();
  deps = candidateDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "CAN");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "CAN-POS",
  ));
  const accounts = {
    manager: await activateStaff(h, "cand-manager"),
    hr: await activateStaff(h, "cand-hr"),
    recruiter: await activateStaff(h, "cand-recruiter"),
    recruiterOther: await activateStaff(h, "cand-recruiter-other"),
    administrator: await activateStaff(h, "cand-admin"),
    otherManager: await activateStaff(h, "cand-other-manager"),
  };
  managerMember = accounts.manager;
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
    accounts.recruiterOther.accountId,
    "RECRUITER",
    "BRANCH",
    tree.branch2,
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
  for (const [name, member] of Object.entries(accounts))
    staff[name] = await signIn(h, member);
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) await dropOwnedDatabase(ctx, db.name);
});

// ------------------------------------------------- candidate self-start

describe("candidate self-start (AC-M2.2-01/02/03/04/06/07)", () => {
  it("creates one person, ownership link, candidacy, history, and audit for a verified candidate, and reuses the person for a later opening", async () => {
    const cycle = await openCycle(tree.branch);
    const candidate = await candidateSession(h);
    const result = await selfStart(candidate, cycle.ref, {
      phone: "(859) 555-0142",
    });
    expect(result.kind === "DONE" && result.outcome).toBe("CREATED");
    if (result.kind !== "DONE") return;
    const { rows: people } = await admin.query(
      "SELECT id, candidate_account_id, email_normalized, phone_e164, status, normalization_version FROM app.person WHERE candidate_account_id = $1",
      [candidate.accountId],
    );
    expect(people).toHaveLength(1);
    expect(people[0].email_normalized).toBe(candidate.email);
    expect(people[0].phone_e164).toBe("+18595550142");
    expect(people[0].normalization_version).toBe("NORM-1");
    const row = await candidacyOf(result.targetId);
    expect(row).toMatchObject({
      current_stage: "APPLICATION_INCOMPLETE",
      status: "ACTIVE",
      owner_account_id: null,
    });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidacy_stage_history WHERE candidacy_id = $1",
        [result.targetId],
      ),
    ).toBe(1);
    expect(await eventNames(people[0].id)).toEqual([
      "person.created",
      "person.account_linked",
    ]);
    expect(await eventNames(result.targetId)).toEqual([
      "candidacy.created",
      "candidacy.stage_changed",
    ]);
    // No application draft or version of any kind exists.
    expect(
      await count(
        "SELECT count(*)::int AS n FROM pg_tables WHERE tablename ~ 'application'",
      ),
    ).toBe(0);
    // A later, different opening reuses the same person (PRD-CAN-006).
    const later = await openCycle(tree.branch);
    const second = await selfStart(candidate, later.ref);
    expect(second.kind === "DONE" && second.outcome).toBe("CREATED");
    if (second.kind !== "DONE") return;
    expect((await candidacyOf(second.targetId)).person_id).toBe(people[0].id);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE candidate_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(1);
  });

  it("returns the original outcome for a retried key, refuses a reused key with a different request, and never duplicates", async () => {
    const cycle = await openCycle(tree.branch);
    const candidate = await candidateSession(h);
    const commandKey = ckey();
    const token = handoffFor(h, cycle.ref);
    const first = await startOwnCandidacy(
      { commandKey, handoffToken: token, ...names },
      candidate.actor,
      deps,
    );
    const retry = await startOwnCandidacy(
      { commandKey, handoffToken: token, ...names },
      candidate.actor,
      deps,
    );
    expect(retry.kind === "DONE" && retry.replayed).toBe(true);
    expect(
      retry.kind === "DONE" &&
        first.kind === "DONE" &&
        retry.targetId === first.targetId,
    ).toBe(true);
    expect(
      outcome(
        await startOwnCandidacy(
          {
            commandKey,
            handoffToken: token,
            ...names,
            legalFirstName: "TEST Other",
          },
          candidate.actor,
          deps,
        ),
      ),
    ).toBe("COMMAND_KEY_CONFLICT");
    // A new key for the same opening resumes the existing candidacy.
    const again = await selfStart(candidate, cycle.ref);
    expect(outcome(again)).toBe("EXISTING");
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidacy c JOIN app.person p ON p.id = c.person_id WHERE p.candidate_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(1);
    // A different opening later reuses the same person.
    const later = await openCycle(tree.branch2);
    expect(outcome(await selfStart(candidate, later.ref))).toBe("CREATED");
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE candidate_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(1);
  });

  it("lets exactly one of two concurrent first starts create the person and candidacy", async () => {
    const cycle = await openCycle(tree.branch);
    const candidate = await candidateSession(h);
    await admin.query("BEGIN");
    await admin.query(
      "SELECT 1 FROM app.hiring_cycle WHERE id = $1 FOR UPDATE",
      [cycle.id],
    );
    const race = [
      selfStart(candidate, cycle.ref),
      selfStart(candidate, cycle.ref),
    ];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const results = (await Promise.all(race)).map(outcome).sort();
    expect(results).toEqual(["CREATED", "EXISTING"]);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE candidate_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidacy c JOIN app.person p ON p.id = c.person_id WHERE p.candidate_account_id = $1 AND c.hiring_cycle_id = $2",
        [candidate.accountId, cycle.id],
      ),
    ).toBe(1);
  });

  it("refuses closed, tampered, and wrong-purpose openings and unverified or staff actors with no partial state", async () => {
    const cycle = await openCycle(tree.branch);
    done(
      await transitionHiringCycle(
        "close",
        {
          commandKey: key(),
          targetId: cycle.id,
          expectedVersion: String(cycle.version),
          reasonCode: "NO_LONGER_NEEDED",
        },
        bootstrapActor(pair.creator),
        configDeps(h),
      ),
    );
    const candidate = await candidateSession(h);
    expect(outcome(await selfStart(candidate, cycle.ref))).toBe(
      "OPENING_UNAVAILABLE",
    );
    const token = handoffFor(h, cycle.ref);
    expect(
      outcome(
        await startOwnCandidacy(
          {
            commandKey: ckey(),
            handoffToken: `${token.slice(0, -2)}AA`,
            ...names,
          },
          candidate.actor,
          deps,
        ),
      ),
    ).toBe("OPENING_UNAVAILABLE");
    expect(
      outcome(
        await startOwnCandidacy(
          {
            commandKey: ckey(),
            handoffToken: h.runtime.intents.issuePublic(),
            ...names,
          },
          candidate.actor,
          deps,
        ),
      ),
    ).toBe("OPENING_UNAVAILABLE");
    const open = await openCycle(tree.branch);
    expect(
      outcome(
        await selfStart(candidate, open.ref, {}, ckey()).then(() =>
          startOwnCandidacy(
            {
              commandKey: ckey(),
              handoffToken: handoffFor(h, open.ref),
              ...names,
            },
            as("recruiter"),
            deps,
          ),
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
    const forged: CandidateActor = {
      kind: "CANDIDATE",
      principal: {
        ...candidate.principal,
        sessionId: randomUUID(),
        emailVerified: false,
      },
    };
    const forgedResult = await selfStart(
      { ...candidate, actor: forged },
      open.ref,
    );
    expect(["NOT_AUTHORIZED", "UNAUTHENTICATED"]).toContain(
      outcome(forgedResult),
    );
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidacy WHERE hiring_cycle_id = $1",
        [cycle.id],
      ),
    ).toBe(0);
  });

  it("rejects malicious Unicode, control, bidi, markup, and oversized names without creating anything", async () => {
    const cycle = await openCycle(tree.branch);
    const candidate = await candidateSession(h);
    for (const bad of [
      "TEST‮evil",
      "TEST\u0000nul",
      "<script>",
      "TEST 123",
      "x".repeat(101),
      "TEST​zero",
    ]) {
      const result = await selfStart(candidate, cycle.ref, {
        legalFirstName: bad,
      });
      expect(result.kind, JSON.stringify(bad.length)).toBe("INVALID_INPUT");
    }
    for (const ok of [
      "José",
      "Nguyễn Văn",
      "O'Brien",
      "Anne-Marie",
      "Müller",
    ]) {
      expect(
        outcome(
          await selfStart(await candidateSession(h), cycle.ref, {
            legalFirstName: ok,
          }),
        ),
      ).toBe("CREATED");
    }
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE candidate_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(0);
  });

  it("limits start attempts per account, before any lookup, without affecting another account", async () => {
    const cycle = await openCycle(tree.branch);
    const limited = await candidateSession(h);
    const other = await candidateSession(h);
    const limiter = new FixedWindowRateLimiter();
    const limitedDeps = candidateDeps(h, { limiter });
    const start = (candidate: CandidateSession) =>
      startOwnCandidacy(
        {
          commandKey: ckey(),
          handoffToken: handoffFor(h, cycle.ref),
          ...names,
        },
        candidate.actor,
        limitedDeps,
      );
    for (
      let n = 0;
      n < candidateRateLimits.candidateStartPerAccount.limit;
      n += 1
    ) {
      limiter.consume("candidateStartPerAccount", limited.accountId);
    }
    const people = "SELECT count(*)::int AS n FROM app.person";
    const before = await count(people);
    expect(outcome(await start(limited))).toBe("RATE_LIMITED");
    expect(await count(people)).toBe(before);
    // A typo is corrected, not counted, so it never exhausts the limit.
    expect(
      (
        await startOwnCandidacy(
          {
            commandKey: ckey(),
            handoffToken: handoffFor(h, cycle.ref),
            legalFirstName: "",
            legalLastName: "",
          },
          limited.actor,
          limitedDeps,
        )
      ).kind,
    ).toBe("INVALID_INPUT");
    expect(outcome(await start(other))).toBe("CREATED");
  });

  it("rolls everything back when the audit append fails", async () => {
    const cycle = await openCycle(tree.branch);
    const candidate = await candidateSession(h);
    const failing = candidateDeps(h, {
      events: createAuditRecorder({
        db: getDatabase(),
        logger: createLogger({ destination: createMemoryDestination() }),
        keys: failingKeys(),
      }),
    });
    await expect(
      startOwnCandidacy(
        {
          commandKey: ckey(),
          handoffToken: handoffFor(h, cycle.ref),
          ...names,
        },
        candidate.actor,
        failing,
      ),
    ).rejects.toThrow();
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE candidate_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidate_command_receipt WHERE actor_account_id = $1",
        [candidate.accountId],
      ),
    ).toBe(0);
  });

  it("shows the candidate only their own start state and never another person or a duplicate", async () => {
    const cycle = await openCycle(tree.branch);
    const candidate = await candidateSession(h);
    const before = await queryCandidateStart(
      headers(candidate.jar),
      handoffFor(h, cycle.ref),
      {},
      deps,
    );
    expect(before).toEqual({
      kind: "OK",
      view: {
        opening: expect.objectContaining({ title: expect.any(String) }),
        needsPersonDetails: true,
        own: null,
      },
    });
    await selfStart(candidate, cycle.ref);
    const after = await queryCandidateStart(
      headers(candidate.jar),
      undefined,
      { latest: true },
      deps,
    );
    expect(after.kind === "OK" && after.view.own?.status).toBe(
      "Application started",
    );
    expect(Object.keys(after.kind === "OK" ? after.view : {}).sort()).toEqual([
      "needsPersonDetails",
      "opening",
      "own",
    ]);
    const other = await candidateSession(h);
    const otherView = await queryCandidateStart(
      headers(other.jar),
      undefined,
      { latest: true },
      deps,
    );
    expect(otherView.kind === "OK" && otherView.view.own).toBeNull();
    expect(
      await queryCandidateStart(headers(), handoffFor(h, cycle.ref), {}, deps),
    ).toEqual({ kind: "UNAUTHENTICATED" });
  });
});

// ------------------------------------------------------- staff prospects

describe("staff prospects, owner, and stages (AC-M2.2-05/08/12)", () => {
  let cycle: Awaited<ReturnType<typeof openCycle>>;
  beforeAll(async () => {
    cycle = await openCycle(tree.branch);
  });

  const prospect = (
    actor: CandidateActor,
    extra: Record<string, string> = {},
  ) =>
    createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: cycle.ref,
        legalFirstName: "TEST Prospect",
        legalLastName: "TEST Person",
        email: `test.prospect.${randomUUID().slice(0, 8)}@example.test`,
        ...extra,
      },
      actor,
      deps,
    );

  it("lets scoped recruiters, HR, and managers create unowned prospects and denies everyone else", async () => {
    for (const name of ["recruiter", "hr", "manager"]) {
      const result = await prospect(as(name));
      expect(outcome(result), name).toBe("CREATED");
      if (result.kind !== "DONE") continue;
      const row = await candidacyOf(result.targetId);
      expect(row).toMatchObject({
        current_stage: "PROSPECT",
        status: "ACTIVE",
        owner_account_id: null,
      });
      const { rows } = await admin.query(
        "SELECT candidate_account_id FROM app.person WHERE id = $1",
        [row.person_id],
      );
      expect(rows[0].candidate_account_id).toBeNull();
    }
    for (const name of ["recruiterOther", "administrator", "otherManager"]) {
      expect(outcome(await prospect(as(name))), name).toBe("NOT_AUTHORIZED");
    }
    const candidate = await candidateSession(h);
    expect(outcome(await prospect(candidate.actor))).toBe("NOT_AUTHORIZED");
  });

  it("limits prospect creation per account the same way whether or not the email already exists", async () => {
    const limiter = new FixedWindowRateLimiter();
    const limit = candidateRateLimits.staffProspectCreatePerAccount.limit;
    for (let n = 0; n < limit; n += 1) {
      limiter.consume(
        "staffProspectCreatePerAccount",
        staff.recruiter!.principal.accountId,
      );
    }
    const existing = `test.limit.${randomUUID().slice(0, 8)}@example.test`;
    expect(outcome(await prospect(as("recruiter"), { email: existing }))).toBe(
      "CREATED",
    );
    const attempt = (email: string) =>
      createStaffProspect(
        {
          commandKey: ckey(),
          cycleReference: cycle.ref,
          legalFirstName: "TEST Prospect",
          legalLastName: "TEST Person",
          email,
        },
        as("recruiter"),
        candidateDeps(h, { limiter }),
      );
    const known = await attempt(existing);
    const unknown = await attempt(
      `test.limit.${randomUUID().slice(0, 8)}@example.test`,
    );
    expect(known).toEqual({ kind: "REFUSED", reason: "RATE_LIMITED" });
    expect(unknown).toEqual(known);
  });

  it("warns about a possible duplicate with one boolean, then creates only after explicit acknowledgement", async () => {
    const email = `test.dupe.${randomUUID().slice(0, 8)}@example.test`;
    expect(outcome(await prospect(as("recruiter"), { email }))).toBe("CREATED");
    const warned = await prospect(as("recruiter"), {
      email: email.toUpperCase(),
    });
    expect(warned).toEqual({
      kind: "UNCHANGED",
      outcome: "POSSIBLE_DUPLICATE",
      targetId: null,
    });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE email_normalized = $1",
        [email],
      ),
    ).toBe(1);
    const acknowledged = await prospect(as("recruiter"), {
      email,
      acknowledgeDuplicate: "yes",
    });
    expect(outcome(acknowledged)).toBe("CREATED");
    const { rows } = await admin.query(
      `SELECT m.id, m.status, m.signal_codes, m.confidence_tier, m.ruleset_version FROM app.duplicate_candidate_match m
         JOIN app.person a ON a.id = m.person_a_id WHERE a.email_normalized = $1`,
      [email],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        status: "PENDING",
        signal_codes: ["EXACT_EMAIL"],
        confidence_tier: "HIGH",
        ruleset_version: "DUP-1",
      }),
    ]);
    expect(await eventNames(rows[0].id)).toEqual(["duplicate_match.created"]);
  });

  it("never matches on names alone", async () => {
    const first = await prospect(as("recruiter"), {
      legalFirstName: "TEST Same",
      legalLastName: "TEST Name",
    });
    const second = await prospect(as("recruiter"), {
      legalFirstName: "TEST Same",
      legalLastName: "TEST Name",
    });
    expect([outcome(first), outcome(second)]).toEqual(["CREATED", "CREATED"]);
  });

  it("starts the application from a prospect, assigns the actor as owner, and closes prospects with history", async () => {
    const created = await prospect(as("recruiter"));
    if (created.kind !== "DONE") throw new Error("prospect");
    const row = await candidacyOf(created.targetId);
    const owned = await assignCandidacyOwnerToSelf(
      {
        commandKey: ckey(),
        candidacyId: row.public_id,
        expectedVersion: String(row.version),
      },
      as("recruiter"),
      deps,
    );
    expect(outcome(owned)).toBe("UPDATED");
    expect((await candidacyOf(row.id)).owner_account_id).toBe(
      staff.recruiter!.principal.accountId,
    );
    expect(
      outcome(
        await assignCandidacyOwnerToSelf(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(row.version),
          },
          as("hr"),
          deps,
        ),
      ),
    ).toBe("NOT_AUTHORIZED");
    const current = await candidacyOf(row.id);
    expect(
      outcome(
        await startApplicationFromProspect(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(current.version - 1),
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("STALE_VERSION");
    expect(
      outcome(
        await startApplicationFromProspect(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(current.version),
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    const started = await candidacyOf(row.id);
    expect(started).toMatchObject({
      current_stage: "APPLICATION_INCOMPLETE",
      person_id: row.person_id,
    });
    expect(
      outcome(
        await closeProspect(
          {
            commandKey: ckey(),
            candidacyId: row.public_id,
            expectedVersion: String(started.version),
            reasonCode: "NOT_INTERESTED",
          },
          as("recruiter"),
          deps,
        ),
      ),
    ).toBe("INVALID_TRANSITION");
    const other = await prospect(as("hr"));
    if (other.kind !== "DONE") throw new Error("prospect");
    const otherRow = await candidacyOf(other.targetId);
    expect(
      outcome(
        await closeProspect(
          {
            commandKey: ckey(),
            candidacyId: otherRow.public_id,
            expectedVersion: String(otherRow.version),
            reasonCode: "UNREACHABLE",
          },
          as("hr"),
          deps,
        ),
      ),
    ).toBe("UPDATED");
    expect(await eventNames(row.id)).toEqual([
      "candidacy.created",
      "candidacy.stage_changed",
      "candidacy.owner_assigned",
      "candidacy.stage_changed",
    ]);
    expect(await eventNames(otherRow.id)).toEqual([
      "candidacy.created",
      "candidacy.stage_changed",
      "candidacy.stage_changed",
      "prospect.closed",
    ]);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.candidacy_stage_history WHERE candidacy_id = $1",
        [row.id],
      ),
    ).toBe(2);
  });

  it("shows staff exact scoped projections and one NOT_FOUND for everything out of scope", async () => {
    const created = await prospect(as("recruiter"));
    if (created.kind !== "DONE") throw new Error("prospect");
    const row = await candidacyOf(created.targetId);
    const detail = await queryProspectDetail(
      headers(staff.recruiter!.jar),
      row.public_id,
      deps,
    );
    expect(detail.kind).toBe("OK");
    if (detail.kind === "OK") {
      expect(detail.view.owner).toBe("Unassigned");
      expect(JSON.stringify(detail.view)).not.toMatch(
        /candidate_account|accountId|personId|[0-9a-f]{8}-[0-9a-f]{4}-/,
      );
    }
    for (const name of ["recruiterOther", "administrator", "otherManager"]) {
      expect(
        await queryProspectDetail(
          headers(staff[name]!.jar),
          row.public_id,
          deps,
        ),
        name,
      ).toEqual({ kind: "NOT_FOUND" });
    }
    expect(
      await queryProspectDetail(
        headers(staff.recruiter!.jar),
        "zzzzzzzzzzzz",
        deps,
      ),
    ).toEqual({ kind: "NOT_FOUND" });
    const form = await queryProspectForm(headers(staff.recruiter!.jar), deps);
    expect(
      form.kind === "OK" && form.view.openings.map((o) => o.reference),
    ).toContain(cycle.ref);
    const otherForm = await queryProspectForm(
      headers(staff.recruiterOther!.jar),
      deps,
    );
    expect(
      otherForm.kind === "OK" &&
        otherForm.view.openings.map((o) => o.reference),
    ).not.toContain(cycle.ref);
  });
});

// ------------------------------------------------------ review and merge

describe("duplicate review and person merge (AC-M2.2-09/10/11/13/14)", () => {
  let cycle: Awaited<ReturnType<typeof openCycle>>;
  let cycle2: Awaited<ReturnType<typeof openCycle>>;
  beforeAll(async () => {
    cycle = await openCycle(tree.branch);
    cycle2 = await openCycle(tree.branch2);
    await stepUp(h, managerMember, staff.manager!, "CANDIDATE_IDENTITY_REVIEW");
  }, 120_000);

  async function matchFor(email: string) {
    const { rows } = await admin.query<{
      id: string;
      public_id: string;
      version: number;
    }>(
      `SELECT m.id, m.public_id, m.version FROM app.duplicate_candidate_match m
         JOIN app.person a ON a.id = m.person_a_id JOIN app.person b ON b.id = m.person_b_id
        WHERE a.email_normalized = $1 OR b.email_normalized = $1 ORDER BY m.created_at DESC LIMIT 1`,
      [email],
    );
    return rows[0]!;
  }

  it("records a case when a candidate's own email matches a staff prospect, without telling the candidate anything", async () => {
    const candidate = await candidateSession(h);
    const fresh = await candidateSession(h);
    done(
      await createStaffProspect(
        {
          commandKey: ckey(),
          cycleReference: cycle2.ref,
          ...names,
          email: candidate.email,
        },
        as("manager"),
        deps,
      ).then(
        (r) => ({ ...r, kind: r.kind === "DONE" ? "DONE" : r.kind }) as never,
      ),
    );
    const matched = await selfStart(candidate, cycle2.ref);
    const unmatched = await selfStart(fresh, cycle2.ref);
    expect(matched.kind).toBe(unmatched.kind);
    expect(outcome(matched)).toBe(outcome(unmatched));
    expect(Object.keys(matched).sort()).toEqual(Object.keys(unmatched).sort());
    const view = await queryCandidateStart(
      headers(candidate.jar),
      undefined,
      { latest: true },
      deps,
    );
    expect(JSON.stringify(view)).not.toMatch(/duplicate|match|review/i);
    expect((await matchFor(candidate.email)).public_id).toMatch(
      /^[0-9a-z]{12}$/,
    );
  });

  it("limits review to the stepped-up PSA manager and refuses everyone else identically", async () => {
    const email = `test.review.${randomUUID().slice(0, 8)}@example.test`;
    await createStaffProspect(
      { commandKey: ckey(), cycleReference: cycle.ref, ...names, email },
      as("recruiter"),
      deps,
    );
    await createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: cycle.ref,
        ...names,
        email,
        acknowledgeDuplicate: "yes",
      },
      as("recruiter"),
      deps,
    );
    const match = await matchFor(email);
    for (const name of ["recruiter", "hr", "administrator", "otherManager"]) {
      expect(
        outcome(
          await reviewDuplicateMatch(
            {
              commandKey: ckey(),
              matchId: match.public_id,
              expectedVersion: String(match.version),
              decision: "NOT_DUPLICATE",
              reasonCode: "DIFFERENT_PEOPLE_CONFIRMED",
            },
            as(name),
            deps,
          ),
        ),
        name,
      ).toBe("NOT_AUTHORIZED");
      expect(
        await queryDuplicateReview(
          headers(staff[name]!.jar),
          match.public_id,
          deps,
        ),
        name,
      ).toEqual({ kind: "NOT_FOUND" });
    }
    const review = await queryDuplicateReview(
      headers(staff.manager!.jar),
      match.public_id,
      deps,
    );
    expect(review.kind).toBe("OK");
    if (review.kind === "OK") {
      expect(review.view.signals).toEqual(["EXACT_EMAIL"]);
      expect(review.view.first.email).toMatch(/•••@example\.test$/);
      expect(JSON.stringify(review.view)).not.toContain(email);
    }
    const queue = await queryDuplicateQueue(headers(staff.manager!.jar), deps);
    expect(queue.kind, JSON.stringify(queue).slice(0, 300)).toBe("OK");
    expect(queue.kind === "OK" && queue.view.cases.map((c) => c.id)).toContain(
      match.public_id,
    );
    expect(
      outcome(
        await reviewDuplicateMatch(
          {
            commandKey: ckey(),
            matchId: match.public_id,
            expectedVersion: String(match.version),
            decision: "NOT_DUPLICATE",
            reasonCode: "DIFFERENT_PEOPLE_CONFIRMED",
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("NOT_DUPLICATE");
    expect(
      await count("SELECT count(*)::int AS n FROM app.person_merge_record"),
    ).toBe(0);
    expect(await eventNames(match.id)).toEqual([
      "duplicate_match.created",
      "duplicate_match.reviewed",
    ]);
  });

  it("merges a confirmed duplicate with provenance, transfers the single account link, and keeps old references resolvable", async () => {
    const candidate = await candidateSession(h);
    const created = await createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: cycle.ref,
        ...names,
        email: candidate.email,
      },
      as("manager"),
      deps,
    );
    if (created.kind !== "DONE") throw new Error("prospect");
    const prospectRow = await candidacyOf(created.targetId);
    await selfStart(candidate, cycle2.ref);
    const match = await matchFor(candidate.email);
    const confirmed = await reviewDuplicateMatch(
      {
        commandKey: ckey(),
        matchId: match.public_id,
        expectedVersion: String(match.version),
        decision: "CONFIRMED_DUPLICATE",
        reasonCode: "SAME_PERSON_CONFIRMED",
      },
      as("manager"),
      deps,
    );
    expect(outcome(confirmed)).toBe("CONFIRMED_DUPLICATE");
    const merged = await mergePeople(
      {
        commandKey: ckey(),
        matchId: match.public_id,
        expectedVersion: String(match.version + 1),
        reasonCode: "CONFIRMED_DUPLICATE_RECORD",
      },
      as("manager"),
      deps,
    );
    expect(outcome(merged)).toBe("MERGED");
    const { rows: people } = await admin.query(
      "SELECT id, status, merged_into_person_id, candidate_account_id FROM app.person WHERE id IN (SELECT person_a_id FROM app.duplicate_candidate_match WHERE id = $1 UNION SELECT person_b_id FROM app.duplicate_candidate_match WHERE id = $1)",
      [match.id],
    );
    const survivor = people.find((p) => p.status === "ACTIVE")!;
    const mergedPerson = people.find((p) => p.status === "MERGED")!;
    expect(survivor.candidate_account_id).toBe(candidate.accountId);
    expect(mergedPerson.merged_into_person_id).toBe(survivor.id);
    expect((await candidacyOf(prospectRow.id)).person_id).toBe(survivor.id);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person_merge_record WHERE merged_person_id = $1",
        [mergedPerson.id],
      ),
    ).toBe(1);
    expect(await eventNames(mergedPerson.id)).toContain("person.merged");
    const detail = await queryProspectDetail(
      headers(staff.manager!.jar),
      prospectRow.public_id,
      deps,
    );
    expect(detail.kind).toBe("OK");
    // Merging again is refused; the case is closed.
    expect(
      outcome(
        await mergePeople(
          {
            commandKey: ckey(),
            matchId: match.public_id,
            expectedVersion: String(match.version + 2),
            reasonCode: "CONFIRMED_DUPLICATE_RECORD",
          },
          as("manager"),
          deps,
        ),
      ),
    ).not.toBe("MERGED");
  });

  it("blocks a merge of two candidate accounts or colliding current candidacies with zero changes and durable evidence", async () => {
    const phone = `(606) 555-0${Math.floor(100 + Math.random() * 899)}`;
    const a = await candidateSession(h);
    const b = await candidateSession(h);
    await selfStart(a, cycle.ref, { phone });
    await selfStart(b, cycle.ref, { phone });
    const { rows } = await admin.query<{
      id: string;
      public_id: string;
      version: number;
    }>(
      `SELECT m.id, m.public_id, m.version FROM app.duplicate_candidate_match m
        JOIN app.person p ON p.id IN (m.person_a_id, m.person_b_id) WHERE p.candidate_account_id = $1`,
      [b.accountId],
    );
    const match = rows[0]!;
    await reviewDuplicateMatch(
      {
        commandKey: ckey(),
        matchId: match.public_id,
        expectedVersion: String(match.version),
        decision: "CONFIRMED_DUPLICATE",
        reasonCode: "SAME_PERSON_CONFIRMED",
      },
      as("manager"),
      deps,
    );
    const before = await count(
      "SELECT count(*)::int AS n FROM app.person WHERE status = 'MERGED'",
    );
    const blocked = await mergePeople(
      {
        commandKey: ckey(),
        matchId: match.public_id,
        expectedVersion: String(match.version + 1),
        reasonCode: "CONFIRMED_DUPLICATE_RECORD",
      },
      as("manager"),
      deps,
    );
    expect(outcome(blocked)).toBe("BLOCKED_TWO_CANDIDATE_ACCOUNTS");
    expect(
      await count(
        "SELECT count(*)::int AS n FROM app.person WHERE status = 'MERGED'",
      ),
    ).toBe(before);
    expect(await eventNames(match.id)).toContain("person.merge_blocked");

    const email = `test.collide.${randomUUID().slice(0, 8)}@example.test`;
    await createStaffProspect(
      { commandKey: ckey(), cycleReference: cycle.ref, ...names, email },
      as("manager"),
      deps,
    );
    await createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: cycle.ref,
        ...names,
        email,
        acknowledgeDuplicate: "yes",
      },
      as("manager"),
      deps,
    );
    const collide = await matchFor(email);
    await reviewDuplicateMatch(
      {
        commandKey: ckey(),
        matchId: collide.public_id,
        expectedVersion: String(collide.version),
        decision: "CONFIRMED_DUPLICATE",
        reasonCode: "SAME_PERSON_CONFIRMED",
      },
      as("manager"),
      deps,
    );
    expect(
      outcome(
        await mergePeople(
          {
            commandKey: ckey(),
            matchId: collide.public_id,
            expectedVersion: String(collide.version + 1),
            reasonCode: "CONFIRMED_DUPLICATE_RECORD",
          },
          as("manager"),
          deps,
        ),
      ),
    ).toBe("BLOCKED_CURRENT_CANDIDACY_COLLISION");
  });

  it("serializes a merge against a concurrent review so only one decision applies", async () => {
    const email = `test.race.${randomUUID().slice(0, 8)}@example.test`;
    await createStaffProspect(
      { commandKey: ckey(), cycleReference: cycle.ref, ...names, email },
      as("manager"),
      deps,
    );
    await createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: cycle2.ref,
        ...names,
        email,
        acknowledgeDuplicate: "yes",
      },
      as("manager"),
      deps,
    );
    const match = await matchFor(email);
    await admin.query("BEGIN");
    await admin.query(
      "SELECT 1 FROM app.duplicate_candidate_match WHERE id = $1 FOR UPDATE",
      [match.id],
    );
    const race = [
      reviewDuplicateMatch(
        {
          commandKey: ckey(),
          matchId: match.public_id,
          expectedVersion: String(match.version),
          decision: "CONFIRMED_DUPLICATE",
          reasonCode: "SAME_PERSON_CONFIRMED",
        },
        as("manager"),
        deps,
      ),
      reviewDuplicateMatch(
        {
          commandKey: ckey(),
          matchId: match.public_id,
          expectedVersion: String(match.version),
          decision: "NOT_DUPLICATE",
          reasonCode: "INSUFFICIENT_EVIDENCE",
        },
        as("manager"),
        deps,
      ),
    ];
    const observer = await connect(db.urls.admin);
    try {
      await waitForLockWait(observer, 2);
    } finally {
      await observer.end();
    }
    await admin.query("COMMIT");
    const results = (await Promise.all(race)).map(outcome);
    expect(
      results.filter((r) => r === "STALE_VERSION"),
      results.join(","),
    ).toHaveLength(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit.audit_event WHERE target_id = $1 AND event_name = 'duplicate_match.reviewed'",
        [match.id],
      ),
    ).toBe(1);
  });
});

// --------------------------------------------------------- database

describe("database integrity (AC-M2.2-14)", () => {
  let app: Client;
  beforeAll(async () => {
    app = await connect(db.urls.app);
  });
  afterAll(async () => {
    await app?.end();
  });
  const sqlstate = async (sql: string, params: unknown[] = []) => {
    try {
      await app.query(sql, params);
      return "ok";
    } catch (error) {
      return String((error as { code?: string }).code);
    }
  };

  it("refuses deletes, history rewrites, non-candidate owners, and incoherent candidacies for the runtime role", async () => {
    for (const table of [
      "person",
      "candidacy",
      "candidacy_stage_history",
      "duplicate_candidate_match",
      "person_merge_record",
      "candidate_command_receipt",
    ]) {
      expect(await sqlstate(`DELETE FROM app.${table}`), table).toBe("42501");
    }
    for (const table of [
      "candidacy_stage_history",
      "person_merge_record",
      "candidate_command_receipt",
    ]) {
      expect(await sqlstate(`UPDATE app.${table} SET id = id`), table).toBe(
        "42501",
      );
    }
    expect(
      await sqlstate(
        `INSERT INTO app.person (legal_first_name, legal_last_name, email_display, email_normalized, normalization_version, candidate_account_id, created_by_account_id, updated_by_account_id)
         VALUES ('TEST', 'TEST', 'x@example.test', 'x@example.test', 'NORM-1', $1, $1, $1)`,
        [staff.recruiter!.principal.accountId],
      ),
    ).toBe("CN003");
    const { rows } = await admin.query(
      "SELECT id, person_id, hiring_cycle_id FROM app.candidacy LIMIT 1",
    );
    expect(
      await sqlstate("UPDATE app.candidacy SET branch_id = $2 WHERE id = $1", [
        rows[0].id,
        tree.branch2,
      ]),
    ).not.toBe("ok");
    expect(
      await sqlstate(
        "UPDATE app.candidacy SET person_id = (SELECT id FROM app.person WHERE id <> $2 LIMIT 1) WHERE id = $1",
        [rows[0].id, rows[0].person_id],
      ),
    ).toBe("CN004");
    expect(
      await sqlstate(
        `INSERT INTO app.duplicate_candidate_match (public_id, organization_id, person_a_id, person_b_id, ruleset_version, signal_codes, confidence_tier)
         SELECT 'aaaaaaaaaaaa', $1, p.id, p.id, 'DUP-1', ARRAY['EXACT_EMAIL'], 'HIGH' FROM app.person p LIMIT 1`,
        [tree.org],
      ),
    ).toBe("23514");
  });

  it("keeps every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});
