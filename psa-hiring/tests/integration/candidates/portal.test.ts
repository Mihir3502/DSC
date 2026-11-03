import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createStaffProspect,
  startApplicationFromProspect,
  startOwnCandidacy,
} from "@/modules/candidates/application/candidate-commands";
import {
  queryCandidateHelp,
  queryCandidateHome,
  queryCandidateShell,
  queryCandidateTasks,
} from "@/modules/candidates/application/candidate-portal-queries";
import type { CandidateActor } from "@/modules/candidates/application/candidate-runtime";
import { reconcileCandidateWorkItems } from "@/modules/candidates/application/reconcile-work-items";
import {
  createHiringCycle,
  transitionHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import { toZonedLocal } from "@/modules/organization/domain/zoned-time";
import { closeDatabasePool } from "@/shared/database";
import { connect, verify } from "../support/audit";
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

// M2.3 candidate portal (packet M2.3 §7–§19, §28, §30; AC-M2.3-01..06, 10,
// 11). Candidates are real verified accounts with real sessions, and every
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
let hr: StaffSession;

const hrActor = (): CandidateActor => ({
  kind: "STAFF",
  principal: hr.principal,
});
const local = (d: Date) => toZonedLocal(d, "America/New_York");

async function openCycle() {
  const cdeps = configDeps(h);
  const actor = bootstrapActor(pair.creator);
  const cycle = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId,
        branchId: tree.branch,
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

async function start(candidate: CandidateSession) {
  const started = await startOwnCandidacy(
    {
      commandKey: ckey(),
      handoffToken: handoffFor(h, await openCycle()),
      legalFirstName: "TEST Ana",
      legalLastName: "TEST Ríos",
      preferredName: "TEST Annie",
    },
    candidate.actor,
    deps,
  );
  if (started.kind !== "DONE") throw new Error("start failed");
  const { rows } = await admin.query<{ public_id: string }>(
    "SELECT public_id FROM app.candidacy WHERE id = $1",
    [started.targetId],
  );
  return { internalId: started.targetId, publicId: rows[0]!.public_id };
}

const taskRows = async (candidacyId: string) =>
  (
    await admin.query(
      "SELECT work_type_code, status, source_code, version FROM app.work_item WHERE candidacy_id = $1",
      [candidacyId],
    )
  ).rows;

const closeDirectly = (candidacyId: string) =>
  admin.query(
    "UPDATE app.candidacy SET status = 'TERMINAL', candidate_visible_status = 'CLOSED', closed_at = now(), closure_reason_code = 'NO_LONGER_INTERESTED', version = version + 1 WHERE id = $1",
    [candidacyId],
  );

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "portal",
  ));
  h = createOrganizationHarness();
  deps = candidateDeps(h);
  pair = await createBootstrapPair(admin);
  tree = await provisionHierarchy(configDeps(h), pair.creator, "POR");
  ({ position: positionId } = await provisionPosition(
    configDeps(h),
    pair.creator,
    tree.org,
    "POR-POS",
  ));
  const member = await activateStaff(h, "portal-hr");
  await grant(
    h,
    pair,
    member.accountId,
    "HR_SPECIALIST",
    "ORGANIZATION",
    tree.org,
  );
  hr = await signIn(h, member);
}, 600_000);

afterAll(async () => {
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  if (db) await dropOwnedDatabase(ctx, db.name);
});

