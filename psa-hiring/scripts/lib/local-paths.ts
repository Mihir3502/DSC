import os from "node:os";
import path from "node:path";

/**
 * Resolves a configured document-storage path and confirms it is a private
 * directory inside the project's ignored `.local/` area. Returns the absolute
 * path, or throws with a reason that does not depend on secret values.
 */
export function resolveLocalDocumentRoot(
  configured: string,
  projectRoot: string,
): string {
  const raw = configured.trim();
  if (raw.length === 0) {
    throw new Error("DOCUMENT_STORAGE_ROOT is empty");
  }

  const segments = raw.replace(/\\/g, "/").split("/");
  if (segments.includes("..")) {
    throw new Error("DOCUMENT_STORAGE_ROOT must not contain '..' segments");
  }
  if (segments.some((s) => s.toLowerCase() === "public")) {
    throw new Error(
      "DOCUMENT_STORAGE_ROOT must not be inside a public/ directory",
    );
  }
  if (raw === "~" || raw.startsWith("~/")) {
    throw new Error("DOCUMENT_STORAGE_ROOT must not use the home directory");
  }

  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, raw);
  const localArea = path.join(root, ".local");

  if (
    resolved === path.parse(resolved).root ||
    resolved === os.homedir() ||
    resolved === root
  ) {
    throw new Error(
      "DOCUMENT_STORAGE_ROOT must not be a filesystem root, home, or project root",
    );
  }
  if (resolved === localArea || !resolved.startsWith(localArea + path.sep)) {
    throw new Error(
      "DOCUMENT_STORAGE_ROOT must be a subdirectory of the project's .local/ directory",
    );
  }
  return resolved;
}
