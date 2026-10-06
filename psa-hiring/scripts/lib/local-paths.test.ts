import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalDocumentRoot } from "./local-paths";

// Pure path checks only; nothing is created on disk.
const projectRoot = path.join(os.tmpdir(), "psa-test-project-root");

describe("resolveLocalDocumentRoot", () => {
  it("resolves the approved .local/documents path inside the project", () => {
    expect(resolveLocalDocumentRoot("./.local/documents", projectRoot)).toBe(
      path.join(projectRoot, ".local", "documents"),
    );
  });

  it.each([
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
    "   ",
  ])("refuses unsafe path %j", (dir) => {
    expect(() => resolveLocalDocumentRoot(dir, projectRoot)).toThrow(
      /DOCUMENT_STORAGE_ROOT/,
    );
  });
});
