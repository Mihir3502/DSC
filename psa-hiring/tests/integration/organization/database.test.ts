import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { ScopeResourceResolver } from "@/modules/identity-access/application/ports/scope-resource-resolver";
import { OrganizationScopeResolver } from "@/modules/organization/infrastructure/organization-scope-resolver";
import {
  transitionHiringCycle,
  createHiringCycle,
} from "@/modules/organization/application/commands/hiring-cycle-commands";
import { closeDatabasePool, getDatabase } from "@/shared/database";
import { connect } from "../support/audit";
import {
  createBootstrapPair,
  prepareAuthorizationDatabase,
  type BootstrapPair,
} from "../support/authorization";
import {
  adminClient,
  assertNoSecrets,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  runDbScript,
  type OwnedDatabase,
} from "../support/harness";
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

// M2.1 database integrity (packet M2.1 §22, §30 items 2–3, 5–7, 20;
// AC-M2.1-01/05/07/13). Every negative statement runs as the RUNTIME role
// (psa_app) against rows created through the real commands, so the
// constraints, triggers, and privileges — not application code — are what
// refuse it. Failure output reports SQLSTATE codes only.

const ctx = inject("postgres");
let db: OwnedDatabase;
let admin: Client;
let app: Client;
let restoreEnv: () => void;
let pair: BootstrapPair;
let tree: Hierarchy;
let positionId: string;
let descriptionId: string;
let cycleId: string;
const extraDatabases: string[] = [];

/** The SQLSTATE a runtime-role statement fails with ("ok" if it ran). */
async function sqlstate(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await app.query(sql, params);
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

beforeAll(async () => {
  ({ db, admin, restoreEnv } = await prepareAuthorizationDatabase(
    ctx,
    "org_db",
  ));
  app = await connect(db.urls.app);
  pair = await createBootstrapPair(admin);
  const h = createOrganizationHarness();
  const deps = configDeps(h);
  tree = await provisionHierarchy(deps, pair.creator, "DB");
  ({ position: positionId, description: descriptionId } =
    await provisionPosition(deps, pair.creator, tree.org, "CARE-DB"));
  const cycle = done(
    await createHiringCycle(
      {
        commandKey: key(),
        positionId,
        branchId: tree.branch,
        teamId: tree.team,
        code: "CYCLE-DB-1",
        internalLabel: "TEST cycle",
        opensAt: "2026-01-01T09:00",
        closesAt: "2099-01-01T09:00",
      },
      bootstrapActor(pair.creator),
      deps,
    ),
  );
  done(
    await transitionHiringCycle(
      "publish",
      {
        commandKey: key(),
        targetId: cycle.id,
        expectedVersion: String(cycle.version),
        reasonCode: reason,
      },
      bootstrapActor(pair.creator),
      deps,
    ),
  );
  cycleId = cycle.id;
}, 120_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await closeDatabasePool();
  restoreEnv?.();
  for (const name of extraDatabases) await dropOwnedDatabase(ctx, name);
  if (db) await dropOwnedDatabase(ctx, db.name);
});

