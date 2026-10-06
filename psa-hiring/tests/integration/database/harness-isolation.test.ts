import { afterEach, describe, expect, inject, it, vi } from "vitest";
import {
  adminClient,
  buildHarnessEnv,
  createOwnedDatabase,
  dropOwnedDatabase,
  HARNESS_LABEL,
} from "../support/harness";

// Proves the harness targets only its own container, whatever the developer
// environment contains.

const ctx = inject("postgres");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integration harness isolation", () => {
  it("targets the owned container, not the developer Compose database", async () => {
    const admin = await adminClient(ctx, "postgres");
    try {
      const { rows } = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database ORDER BY 1",
      );
      const names = rows.map((r) => r.datname);
      // The developer database (psa_hiring) does not exist in the owned container.
      expect(names).not.toContain("psa_hiring");
      expect(names).toContain(`psa_test_bootstrap_${ctx.runId}`);
      const version = await admin.query<{ v: number }>(
        "SELECT current_setting('server_version_num')::int AS v",
      );
      expect(Math.floor(version.rows[0].v / 10000)).toBe(18);
    } finally {
      await admin.end();
    }
    expect(HARNESS_LABEL).toBe("psa-hiring.test-harness-run");
  });

  it("ignores developer DATABASE_* variables when building script environments", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://psa_app:TEST_not_used@127.0.0.1:5432/psa_hiring",
    );
    vi.stubEnv(
      "DATABASE_MIGRATION_URL",
      "postgresql://psa_migrator:TEST_not_used@127.0.0.1:5432/psa_hiring",
    );
    vi.stubEnv(
      "DATABASE_ADMIN_URL",
      "postgresql://psa_local:TEST_not_used@127.0.0.1:5432/psa_hiring",
    );
    const db = await createOwnedDatabase(ctx, "isolation");
    try {
      const env = buildHarnessEnv(db);
      for (const key of [
        "DATABASE_URL",
        "DATABASE_MIGRATION_URL",
        "DATABASE_ADMIN_URL",
      ]) {
        const target = new URL(env[key]);
        expect(target.port).toBe(String(ctx.port));
        expect(target.pathname).toBe(`/${db.name}`);
        expect(env[key]).not.toContain("TEST_not_used");
      }
      expect(db.name).toMatch(
        new RegExp(`^psa_test_${ctx.runId}_isolation_[0-9a-f]{6}$`),
      );
    } finally {
      await dropOwnedDatabase(ctx, db.name);
    }
  });

  it("refuses to drop a database it did not create", async () => {
    await expect(dropOwnedDatabase(ctx, "psa_hiring")).rejects.toThrow(
      "refusing to drop a database this harness did not create",
    );
    await expect(
      dropOwnedDatabase(ctx, `psa_test_bootstrap_${ctx.runId}`),
    ).rejects.toThrow("refusing to drop");
  });
});