describe("entry and context (AC-M2.3-01/02/07)", () => {
  it("refuses an anonymous visitor, a staff session, and a disabled account on every portal query", async () => {
    const queries = (jarHeaders: Headers) => [
      queryCandidateShell(jarHeaders, deps),
      queryCandidateHome(jarHeaders, undefined, deps),
      queryCandidateTasks(jarHeaders, undefined, deps),
      queryCandidateHelp(
        jarHeaders,
        { agencyName: null, email: null, phone: null },
        deps,
      ),
    ];
    for (const result of await Promise.all(queries(headers()))) {
      expect(result).toEqual({ kind: "UNAUTHENTICATED" });
    }
    for (const result of await Promise.all(queries(headers(hr.jar)))) {
      expect(result).toEqual({ kind: "UNAUTHENTICATED" });
    }
    const candidate = await candidateSession(h);
    await start(candidate);
    await admin.query(
      `UPDATE auth."user" SET status = 'DISABLED', disabled_at = now(), disabled_reason_code = 'ADMINISTRATIVE_DISABLE' WHERE id = $1`,
      [candidate.accountId],
    );
    for (const result of await Promise.all(queries(headers(candidate.jar)))) {
      expect(result).toEqual({ kind: "UNAUTHENTICATED" });
    }
  });

  it("shows a truthful empty state and creates nothing for a candidate with no person", async () => {
    const candidate = await candidateSession(h);
    const home = await queryCandidateHome(
      headers(candidate.jar),
      undefined,
      deps,
    );
    expect(home).toEqual({
      kind: "OK",
      view: {
        current: null,
        candidacies: [],
        nextAction: null,
        taskCounts: {
          actionNeeded: 0,
          upcoming: 0,
          underReview: 0,
          completed: 0,
        },
      },
    });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM app.person WHERE candidate_account_id = $1",
      [candidate.accountId],
    );
    expect(rows[0].n).toBe(0);
    const shell = await queryCandidateShell(headers(candidate.jar), deps);
    if (shell.kind !== "OK") throw new Error("no shell");
    expect(shell.view.displayName).toBeNull();
    expect(shell.view.navigation.map((e) => e.key)).toEqual([
      "home",
      "tasks",
      "security",
      "help",
    ]);
  });

  it("selects a single candidacy automatically, with one next action and exact fields", async () => {
    const candidate = await candidateSession(h);
    const own = await start(candidate);
    const home = await queryCandidateHome(
      headers(candidate.jar),
      undefined,
      deps,
    );
    if (home.kind !== "OK") throw new Error("no home");
    expect(Object.keys(home.view).sort()).toEqual([
      "candidacies",
      "current",
      "nextAction",
      "taskCounts",
    ]);
    expect(home.view.candidacies).toEqual([]);
    expect(home.view.current).toMatchObject({
      candidacyId: own.publicId,
      status: {
        code: "APPLICATION_IN_PROGRESS",
        label: "Application in progress",
      },
    });
    expect(home.view.nextAction).toEqual({
      title: "Complete your application",
      instruction: "Answer each section. You can save and come back.",
      actionLabel: "Continue your application",
      href: `/candidate/applications/${own.publicId}`,
      due: null,
    });
    expect(home.view.taskCounts.actionNeeded).toBe(1);
    const text = JSON.stringify(home.view);
    expect(text).not.toContain(own.internalId);
    expect(text).not.toContain(candidate.accountId);
    expect(text).not.toMatch(/APPLICATION_INCOMPLETE|COMPLETE_APPLICATION|%/);
    const shell = await queryCandidateShell(headers(candidate.jar), deps);
    if (shell.kind !== "OK") throw new Error("no shell");
    expect(shell.view.displayName).toBe("TEST Annie");
    expect(shell.view.navigation.map((e) => e.key)).toContain("application");
  });

  it("offers an owned-only switcher and treats another person's or an unknown reference the same", async () => {
    const candidate = await candidateSession(h);
    const first = await start(candidate);
    const second = await start(candidate);
    const other = await candidateSession(h);
    const theirs = await start(other);
    const chosen = await queryCandidateHome(
      headers(candidate.jar),
      first.publicId,
      deps,
    );
    if (chosen.kind !== "OK") throw new Error("no home");
    expect(chosen.view.current?.candidacyId).toBe(first.publicId);
    expect(
      chosen.view.candidacies.map((c) => [c.candidacyId, c.selected]).sort(),
    ).toEqual(
      [
        [first.publicId, true],
        [second.publicId, false],
      ].sort(),
    );
    for (const tampered of [
      theirs.publicId,
      "abcdefghjkmn",
      "' OR 1=1 --",
      ["x"],
    ]) {
      expect(
        await queryCandidateHome(headers(candidate.jar), tampered, deps),
      ).toEqual({ kind: "NOT_FOUND" });
    }
    const list = await queryCandidateTasks(
      headers(candidate.jar),
      undefined,
      deps,
    );
    expect(JSON.stringify(list)).not.toContain(theirs.publicId);
  });
});