describe("constraints refuse incoherent configuration", () => {
  it("refuses duplicate normalized codes in the same parent and allows them in another parent", async () => {
    expect(
      await sqlstate(
        `INSERT INTO app.branch (organization_id, code, name, public_location_label, timezone, created_by_account_id, updated_by_account_id)
         VALUES ($1, 'LEX', 'TEST dup', 'TEST', 'UTC', $2, $2)`,
        [tree.org, pair.creator],
      ),
    ).toBe("23505");
    // Lower-case is not a stored code form: the CHECK refuses it.
    expect(
      await sqlstate(
        `INSERT INTO app.branch (organization_id, code, name, public_location_label, timezone, created_by_account_id, updated_by_account_id)
         VALUES ($1, 'lex', 'TEST dup', 'TEST', 'UTC', $2, $2)`,
        [tree.org, pair.creator],
      ),
    ).toBe("23514");
    // The same code in another organization was accepted (org2 has LEX).
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM app.branch WHERE code = 'LEX'",
    );
    expect(rows[0].n).toBe(2);
  });

  it("refuses invalid status, worker path, code, and bounded text values", async () => {
    const insert = (code: string, path: string, status: string) =>
      sqlstate(
        `INSERT INTO app.position (organization_id, code, internal_title, public_title, worker_paths_allowed, status, activated_at, created_by_account_id, updated_by_account_id)
         VALUES ($1, $2, 'TEST', 'TEST', $3, $4::varchar, CASE WHEN $4::varchar = 'DRAFT' THEN NULL ELSE now() END, $5, $5)`,
        [tree.org, code, path, status, pair.creator],
      );
    const fresh = () => `P-${randomUUID().slice(0, 8)}`.toUpperCase();
    expect(await insert(fresh(), "W2_ONLY", "DRAFT")).toBe("ok");
    expect(await insert(fresh(), "W2_ONLY", "PUBLISHED")).toBe("23514");
    expect(await insert(fresh(), "APPROVED_1099", "DRAFT")).toBe("23514");
    expect(await insert("X", "W2_ONLY", "DRAFT")).toBe("23514");
    expect(await insert("BAD CODE", "W2_ONLY", "DRAFT")).toBe("23514");
    expect(
      await sqlstate(
        `UPDATE app.position SET internal_title = $2 WHERE id = $1`,
        [positionId, "x".repeat(121)],
      ),
    ).toBe("22001");
  });

  it("refuses a team whose organization is not its branch's organization", async () => {
    expect(
      await sqlstate(
        `INSERT INTO app.team (organization_id, branch_id, code, name, created_by_account_id, updated_by_account_id)
         VALUES ($1, $2, 'CROSS', 'TEST', $3, $3)`,
        [tree.org2, tree.branch, pair.creator],
      ),
    ).toBe("23503");
  });

  it("refuses cross-organization and cross-branch hiring cycles", async () => {
    const insert = (org: string, branch: string, team: string | null) =>
      sqlstate(
        `INSERT INTO app.hiring_cycle (public_reference, organization_id, position_id, branch_id, team_id, code, internal_label, opens_at, closes_at, display_timezone, created_by_account_id, updated_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'TEST', now(), now() + interval '1 day', 'UTC', $7, $7)`,
        [
          "a".repeat(12),
          org,
          positionId,
          branch,
          team,
          `X-${randomUUID().slice(0, 6)}`.toUpperCase(),
          pair.creator,
        ],
      );
    // Position from org 1 with a branch from org 2.
    expect(await insert(tree.org2, tree.org2Branch, null)).toBe("23503");
    expect(await insert(tree.org, tree.org2Branch, null)).toBe("23503");
    // Team of branch 1 placed under branch 2.
    expect(await insert(tree.org, tree.branch2, tree.team)).toBe("23503");
  });

  it("refuses incoherent windows and malformed public references", async () => {
    expect(
      await sqlstate(
        `UPDATE app.hiring_cycle SET closes_at = opens_at WHERE id = $1`,
        [cycleId],
      ),
    ).not.toBe("ok");
    expect(
      await sqlstate(
        `INSERT INTO app.hiring_cycle (public_reference, organization_id, position_id, branch_id, code, internal_label, opens_at, closes_at, display_timezone, created_by_account_id, updated_by_account_id)
         VALUES ('NOT-VALID-REF', $1, $2, $3, 'BADREF', 'TEST', now(), now() + interval '1 day', 'UTC', $4, $4)`,
        [tree.org, positionId, tree.branch, pair.creator],
      ),
    ).toBe("22001");
    expect(
      await sqlstate(
        `INSERT INTO app.hiring_cycle (public_reference, organization_id, position_id, branch_id, code, internal_label, opens_at, closes_at, open_ended, display_timezone, created_by_account_id, updated_by_account_id)
         VALUES ('bbbbbbbbbbbb', $1, $2, $3, 'NOEND', 'TEST', now(), NULL, false, 'UTC', $4, $4)`,
        [tree.org, positionId, tree.branch, pair.creator],
      ),
    ).toBe("23514");
  });
});

