import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AuditRecorder,
  queryAuditEvents,
  type AuditQueryDependencies,
  type AuditQueryPrincipal,
} from "@/modules/audit";
import { auditQueryDependencies } from "@/modules/identity-access";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../fixtures/canaries";
import { countRows, testKeys } from "../support/audit";
import {
  activateStaff,
  authzDeps,
  createAuthorizationHarness,
  createBootstrapPair,
  grant,
  prepareAuthorizationDatabase,
  scopes,
  signIn,
  syntheticId,
  type AuthorizationHarness,
  type BootstrapPair,
} from "../support/authorization";
import { dropOwnedDatabase, type OwnedDatabase } from "../support/harness";

// M1.6 authorized audit query projection (packet M1.6 §16, §24, §26
// (16–19); AC-M1.6-11). Internal service only. Synthetic data only.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let restoreEnv: () => void;
let h: AuthorizationHarness;
let pair: BootstrapPair;
let auditor: AuditQueryPrincipal;
let expiredAuditor: AuditQueryPrincipal;
let administrator: AuditQueryPrincipal;
let recruiter: AuditQueryPrincipal;

const GROUP = syntheticId(70);
const OTHER_GROUP = syntheticId(71);
const IN_GROUP = syntheticId(80);
const OUT_OF_GROUP = syntheticId(81);
const AUDIT = syntheticId(60);
const EXPIRED_AUDIT = syntheticId(61);
const DAY = 86_400_000;

const recorder = () =>
  new AuditRecorder({
    db: getDatabase(),
    logger: createLogger({ destination: createMemoryDestination() }),
    keys: testKeys(),
    source: "LOCAL_TEST",
  });

const deps = (): AuditQueryDependencies =>
  auditQueryDependencies(authzDeps(h), {
    candidaciesIn: async (organizationId, groups) =>
      organizationId === scopes.ORG && groups.includes(GROUP) ? [IN_GROUP] : [],
  });

const window = () => ({
  category: "ACCESS_CONTROL" as const,
  from: new Date(Date.now() - DAY),
  to: new Date(Date.now() + DAY),
});

async function placedDenial(organizationRef: string, candidacyRef: string) {
  expect(
    await recorder().record({
      code: "authz.high_risk_denied",
      actorRef: pair.creator,
      permissionCode: "screening.result.read_restricted",
      reasonCode: "SCOPE_MISMATCH",
      policyVersion: "authz-p1-c1",
      organizationRef,
      candidacyRef,
    }),
  ).toBe(true);
}

/**
 * Activates a staff member, runs `authorize` (role grants revoke existing
 * sessions by design), then signs in for a fresh MFA session.
 */
async function staffPrincipal(
  label: string,
  authorize: (accountId: string) => Promise<unknown>,
): Promise<AuditQueryPrincipal> {
  const staff = await activateStaff(h, label);
  await authorize(staff.accountId);
  const session = await signIn(h, staff);
  return {
    accountId: session.principal.accountId,
    accountType: "STAFF",
    sessionId: session.principal.sessionId,
  };
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "audit_query",
  ));
  h = createAuthorizationHarness();
  pair = await createBootstrapPair(admin);

  const now = Date.now();
  auditor = await staffPrincipal("auditor", async (id) => {
    h.resolver.addAuditAssignment(AUDIT, {
      organizationId: scopes.ORG,
      auditorAccountId: id,
      categories: ["CONFIDENTIAL_PERSONNEL"],
      recordGroupIds: [GROUP],
      recordsFrom: new Date(now - 2 * DAY),
      recordsTo: new Date(now + 2 * DAY),
      startsAt: new Date(now - DAY),
      endsAt: new Date(now + DAY),
    });
    await grant(h, pair, id, "AUDITOR_READ_ONLY", "AUDIT_ASSIGNMENT", AUDIT);
  });
  expiredAuditor = await staffPrincipal("expired-auditor", async (id) => {
    h.resolver.addAuditAssignment(EXPIRED_AUDIT, {
      organizationId: scopes.ORG,
      auditorAccountId: id,
      categories: ["CONFIDENTIAL_PERSONNEL"],
      recordGroupIds: [OTHER_GROUP],
      recordsFrom: new Date(now - 30 * DAY),
      recordsTo: new Date(now - 20 * DAY),
      startsAt: new Date(now - DAY),
      endsAt: new Date(now + DAY),
    });
    await grant(
      h,
      pair,
      id,
      "AUDITOR_READ_ONLY",
      "AUDIT_ASSIGNMENT",
      EXPIRED_AUDIT,
    );
  });
  administrator = await staffPrincipal("sysadmin", (id) =>
    grant(h, pair, id, "SYSTEM_ADMINISTRATOR", "ORGANIZATION", scopes.ORG),
  );
  recruiter = await staffPrincipal("recruiter", (id) =>
    grant(h, pair, id, "RECRUITER", "BRANCH", scopes.BRANCH),
  );

  // Visible: ORG + an in-group candidacy. Hidden: other candidacy/org.
  for (let i = 0; i < 3; i++) await placedDenial(scopes.ORG, IN_GROUP);
  await placedDenial(scopes.ORG, OUT_OF_GROUP);
  await placedDenial(scopes.ORG2, IN_GROUP);
}, 300_000);

afterAll(async () => {
  await closeDatabasePool();
  await admin?.end();
  if (db) await dropOwnedDatabase(ctx, db.name);
  restoreEnv?.();
});