describe("tasks (AC-M2.3-05/06/10)", () => {
  it("opens exactly one task when a candidate starts, and shows no staff or internal field", async () => {
    const candidate = await candidateSession(h);
    const own = await start(candidate);
    expect(await taskRows(own.internalId)).toEqual([
      {
        work_type_code: "COMPLETE_APPLICATION",
        status: "OPEN",
        source_code: "CANDIDACY_TRANSITION",
        version: 1,
      },
    ]);
    const list = await queryCandidateTasks(
      headers(candidate.jar),
      "action_needed",
      deps,
    );
    if (list.kind !== "OK") throw new Error("no tasks");
    expect(list.view.tasks).toHaveLength(1);
    expect(Object.keys(list.view.tasks[0]!).sort()).toEqual([
      "actionLabel",
      "due",
      "href",
      "instruction",
      "key",
      "opening",
      "reference",
      "status",
      "title",
    ]);
    expect(list.view.tasks[0]).toMatchObject({
      status: "Action needed",
      due: null,
    });
    expect(JSON.stringify(list.view)).not.toMatch(
      /COMPLETE_APPLICATION|CANDIDACY|OPEN|NORMAL/,
    );
    for (const filter of ["upcoming", "under_review", "completed"]) {
      const empty = await queryCandidateTasks(
        headers(candidate.jar),
        filter,
        deps,
      );
      expect(empty).toMatchObject({ kind: "OK", view: { filter, tasks: [] } });
    }
    for (const filter of ["ALL", "completed'", ["completed"]]) {
      expect(
        await queryCandidateTasks(headers(candidate.jar), filter, deps),
      ).toEqual({ kind: "INVALID_FILTER" });
    }
  });

  it("gives an unowned staff candidacy no task until reconciliation sees an owner", async () => {
    const created = await createStaffProspect(
      {
        commandKey: ckey(),
        cycleReference: await openCycle(),
        legalFirstName: "TEST Prospect",
        legalLastName: "TEST Person",
        email: `test.portal.${randomUUID().slice(0, 8)}@example.test`,
      },
      hrActor(),
      deps,
    );
    if (created.kind !== "DONE") throw new Error("prospect failed");
    const { rows } = await admin.query<{ public_id: string; version: number }>(
      "SELECT public_id, version FROM app.candidacy WHERE id = $1",
      [created.targetId],
    );
    const advanced = await startApplicationFromProspect(
      {
        commandKey: ckey(),
        candidacyId: rows[0]!.public_id,
        expectedVersion: String(rows[0]!.version),
      },
      hrActor(),
      deps,
    );
    expect(advanced.kind).toBe("DONE");
    expect(await taskRows(created.targetId)).toEqual([]);
    await reconcileCandidateWorkItems(deps);
    expect(await taskRows(created.targetId)).toEqual([]);
  });

  it("hides a stale task on read without changing it, then reconciliation cancels it, repeatably", async () => {
    const candidate = await candidateSession(h);
    const own = await start(candidate);
    const missing = await start(candidate);
    await admin.query(
      "ALTER TABLE app.work_item DISABLE TRIGGER work_item_no_delete",
    );
    await admin.query("DELETE FROM app.work_item WHERE candidacy_id = $1", [
      missing.internalId,
    ]);
    await admin.query(
      "ALTER TABLE app.work_item ENABLE TRIGGER work_item_no_delete",
    );
    await closeDirectly(own.internalId);

    const before = await taskRows(own.internalId);
    const home = await queryCandidateHome(
      headers(candidate.jar),
      own.publicId,
      deps,
    );
    expect(home).toMatchObject({
      kind: "OK",
      view: {
        current: { status: { code: "NOT_CONTINUING" } },
        nextAction: null,
      },
    });
    const list = await queryCandidateTasks(
      headers(candidate.jar),
      "action_needed",
      deps,
    );
    if (list.kind !== "OK") throw new Error("no tasks");
    expect(list.view.tasks.map((t) => t.href)).not.toContain(
      `/candidate/applications/${own.publicId}`,
    );
    expect(await taskRows(own.internalId)).toEqual(before);

    // A missing row still yields the stage-derived action.
    const fallback = await queryCandidateHome(
      headers(candidate.jar),
      missing.publicId,
      deps,
    );
    expect(fallback).toMatchObject({
      kind: "OK",
      view: { nextAction: { title: "Complete your application" } },
    });

    const first = await reconcileCandidateWorkItems(deps);
    expect(first.opened).toBeGreaterThanOrEqual(1);
    expect(first.canceled).toBeGreaterThanOrEqual(1);
    expect(await taskRows(own.internalId)).toEqual([
      expect.objectContaining({ status: "CANCELED", version: 2 }),
    ]);
    expect(await taskRows(missing.internalId)).toEqual([
      expect.objectContaining({
        status: "OPEN",
        source_code: "RECONCILIATION",
      }),
    ]);
    expect(await reconcileCandidateWorkItems(deps)).toEqual({
      opened: 0,
      canceled: 0,
    });
    const history = await queryCandidateTasks(
      headers(candidate.jar),
      "completed",
      deps,
    );
    if (history.kind !== "OK") throw new Error("no tasks");
    expect(history.view.tasks).toEqual([
      expect.objectContaining({
        status: "No longer needed",
        href: null,
        actionLabel: null,
      }),
    ]);
  });

  it("never writes on a read: portal queries change no task, candidacy, or audit row", async () => {
    const candidate = await candidateSession(h);
    await start(candidate);
    const snapshot = async () =>
      (
        await admin.query(
          `SELECT (SELECT count(*) FROM app.work_item)::int AS tasks,
                  (SELECT count(*) FROM app.candidacy)::int AS candidacies,
                  (SELECT count(*) FROM app.application_version)::int AS drafts,
                  (SELECT count(*) FROM audit.audit_event WHERE event_name NOT LIKE 'authz.%')::int AS audit`,
        )
      ).rows[0];
    const before = await snapshot();
    const session = headers(candidate.jar);
    await queryCandidateShell(session, deps);
    await queryCandidateHome(session, undefined, deps);
    await queryCandidateTasks(session, undefined, deps);
    expect(await snapshot()).toEqual(before);
  });
});

