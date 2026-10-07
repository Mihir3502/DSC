import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scopeTypes } from "@/modules/identity-access/domain/authorization-vocabulary";
import { auditScopeTypes } from "../domain/vocabulary";
import * as auditModule from "../index";
import {
  catalogEventNames,
  eventCatalog,
  findEventDefinition,
} from "./event-catalog";

// Packet M1.6 §9, §26 (5), AC-M1.6-02/04: one registry, every emitted code
// registered, and no mutation/repair surface in the module's public API.

const root = path.resolve(import.meta.dirname, "../../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("audit event catalog", () => {
  it("registers every emitted event name exactly once", () => {
    const names = eventCatalog.map((d) => `${d.name}@${d.version}`);
    expect(new Set(names).size).toBe(names.length);
    expect([...catalogEventNames].sort()).toEqual(
      eventCatalog.map((d) => d.name).sort(),
    );
    const emitted = new Set<string>();
    for (const file of [
      ...sourceFiles(path.join(root, "src")),
      ...sourceFiles(path.join(root, "scripts")),
    ]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\bcode:\s*"([a-z]+\.[a-z0-9_]+)"/g)) {
        emitted.add(match[1]);
      }
    }
    const unregistered = [...emitted].filter(
      (name) =>
        /^(auth|staff|authz|account|audit)\./.test(name) &&
        !findEventDefinition(name),
    );
    expect(unregistered).toEqual([]);
  });

  it("declares coherent stream, atomicity, actor, target, and projection rules", () => {
    for (const d of eventCatalog) {
      if (d.stream === "TELEMETRY") expect(d.atomicity).toBe("LOG_ONLY");
      if (d.stream === "AUDIT") expect(d.category).not.toBeNull();
      if (d.stream === "SECURITY") expect(d.target).toBeNull();
      if (d.idempotent) expect(d.requires).toContain("newVersion");
      if (d.targetFrom) expect(d.requires).toContain(d.targetFrom);
      for (const key of d.projectable) {
        expect(key).toMatch(/^[a-z_]+$/);
      }
      // Free text, payloads, and snapshots have no fact to travel in.
      expect(d.allows).not.toContain("metadata" as never);
    }
    expect(findEventDefinition("auth.sign_in_failed", 2)).toBeNull();
  });

  it("mirrors the identity scope vocabulary", () => {
    expect([...auditScopeTypes]).toEqual([...scopeTypes]);
  });

  it("exposes no update, delete, repair, rehash, export, or generic append", () => {
    const exported = Object.keys(auditModule);
    for (const name of exported) {
      expect(name).not.toMatch(
        /update|delete|repair|rehash|export|rewrite|purge/i,
      );
    }
    expect(exported).not.toContain("append");
    const sources = sourceFiles(path.join(root, "src/modules/audit")).map((f) =>
      readFileSync(f, "utf8"),
    );
    for (const text of sources) {
      expect(text).not.toMatch(
        /\b(UPDATE|DELETE FROM|TRUNCATE)\s+(audit\.|"audit")/,
      );
    }
  });
});
