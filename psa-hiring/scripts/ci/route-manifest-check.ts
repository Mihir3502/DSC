import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { routeManifest } from "../../src/app/_security/route-manifest";
import { selfServicePolicies } from "../../src/modules/identity-access/domain/self-service-policy";
import { permissionCatalog } from "../../src/modules/identity-access/policy/permission-catalog";

// Built route tree vs. the reviewed authorization manifest (packet M1.5
// §7.3, §28.1). Run after `pnpm build`. Compares every built App Router
// page/handler route and every built Server Action (file + export) with
// the manifest, and fails on any difference. It also scans the client
// bundle (.next/static) for source maps and for server-only authorization
// internals (permission catalog codes, self-service policy codes, server
// module markers). Prints only route paths, file paths, export names, and
// marker names; the build's action encryption key and action IDs are never
// read into output.

const root = path.resolve(import.meta.dirname, "../..");
const nextDir = path.join(root, ".next");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function main() {
  const routesFile = path.join(nextDir, "app-path-routes-manifest.json");
  const actionsFile = path.join(
    nextDir,
    "server/server-reference-manifest.json",
  );
  if (!existsSync(routesFile) || !existsSync(actionsFile)) {
    console.error("test:routes needs a production build first (pnpm build).");
    process.exitCode = 1;
    return;
  }

  const builtRoutes = new Set(
    Object.values(readJson(routesFile) as Record<string, string>).filter(
      // Framework-generated fallbacks backed by not-found/global-error.
      (route) => route !== "/_not-found" && route !== "/_global-error",
    ),
  );
  const manifestRoutes = new Set(
    routeManifest
      .filter((e) => e.kind === "PAGE" || e.kind === "ROUTE_HANDLER")
      .map((e) => e.route!),
  );

  const nodeActions = (
    readJson(actionsFile) as {
      node?: Record<string, { filename?: string; exportedName?: string }>;
    }
  ).node;
  const builtActions = new Set(
    Object.values(nodeActions ?? {}).map(
      (a) => `${a.filename ?? "?"}#${a.exportedName ?? "?"}`,
    ),
  );
  const manifestActions = new Set(
    routeManifest
      .filter((e) => e.kind === "SERVER_ACTION")
      .map((e) => `${e.file}#${e.export}`),
  );

  const diff = (a: Set<string>, b: Set<string>) =>
    [...a].filter((x) => !b.has(x)).sort();
  const problems = [
    ...diff(builtRoutes, manifestRoutes).map(
      (r) => `unclassified built route ${r}`,
    ),
    ...diff(manifestRoutes, builtRoutes).map(
      (r) => `manifest route not built ${r}`,
    ),
    ...diff(builtActions, manifestActions).map(
      (a) => `unclassified built action ${a}`,
    ),
    ...diff(manifestActions, builtActions).map(
      (a) => `manifest action not built ${a}`,
    ),
  ];
  // Client bundle leakage: nothing server-only may ship to browsers.
  const staticDir = path.join(nextDir, "static");
  const clientFiles: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else clientFiles.push(full);
    }
  };
  walk(staticDir);
  const markers = [
    ...permissionCatalog
      .filter((p) => p.domain !== "CANDIDATE_SELF")
      .map((p) => p.code),
    ...selfServicePolicies.map((p) => p.code),
    "authorizeAccountSelfService",
    "evaluateQueryScope",
    "BETTER_AUTH_SECRET",
    "DATABASE_URL",
    "neverReturnKeys",
    "server-only",
  ];
  for (const file of clientFiles) {
    const relative = path.relative(root, file);
    if (file.endsWith(".map")) {
      problems.push(`source map shipped to browsers: ${relative}`);
      continue;
    }
    if (!/\.(js|css|html|json|txt)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const marker of markers) {
      if (text.includes(marker)) {
        problems.push(
          `server-only marker ${marker} in client bundle ${relative}`,
        );
      }
    }
  }
  if (clientFiles.length === 0) problems.push("no client bundle found");

  if (problems.length > 0) {
    console.error(`test:routes found ${problems.length} difference(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `test:routes passed (${builtRoutes.size} routes, ${builtActions.size} server actions match the manifest; ${clientFiles.length} client bundle files carry no source map or server-only marker).`,
  );
}

main();