describe("database integrity (AC-M2.3-05)", () => {
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

  it("enforces one active task, immutable identity, final history, and no delete for the runtime role", async () => {
    const candidate = await candidateSession(h);
    const own = await start(candidate);
    const other = await start(candidate);
    expect(await sqlstate("DELETE FROM app.work_item")).toBe("42501");
    expect(await sqlstate("TRUNCATE app.work_item")).toBe("42501");
    expect(
      await sqlstate(
        `INSERT INTO app.work_item (candidacy_id, work_type_code, target_record_type, target_record_id, candidate_action_required, source_code)
         VALUES ($1, 'COMPLETE_APPLICATION', 'CANDIDACY', $1, true, 'RECONCILIATION')`,
        [own.internalId],
      ),
    ).toBe("23505");
    for (const [sql, code] of [
      [
        `INSERT INTO app.work_item (candidacy_id, work_type_code, target_record_type, target_record_id, candidate_action_required, source_code)
         VALUES ($1, 'MADE_UP', 'CANDIDACY', $1, true, 'RECONCILIATION')`,
        "23514",
      ],
      [
        `INSERT INTO app.work_item (candidacy_id, work_type_code, target_record_type, target_record_id, candidate_action_required, source_code)
         VALUES ($1, 'COMPLETE_APPLICATION', 'CANDIDACY', gen_random_uuid(), true, 'RECONCILIATION')`,
        "23514",
      ],
      [
        "UPDATE app.work_item SET status = 'COMPLETED', version = version + 1 WHERE candidacy_id = $1",
        "23514",
      ],
      [
        "UPDATE app.work_item SET priority = 'HIGH' WHERE candidacy_id = $1",
        "CN005",
      ],
      [
        "UPDATE app.work_item SET source_code = 'BACKFILL', version = version + 1 WHERE candidacy_id = $1",
        "CN004",
      ],
    ] as const) {
      expect(await sqlstate(sql, [own.internalId]), sql).toBe(code);
    }
    await admin.query(
      "UPDATE app.work_item SET status = 'CANCELED', version = version + 1 WHERE candidacy_id = $1",
      [other.internalId],
    );
    expect(
      await sqlstate(
        "UPDATE app.work_item SET status = 'OPEN', version = version + 1 WHERE candidacy_id = $1",
        [other.internalId],
      ),
    ).toBe("CN005");
  });

  it("keeps every audit chain verifiable", async () => {
    expect((await verify(db)).ok).toBe(true);
  });
});