describe("history is immutable and never deleted", () => {
  it("refuses DELETE and TRUNCATE on every organization table for the runtime role", async () => {
    for (const table of [
      "organization",
      "branch",
      "team",
      "position",
      "job_description_version",
      "hiring_cycle",
      "organization_command_receipt",
    ]) {
      expect(await sqlstate(`DELETE FROM app.${table}`), table).toBe("42501");
      expect(await sqlstate(`TRUNCATE app.${table}`), table).toBe("42501");
    }
    // Even the owner cannot delete: the trigger refuses it.
    await admin.query("SET ROLE psa_migrator");
    try {
      await expect(
        admin.query("DELETE FROM app.hiring_cycle WHERE id = $1", [cycleId]),
      ).rejects.toMatchObject({ code: "OG001" });
    } finally {
      await admin.query("RESET ROLE");
    }
  });

  it("refuses edits to a published description and allows only supersession", async () => {
    expect(
      await sqlstate(
        "UPDATE app.job_description_version SET body = 'TEST rewritten' WHERE id = $1",
        [descriptionId],
      ),
    ).toBe("OG004");
    expect(
      await sqlstate(
        "UPDATE app.job_description_version SET status = 'DRAFT', published_at = NULL, published_by_account_id = NULL WHERE id = $1",
        [descriptionId],
      ),
    ).toBe("OG004");
    expect(
      await sqlstate(
        "UPDATE app.job_description_version SET version_number = 99 WHERE id = $1",
        [descriptionId],
      ),
    ).toBe("OG002");
  });

  it("refuses snapshot, window, reference, and backward-status changes on a published cycle", async () => {
    for (const statement of [
      "UPDATE app.hiring_cycle SET public_title_snapshot = 'TEST rewritten' WHERE id = $1",
      "UPDATE app.hiring_cycle SET opens_at = opens_at - interval '1 day' WHERE id = $1",
      "UPDATE app.hiring_cycle SET worker_paths_snapshot = 'W2_ONLY' WHERE id = $1",
      "UPDATE app.hiring_cycle SET code = 'RENAMED' WHERE id = $1",
    ]) {
      expect(await sqlstate(statement, [cycleId]), statement).toBe("OG004");
    }
    // A no-op status write on a published cycle is not a transition.
    expect(
      await sqlstate(
        "UPDATE app.hiring_cycle SET branch_id = branch_id WHERE id = $1",
        [cycleId],
      ),
    ).toBe("OG005");
    expect(
      await sqlstate(
        "UPDATE app.hiring_cycle SET team_id = NULL WHERE id = $1",
        [cycleId],
      ),
    ).toBe("OG002");
    expect(
      await sqlstate(
        "UPDATE app.hiring_cycle SET status = 'DRAFT' WHERE id = $1",
        [cycleId],
      ),
    ).toBe("OG005");
  });

  it("refuses reparenting and code changes after activation", async () => {
    expect(
      await sqlstate(
        "UPDATE app.branch SET organization_id = $2 WHERE id = $1",
        [tree.branch2, tree.org2],
      ),
    ).not.toBe("ok");
    expect(
      await sqlstate("UPDATE app.team SET branch_id = $2 WHERE id = $1", [
        tree.team,
        tree.branch2,
      ]),
    ).not.toBe("ok");
    expect(
      await sqlstate("UPDATE app.branch SET code = 'RENAMED' WHERE id = $1", [
        tree.branch,
      ]),
    ).toBe("OG003");
    expect(
      await sqlstate("UPDATE app.position SET code = 'RENAMED' WHERE id = $1", [
        positionId,
      ]),
    ).toBe("OG003");
  });

  it("keeps command receipts append-only", async () => {
    expect(
      await sqlstate(
        "UPDATE app.organization_command_receipt SET result_version = 9",
      ),
    ).toBe("42501");
  });
});

