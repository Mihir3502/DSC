import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseServerEnv, ServerEnvError } from "../src/config/env-schema";
import { resolveLocalDocumentRoot } from "./lib/local-paths";

// Isolated assertions for M0.2 configuration rules. Temporary until the
// M0.4 test framework replaces it. Uses synthetic values only.

const validLocal = {
  APP_ENV: "local",
  DATABASE_URL:
    "postgresql://psa_local:psa_local_only_change_me@127.0.0.1:5432/psa_hiring",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "1025",
  SMTP_FROM: "no-reply@example.test",
  DOCUMENT_STORAGE_ROOT: "./.local/documents",
  PROVIDER_MODE: "fake",
};

const validProduction = {
  APP_ENV: "production",
  DATABASE_URL: "postgresql://app@db.internal.example.com:5432/psa",
  SMTP_HOST: "smtp.internal.example.com",
  SMTP_PORT: "587",
  SMTP_FROM: "no-reply@agency.example.com",
  DOCUMENT_STORAGE_ROOT: "/srv/psa/documents",
  PROVIDER_MODE: "production",
};

function problemsFor(input: Record<string, string | undefined>): string[] {
  try {
    parseServerEnv(input);
  } catch (error) {
    assert.ok(error instanceof ServerEnvError);
    return [...error.problems, error.message];
  }
  assert.fail("expected configuration to be rejected");
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`ok    ${name}`);
}

test("valid local configuration passes and is frozen", () => {
  const env = parseServerEnv(validLocal);
  assert.equal(env.SMTP_PORT, 1025);
  assert.ok(Object.isFrozen(env));
});

test("valid production-shaped configuration passes", () => {
  parseServerEnv(validProduction);
});

test("missing DATABASE_URL fails with the variable name", () => {
  const problems = problemsFor({ ...validLocal, DATABASE_URL: undefined });
  assert.ok(problems.some((p) => p.startsWith("DATABASE_URL ")));
});

test("missing APP_ENV and PROVIDER_MODE fail (no silent defaults)", () => {
  const problems = problemsFor({
    ...validLocal,
    APP_ENV: undefined,
    PROVIDER_MODE: undefined,
  });
  assert.ok(problems.some((p) => p.startsWith("APP_ENV ")));
  assert.ok(problems.some((p) => p.startsWith("PROVIDER_MODE ")));
});

test("invalid SMTP_PORT fails", () => {
  for (const port of ["0", "70000", "abc", "25.5"]) {
    const problems = problemsFor({ ...validLocal, SMTP_PORT: port });
    assert.ok(
      problems.some((p) => p.startsWith("SMTP_PORT ")),
      port,
    );
  }
});

test("credential-bearing invalid URL is not echoed", () => {
  const secret = "SuperSecret-canary-91";
  for (const url of [
    `mysql://user:${secret}@db.example.com/app`,
    `postgres://user:${secret}@`,
    `not a url ${secret}`,
  ]) {
    const output = problemsFor({ ...validLocal, DATABASE_URL: url }).join("\n");
    assert.ok(output.includes("DATABASE_URL"));
    assert.ok(!output.includes(secret), "secret leaked in error output");
    assert.ok(!output.includes("user:"), "URL userinfo leaked");
  }
});

test("non-reserved sender domain is rejected outside production", () => {
  const problems = problemsFor({ ...validLocal, SMTP_FROM: "hr@gmail.com" });
  assert.ok(problems.some((p) => p.startsWith("SMTP_FROM ")));
});

test("production rejects PROVIDER_MODE=fake", () => {
  const problems = problemsFor({ ...validProduction, PROVIDER_MODE: "fake" });
  assert.ok(problems.some((p) => p.startsWith("PROVIDER_MODE ")));
});

test("production rejects loopback database and SMTP hosts", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]", "api.localhost"]) {
    const problems = problemsFor({
      ...validProduction,
      DATABASE_URL: `postgresql://app@${host}:5432/psa`,
      SMTP_HOST: host.replace(/^\[|\]$/g, ""),
    });
    assert.ok(
      problems.some((p) => p.startsWith("DATABASE_URL ")),
      host,
    );
    assert.ok(
      problems.some((p) => p.startsWith("SMTP_HOST ")),
      host,
    );
  }
});

test("production rejects repository-local document paths", () => {
  for (const dir of [
    "./.local/documents",
    ".local/documents",
    "/app/.local/docs",
    "documents",
  ]) {
    const problems = problemsFor({
      ...validProduction,
      DOCUMENT_STORAGE_ROOT: dir,
    });
    assert.ok(
      problems.some((p) => p.startsWith("DOCUMENT_STORAGE_ROOT ")),
      dir,
    );
  }
});

const projectRoot = realpathSync(
  mkdtempSync(path.join(os.tmpdir(), "psa-m02-")),
);

test("approved .local/documents path resolves inside the project", () => {
  const resolved = resolveLocalDocumentRoot("./.local/documents", projectRoot);
  assert.equal(resolved, path.join(projectRoot, ".local", "documents"));
});

test("unsafe document paths are refused", () => {
  for (const dir of [
    "/",
    os.homedir(),
    "~",
    "~/documents",
    "../outside",
    "./.local/../../escape",
    "public/docs",
    "./.local/public/docs",
    ".local",
    ".",
    "src/uploads",
  ]) {
    assert.throws(() => resolveLocalDocumentRoot(dir, projectRoot), Error, dir);
  }
});

rmdirSync(projectRoot); // empty temporary directory created above
console.log(`\n${passed} checks passed.`);