describe("authorized audit query projection", () => {
  it("returns an exact redacted keyset page filtered before materialization", async () => {
    const first = await queryAuditEvents(
      auditor,
      { ...window(), pageSize: 2 },
      deps(),
    );
    if (first.kind !== "OK") throw new Error(first.kind);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await queryAuditEvents(
      auditor,
      { ...window(), pageSize: 2, cursor: first.nextCursor },
      deps(),
    );
    if (second.kind !== "OK") throw new Error(second.kind);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((i) => i.id)).size).toBe(3);
    const sorted = [...all].sort(
      (x, y) =>
        x.occurredAt.getTime() - y.occurredAt.getTime() ||
        (x.id < y.id ? -1 : 1),
    );
    expect(all.map((i) => i.id)).toEqual(sorted.map((i) => i.id));

    const item = all[0]!;
    expect(item).toMatchObject({
      eventName: "authz.high_risk_denied",
      category: "ACCESS_CONTROL",
      outcome: "DENIED",
      actor: { type: "USER", ref: pair.creator },
      reasonCode: "SCOPE_MISMATCH",
      metadata: { policy_version: "authz-p1-c1" },
    });
    const text = JSON.stringify(all);
    for (const hidden of [
      OUT_OF_GROUP,
      scopes.ORG2,
      "integrity",
      "request",
      "chain",
      "idempotency",
      "SECURITY:",
      "IDENTITY:",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("audits each executed query once, outside its own page, without recursion", async () => {
    const before = await countRows(
      admin,
      "audit_event",
      "event_name = 'audit.query_executed' AND actor_user_id = $1",
      [auditor.accountId],
    );
    for (let i = 0; i < 3; i++) {
      const result = await queryAuditEvents(auditor, window(), deps());
      expect(result.kind).toBe("OK");
      if (result.kind === "OK") {
        expect(
          result.items.every((e) => e.eventName !== "audit.query_executed"),
        ).toBe(true);
      }
    }
    expect(
      await countRows(
        admin,
        "audit_event",
        "event_name = 'audit.query_executed' AND actor_user_id = $1",
        [auditor.accountId],
      ),
    ).toBe(before + 3);
    const { rows } = await admin.query(
      "SELECT category, target_type, metadata_json FROM audit.audit_event WHERE event_name = 'audit.query_executed' AND actor_user_id = $1 LIMIT 1",
      [auditor.accountId],
    );
    expect(rows[0]).toMatchObject({
      category: "AUDIT_ACCESS",
      target_type: "AUDIT_LOG",
      metadata_json: { filter_codes: ["ACCESS_CONTROL"] },
    });
  });

  it("denies candidates, administrators, wrong-scope staff, and anonymous callers", async () => {
    const candidate: AuditQueryPrincipal = {
      accountId: randomUUID(),
      accountType: "CANDIDATE",
      sessionId: randomUUID(),
    };
    for (const principal of [null, candidate, administrator, recruiter]) {
      expect(await queryAuditEvents(principal, window(), deps())).toEqual({
        kind: "NOT_PERMITTED",
      });
    }
    // A denial by a real account is itself recorded once (no recursion).
    expect(
      await countRows(
        admin,
        "audit_event",
        "event_name = 'audit.query_denied' AND actor_user_id = $1",
        [administrator.accountId],
      ),
    ).toBe(1);
  });

  it("bounds auditors by assignment dates, categories, and record groups in SQL", async () => {
    // Outside the assignment's record window: authorized, but nothing read.
    expect(await queryAuditEvents(expiredAuditor, window(), deps())).toEqual({
      kind: "OK",
      items: [],
      nextCursor: null,
    });
    // A category outside the assignment (restricted audit) is denied.
    expect(
      await queryAuditEvents(
        auditor,
        { ...window(), category: "RESTRICTED_ACCESS" },
        deps(),
      ),
    ).toEqual({ kind: "NOT_PERMITTED" });
    // No record-group resolver (pre-M2 default): fail closed, nothing read.
    expect(
      await queryAuditEvents(auditor, window(), {
        ...deps(),
        recordGroups: { candidaciesIn: async () => [] },
      }),
    ).toEqual({ kind: "OK", items: [], nextCursor: null });
  });

  it("rejects unbounded, unknown, or forged query input without reading", async () => {
    const base = window();
    for (const input of [
      { ...base, sql: "1=1" },
      { ...base, metadataPath: "$.x" },
      { ...base, actorUserId: pair.creator },
      { ...base, category: "EVERYTHING" },
      { ...base, from: new Date(Date.now() - 400 * DAY) },
      { ...base, pageSize: 500 },
      { ...base, cursor: "not a cursor!" },
      { ...base, eventName: "auth.sign_in_failed" },
      { ...base, eventName: "unknown.event" },
      "category=IDENTITY",
    ]) {
      expect(await queryAuditEvents(auditor, input, deps())).toEqual({
        kind: "INVALID_QUERY",
      });
    }
  });

  it("returns nothing when the query's own audit event cannot be written", async () => {
    const failing = {
      ...deps(),
      events: {
        record: async () => false,
        recordInTransaction: async () => {},
      },
    };
    expect(await queryAuditEvents(auditor, window(), failing)).toEqual({
      kind: "NOT_PERMITTED",
    });
  });
});