describe("migration from the accepted M1 schema", () => {
  it("applies 0005 over M1 with synthetic data, fabricating no hierarchy rows and resolving no old reference", async () => {
    const m1 = await createOwnedDatabase(ctx, "org_m1");
    extraDatabases.push(m1.name);
    const env = buildHarnessEnv(m1);
    const boot = await runDbScript("bootstrap", env);
    expect(boot.code, boot.output).toBe(0);
    const folder = mkdtempSync(path.join(tmpdir(), "psa-m1-"));
    try {
      const source = path.resolve(import.meta.dirname, "../../../drizzle");
      cpSync(source, folder, { recursive: true });
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter(
        (e: { idx: number }) => e.idx <= 4,
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      rmSync(path.join(folder, "0005_organization_hiring_cycle.sql"));
      const migrator = await connect(m1.urls.migrator);
      try {
        await migrate(drizzle({ client: migrator }), {
          migrationsFolder: folder,
          migrationsSchema: "drizzle",
          migrationsTable: "__drizzle_migrations",
        });
      } finally {
        await migrator.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const m1Admin = await adminClient(ctx, m1.name);
    try {
      expect(
        (await m1Admin.query("SELECT to_regclass('app.organization') AS t"))
          .rows[0].t,
      ).toBeNull();
      const email = `test.m1.${randomUUID()}@example.test`;
      const { rows } = await m1Admin.query<{ id: string }>(
        `INSERT INTO auth."user" (name, email, email_display, email_verified, account_type, status)
         VALUES ('TEST m1 staff', $1, $2, true, 'STAFF', 'ACTIVE') RETURNING id`,
        [email, email],
      );
      for (const step of [
        "migrate",
        "bootstrap",
        "catalog",
        "check",
      ] as const) {
        const result = await runDbScript(step, env);
        assertNoSecrets(ctx, result.output);
        expect(result.code, `${step}: ${result.output}`).toBe(0);
      }
      const kept = await m1Admin.query(
        'SELECT status FROM auth."user" WHERE id = $1',
        [rows[0]!.id],
      );
      expect(kept.rows[0].status).toBe("ACTIVE");
      for (const table of [
        "organization",
        "branch",
        "team",
        "position",
        "job_description_version",
        "hiring_cycle",
      ]) {
        const count = await m1Admin.query(
          `SELECT count(*)::int AS n FROM app.${table}`,
        );
        expect(count.rows[0].n, table).toBe(0);
      }
      // The catalog moved to version 2 (one apply event, nothing else).
      const catalog = await m1Admin.query(
        "SELECT max(catalog_version)::int AS v FROM auth.permission",
      );
      expect(catalog.rows[0].v).toBe(2);
      const events = await m1Admin.query(
        "SELECT event_name FROM audit.audit_event",
      );
      expect(events.rows.map((r) => r.event_name)).toEqual([
        "authz.catalog_applied",
      ]);
    } finally {
      await m1Admin.end();
    }
  });

  it("resolves an old synthetic scope reference only if a real ACTIVE entity exists", async () => {
    const resolver: ScopeResourceResolver = new OrganizationScopeResolver(() =>
      getDatabase(),
    );
    const at = new Date();
    expect(
      (await resolver.resolveScope("ORGANIZATION", randomUUID(), at, {}))
        .status,
    ).toBe("MISSING");
    expect(
      (await resolver.resolveScope("ORGANIZATION", tree.org, at, {})).status,
    ).toBe("ACTIVE");
    expect(
      (await resolver.resolveScope("BRANCH", tree.org, at, {})).status,
    ).toBe("TYPE_MISMATCH");
    expect(
      (await resolver.resolveScope("ASSIGNED_RECORDS", tree.org, at, {}))
        .status,
    ).toBe("UNAVAILABLE");
  });
});
