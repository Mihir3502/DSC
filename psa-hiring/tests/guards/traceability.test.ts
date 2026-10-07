import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Validates tests/traceability/requirements.json (TEST_STRATEGY §5): every
// referenced test file exists and contains a test whose title includes the
// recorded text, so traceability cannot silently drift from the suite.

type TestRef = { file: string; title: string };
type Entry = { id: string; tests: TestRef[]; status?: string };

const root = path.resolve(import.meta.dirname, "../..");
const data = JSON.parse(
  readFileSync(path.join(root, "tests/traceability/requirements.json"), "utf8"),
) as { requirements: Entry[]; acceptanceCriteria: Entry[] };

describe("requirement traceability", () => {
  const entries = [...data.requirements, ...data.acceptanceCriteria];

  it("every traced test exists", () => {
    const missing: string[] = [];
    for (const entry of entries) {
      for (const ref of entry.tests) {
        const file = path.join(root, ref.file);
        if (!existsSync(file)) {
          missing.push(`${entry.id}: missing file ${ref.file}`);
          continue;
        }
        const titles = [
          ...readFileSync(file, "utf8").matchAll(
            /\b(?:it|test)(?:\.each\([\s\S]*?\))?\(\s*(["'`])([\s\S]*?)\1/g,
          ),
        ].map((m) => m[2].replace(/\s+/g, " "));
        if (!titles.some((title) => title.includes(ref.title))) {
          missing.push(
            `${entry.id}: no test titled "${ref.title}" in ${ref.file}`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it.each([
    ["M1.2", 17],
    ["M1.3", 16],
    ["M1.4", 16],
    ["M1.5", 16],
    ["M1.6", 16],
    ["M1.7", 16],
  ] as const)(
    "covers every %s acceptance criterion exactly once",
    (item, count) => {
      const ids = data.acceptanceCriteria
        .map((e) => e.id)
        .filter((id) => id.startsWith(`AC-${item}-`));
      expect(ids).toEqual(
        Array.from(
          { length: count },
          (_, i) => `AC-${item}-${String(i + 1).padStart(2, "0")}`,
        ),
      );
      expect(entries.every((e) => e.tests.length > 0)).toBe(true);
    },
  );

  it("keeps roles, ownership, and recent-auth requirements partial until M2 resolvers and business commands exist", () => {
    const roles = data.requirements.find((e) => e.id === "PRD-AUTH-003");
    expect(roles?.status).toBe("partial");
    const recent = data.requirements.find((e) => e.id === "PRD-AUTH-004");
    expect(recent?.status).not.toBe("covered");
    const own = data.requirements.find((e) => e.id === "PRD-AUTH-002");
    expect(own?.status).toBe("partial");
  });

  it("marks PRD-AUTH-007 covered by durable audit (M1.6)", () => {
    const audit = data.requirements.find((e) => e.id === "PRD-AUTH-007");
    expect(audit?.status).toBe("covered");
    // Business audit history, reports, and exports remain M2+ work.
    for (const id of ["PRD-AUD-001", "PRD-AUD-002"]) {
      expect(data.requirements.find((e) => e.id === id)?.status).toBe(
        "partial",
      );
    }
    for (const id of ["PRD-AUD-003", "PRD-AUD-004", "PRD-AUD-005"]) {
      expect(
        data.requirements.find((e) => e.id === id)?.status ?? "absent",
      ).not.toBe("covered");
    }
  });
});
