import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Source-tree enumeration of server entry points (packet M1.5 §7.3). Used
// by tests/guards/authorization-boundaries.test.ts and, against the build
// output, by scripts/ci/route-manifest-check.ts. Pure file reads; prints
// only file paths and export names.

export const projectRoot = path.resolve(import.meta.dirname, "../..");

export type DiscoveredEntry = Readonly<{
  kind:
    | "PAGE"
    | "LAYOUT"
    | "SPECIAL"
    | "ROUTE_HANDLER"
    | "SERVER_ACTION"
    | "PROXY"
    | "INSTRUMENTATION"
    | "LOCAL_HARNESS";
  file: string;
  export?: string;
}>;

export function listFiles(dir: string): string[] {
  const absolute = path.join(projectRoot, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(projectRoot, full).split(path.sep).join("/"));
    }
  };
  walk(absolute);
  return out.sort();
}

export const read = (file: string) =>
  readFileSync(path.join(projectRoot, file), "utf8");

const isTest = (file: string) => /\.test\.tsx?$/.test(file);

const specialNames = new Set([
  "not-found",
  "error",
  "global-error",
  "loading",
  "template",
  "default",
  "forbidden",
  "unauthorized",
]);

/** A top-level "use server" directive (module-level Server Actions). */
export function isServerActionModule(text: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\s)*["']use server["'];?/.test(text);
}

export function isClientModule(text: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\s)*["']use client["'];?/.test(text);
}

/** Exported async function names of a "use server" module. */
export function serverActionExports(text: string): string[] {
  return [...text.matchAll(/^export\s+async\s+function\s+([A-Za-z0-9_]+)/gm)]
    .map((m) => m[1])
    .sort();
}

/** Any export a "use server" module has that is not an async function. */
export function nonFunctionExports(text: string): string[] {
  return [
    ...text.matchAll(
      /^export\s+(?!async\s+function\b|type\b|interface\b)([A-Za-z]+)\s+([A-Za-z0-9_]+)/gm,
    ),
  ].map((m) => `${m[1]} ${m[2]}`);
}

const httpMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

export function routeHandlerExports(text: string): string[] {
  return httpMethods
    .filter((m) =>
      new RegExp(
        `^export\\s+(?:const|async\\s+function|function)\\s+${m}\\b|^export\\s*\\{[^}]*\\b${m}\\b`,
        "m",
      ).test(text),
    )
    .sort();
}

/** Every server entry point found in the source tree. */
export function discoverEntries(): DiscoveredEntry[] {
  const entries: DiscoveredEntry[] = [];
  for (const file of listFiles("src")) {
    if (!/\.(ts|tsx)$/.test(file) || isTest(file)) continue;
    const base = path.basename(file).replace(/\.(ts|tsx)$/, "");
    const inApp = file.startsWith("src/app/");
    if (inApp && base === "page") entries.push({ kind: "PAGE", file });
    else if (inApp && base === "layout") entries.push({ kind: "LAYOUT", file });
    else if (inApp && specialNames.has(base)) {
      entries.push({ kind: "SPECIAL", file });
    } else if (inApp && base === "route") {
      for (const method of routeHandlerExports(read(file))) {
        entries.push({ kind: "ROUTE_HANDLER", file, export: method });
      }
    }
    const text = read(file);
    if (isServerActionModule(text)) {
      for (const name of serverActionExports(text)) {
        entries.push({ kind: "SERVER_ACTION", file, export: name });
      }
    }
  }
  for (const [file, kind, name] of [
    ["src/proxy.ts", "PROXY", "proxy"],
    ["src/middleware.ts", "PROXY", "middleware"],
    ["src/instrumentation.ts", "INSTRUMENTATION", "onRequestError"],
  ] as const) {
    if (existsSync(path.join(projectRoot, file))) {
      entries.push({ kind, file, export: name });
    }
  }
  for (const file of listFiles("scripts/auth")) {
    if (file.endsWith(".ts") && !isTest(file)) {
      entries.push({ kind: "LOCAL_HARNESS", file });
    }
  }
  return entries;
}

export const entryKey = (e: { file: string; export?: string }) =>
  `${e.file}${e.export ? `#${e.export}` : ""}`;

/** Source of one exported function (to the next top-level export). */
export function functionBody(text: string, name: string): string | null {
  const start = text.search(
    new RegExp(`^export\\s+async\\s+function\\s+${name}\\b`, "m"),
  );
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/^export\s/m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/**
 * Lines of code with block and line comments removed (keeps line numbers).
 * String contents are kept, so a literal is still scanned.
 */
export function codeLines(text: string): string[] {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  return withoutBlocks
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

/** Narrow, reviewed inline suppression for a static finding. */
export const suppressionMarker = "authz-boundary-allow:";

export function isSuppressed(line: string): boolean {
  return new RegExp(`${suppressionMarker}\\s*\\S{8,}`).test(line);
}
