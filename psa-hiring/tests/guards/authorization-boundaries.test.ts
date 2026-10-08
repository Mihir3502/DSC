import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { routeManifest } from "@/app/_security/route-manifest";
import { formSchemas } from "@/app/_auth/form-schemas";
import { selfServicePolicies } from "@/modules/identity-access/domain/self-service-policy";
import { securityProjectionNames } from "@/modules/identity-access/presentation/security-view-models";
import { findPermission } from "@/modules/identity-access/policy/permission-catalog";
import { organizationProjectionNames } from "@/modules/organization/presentation/staff-views";
import { isProtectedPath } from "@/shared/security/protected-cache-policy";
import {
  codeLines,
  discoverEntries,
  entryKey,
  functionBody,
  isClientModule,
  isServerActionModule,
  isSuppressed,
  listFiles,
  nonFunctionExports,
  projectRoot,
  read,
} from "./route-inventory";

// Authorization boundary and route-manifest drift checks (packet M1.5 §7.3,
// §20, AC-M1.5-01/13). Static scans complement the behavioral suites. A
// finding can be suppressed only by a same-line
// `authz-boundary-allow: <reviewed reason>` comment; none exist today.

const sourceFiles = listFiles("src").filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f),
);
const appFiles = sourceFiles.filter((f) => f.startsWith("src/app/"));
const byKey = new Map(routeManifest.map((e) => [entryKey(e), e]));

/** Reviewed static patterns (each has a self-check below). */
const patterns = {
  persistenceImport:
    /from\s+["'](?:drizzle-orm[^"']*|pg|better-auth[^"']*|@\/shared\/database[^"']*|[^"']*\/infrastructure(?:\/[^"']*)?)["']/,
  authLibraryApi: /\.api\.|getSession\(/,
  clientServerImport:
    /from\s+["'](?:server-only|next\/headers|@\/modules\/[a-z-]+|@\/modules\/[a-z-]+\/(?:application|infrastructure|policy|delivery|domain\/(?!email))[^"']*|@\/shared\/(?:database|http|security|validation)[^"']*|@\/shared\/logging(?!\/correlation)[^"']*|@\/config\/[^"']*|@\/app\/_(?:auth|security)[^"']*)["']/,
  roleCheck:
    /\bisAdmin\b|\broleCode\b|\bpermissionCode\b|["'](?:RECRUITER|HR_SPECIALIST|CLASSIFICATION_REVIEWER|COMPLIANCE_REVIEWER|TRAINER_EVALUATOR|PSA_MANAGER|SYSTEM_ADMINISTRATOR|AUDITOR_READ_ONLY)["']|permission-catalog|role-catalog|role-permission-catalog/,
  rawRedirect:
    /\b(?:redirect|permanentRedirect)\s*\(|from\s+["']next\/navigation["'].*\b(?:redirect|permanentRedirect)\b/,
  recordSpread:
    /\.\.\.\s*(?:row|rows\[\w+\]|record|user|session|account|evidence|result\.(?:user|session)|response|body|data)\b(?!\s*\?)/,
  staticRendering: /force-static|revalidate\s*=|["']use cache["']/,
  secretRetrieval: /viewBackupCodes|getTOTPURI|get-totp-uri\b(?!["'])/,
} as const;

/** An exported (async or plain) function's text up to the next export. */
function exportedFunction(text: string, name: string): string | null {
  const start = text.search(
    new RegExp(`^export\\s+(?:async\\s+)?function\\s+${name}\\b`, "m"),
  );
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/^export\s/m);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/** The organization-module application file defining a service. */
function organizationService(name: string) {
  return listFiles("src/modules/organization/application")
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .map((f) => ({ text: read(f), body: exportedFunction(read(f), name) }))
    .find((x) => x.body);
}

/** Findings as "file:line rule" (never source text). */
function scan(
  files: readonly string[],
  rule: string,
  pattern: RegExp,
): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const raw = read(file).split("\n");
    codeLines(read(file)).forEach((line, index) => {
      if (pattern.test(line) && !isSuppressed(raw[index] ?? "")) {
        findings.push(`${file}:${index + 1} ${rule}`);
      }
    });
  }
  return findings;
}

describe("route and entry-point manifest", () => {
  it("classifies every server entry point found in the source tree", () => {
    const missing = discoverEntries()
      .filter((e) => !byKey.has(entryKey(e)))
      .map((e) => `${e.kind} ${entryKey(e)}`);
    expect(missing, "unclassified server entry points").toEqual([]);
  });

  it("has no stale, duplicate, or mis-kinded entries", () => {
    const discovered = new Map(discoverEntries().map((e) => [entryKey(e), e]));
    const stale = routeManifest
      .filter((e) => discovered.get(entryKey(e))?.kind !== e.kind)
      .map((e) => e.id);
    expect(stale).toEqual([]);
    const ids = routeManifest.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = routeManifest.map(entryKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("allows no Next.js middleware file and no non-function Server Action exports", () => {
    expect(sourceFiles).not.toContain("src/middleware.ts");
    const offenders = sourceFiles.filter((f) => {
      const text = read(f);
      return isServerActionModule(text) && nonFunctionExports(text).length > 0;
    });
    expect(offenders).toEqual([]);
  });

  it("requires origin-checked POST for every state change and no state change on GET", () => {
    for (const entry of routeManifest) {
      if (entry.kind === "SERVER_ACTION") {
        expect(entry.method, entry.id).toBe("POST");
        expect(entry.csrf, entry.id).toBe("NEXT_SERVER_ACTION_ORIGIN");
      } else {
        expect(entry.csrf, entry.id).toBe("NO_STATE_CHANGE");
      }
      if (entry.kind === "ROUTE_HANDLER") {
        // The only handler is the closed auth catch-all.
        expect(entry.authorization.kind, entry.id).toBe("CLOSED");
        expect(["GET", "POST"]).toContain(entry.export);
      }
    }
  });

  it("binds every protected entry to the application authorization boundary", () => {
    const problems: string[] = [];
    for (const entry of routeManifest) {
      const protectedEntry =
        (entry.audience === "CANDIDATE" || entry.audience === "STAFF") &&
        entry.authentication === "REQUIRED";
      if (!protectedEntry) continue;
      const text = read(entry.file);
      if (entry.authorization.kind === "NAVIGATION_GUARD") {
        if (
          !text.includes(`guardNavigation("${entry.authorization.audience}")`)
        ) {
          problems.push(`${entry.id}: guard call missing`);
        }
        continue;
      }
      if (entry.authorization.kind === "PERMISSION" && entry.service) {
        // M2.1: the delivery calls one named organization service, which
        // authorizes the declared catalog permissions through the M1
        // central service; recent-auth declarations match the catalog.
        const body =
          entry.kind === "SERVER_ACTION"
            ? functionBody(text, entry.export!)
            : text;
        if (!body?.includes(`${entry.service}(`)) {
          problems.push(`${entry.id}: delivery does not call ${entry.service}`);
        }
        const owner = organizationService(entry.service);
        if (!owner) {
          problems.push(
            `${entry.id}: ${entry.service} is not an organization service`,
          );
          continue;
        }
        if (
          !/authorizeConfiguration\(|authorizeScopedList\(|authorizeQueryScope\(|\ballows\(/.test(
            owner.body ?? "",
          )
        ) {
          problems.push(
            `${entry.id}: ${entry.service} skips the authorization service`,
          );
        }
        for (const code of entry.authorization.permissions) {
          const permission = findPermission(code);
          if (!permission || permission.status !== "ACTIVE") {
            problems.push(`${entry.id}: unknown permission ${code}`);
          }
          if (!owner.text.includes(`"${code}"`)) {
            problems.push(`${entry.id}: ${entry.service} never names ${code}`);
          }
          if (entry.kind === "SERVER_ACTION") {
            const required = permission?.recentAuth?.policy ?? "NONE";
            if (required !== entry.recentAuth) {
              problems.push(`${entry.id}: recent-auth mismatch for ${code}`);
            }
          }
        }
        continue;
      }
      if (
        entry.authorization.kind === "HANDOFF_REVALIDATION" &&
        entry.service
      ) {
        if (!text.includes(`${entry.service}(`)) {
          problems.push(`${entry.id}: delivery does not call ${entry.service}`);
        }
        const owner = organizationService(entry.service)?.body ?? "";
        if (
          !owner.includes("resolveCurrentCandidate(") ||
          !owner.includes("verifyApplicationHandoff(")
        ) {
          problems.push(
            `${entry.id}: handoff is not re-validated for a candidate`,
          );
        }
        continue;
      }
      if (entry.authorization.kind !== "SELF_SERVICE" || !entry.service) {
        problems.push(`${entry.id}: no application authorization`);
        continue;
      }
      const policy = selfServicePolicies.find(
        (p) => p.code === (entry.authorization as { policy: string }).policy,
      );
      if (!policy || policy.audience !== entry.audience) {
        problems.push(`${entry.id}: policy audience mismatch`);
      }
      const body =
        entry.kind === "SERVER_ACTION"
          ? functionBody(text, entry.export!)
          : text;
      if (!body?.includes(`${entry.service}(`)) {
        problems.push(`${entry.id}: delivery does not call ${entry.service}`);
      }
      const owner = listFiles("src/modules/identity-access/application")
        .map((f) => ({ f, body: functionBody(read(f), entry.service!) }))
        .find((x) => x.body);
      if (!owner?.body?.includes(`"${policy?.code}"`)) {
        problems.push(
          `${entry.id}: ${entry.service} does not authorize ${policy?.code}`,
        );
      }
      if (!/authorizeAccountSelfService\(/.test(owner?.body ?? "")) {
        problems.push(
          `${entry.id}: ${entry.service} skips the authorization service`,
        );
      }
      if (entry.recentAuth === "RECENT_STAFF_AUTH") {
        if (policy?.recentAuth?.policy !== "RECENT_STAFF_AUTH") {
          problems.push(`${entry.id}: recent-auth mismatch`);
        }
      } else if (entry.recentAuth === "RECENT_STRONG_AUTH_INLINE") {
        if (
          policy?.recentAuth?.policy !== "RECENT_STRONG_AUTH" ||
          policy.recentAuth.stepUp.kind !== "INLINE"
        ) {
          problems.push(`${entry.id}: inline step-up mismatch`);
        }
      } else if (policy?.recentAuth) {
        problems.push(`${entry.id}: undeclared recent-auth requirement`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives every Server Action an exact reviewed input schema it actually parses", () => {
    const problems: string[] = [];
    for (const entry of routeManifest.filter(
      (e) => e.kind === "SERVER_ACTION",
    )) {
      if (!entry.input || !Object.hasOwn(formSchemas, entry.input)) {
        problems.push(`${entry.id}: no schema`);
        continue;
      }
      const body = functionBody(read(entry.file), entry.export!) ?? "";
      if (
        !body.includes(`parseFormInput(formData, formSchemas.${entry.input})`)
      ) {
        problems.push(`${entry.id}: schema not applied`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("names a reviewed exact projection for every protected data response", () => {
    for (const entry of routeManifest) {
      if (entry.output.endsWith(".v1")) {
        expect(
          [...securityProjectionNames, ...organizationProjectionNames],
          entry.id,
        ).toContain(entry.output);
      }
      if (
        entry.authorization.kind === "SELF_SERVICE" &&
        entry.kind === "PAGE"
      ) {
        expect(
          entry.output === "PROMPT_ONLY" || entry.output.endsWith(".v1"),
          entry.id,
        ).toBe(true);
      }
    }
  });

  it("marks every personal, capability, or protected route private/no-store and dynamic", () => {
    const problems: string[] = [];
    for (const entry of routeManifest) {
      if (!entry.route) continue;
      const route = entry.route.replace(/\[\.\.\.[a-z]+\]/, "x");
      if (entry.cache === "PRIVATE_NO_STORE" && !isProtectedPath(route)) {
        problems.push(`${entry.id}: route not covered by the cache policy`);
      }
      if (entry.kind === "PAGE" && entry.cache === "PRIVATE_NO_STORE") {
        if (
          !read(entry.file).includes(
            'export const dynamic = "force-dynamic"',
          ) &&
          !["public.candidate_landing", "public.staff_landing"].includes(
            entry.id,
          )
        ) {
          problems.push(`${entry.id}: page is not force-dynamic`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(
      scan(appFiles, "static/cached rendering", patterns.staticRendering),
    ).toEqual([]);
  });
});

describe("delivery and client boundaries", () => {
  it("keeps delivery code away from persistence, the auth library, and infrastructure", () => {
    expect(
      scan(
        appFiles,
        "persistence/auth import in delivery",
        patterns.persistenceImport,
      ),
    ).toEqual([]);
    expect(
      scan(appFiles, "auth library API in delivery", patterns.authLibraryApi),
    ).toEqual([]);
  });

  it("keeps server authorization, repositories, and secrets out of client modules", () => {
    const clientFiles = sourceFiles.filter((f) => isClientModule(read(f)));
    expect(clientFiles.length).toBeGreaterThan(0);
    expect(
      scan(
        clientFiles,
        "server module imported by a client module",
        patterns.clientServerImport,
      ),
    ).toEqual([]);
  });

  it("makes no role, admin, or permission decision in pages, components, or the proxy", () => {
    const uiFiles = sourceFiles.filter(
      (f) =>
        f.startsWith("src/app/") ||
        f.startsWith("src/components/") ||
        /^src\/modules\/[a-z-]+\/ui\//.test(f) ||
        f === "src/proxy.ts",
    );
    expect(
      scan(
        uiFiles.filter((f) => f !== "src/app/_security/route-manifest.ts"),
        "role/admin/permission check in UI",
        patterns.roleCheck,
      ),
    ).toEqual([]);
    expect(
      scan(
        ["src/proxy.ts"],
        "identity/authorization in proxy",
        /from\s+["']@\/modules\//,
      ),
    ).toEqual([]);
  });

  it("routes every redirect through the registered-destination helper", () => {
    expect(
      scan(
        sourceFiles.filter(
          (f) =>
            f !== "src/modules/identity-access/delivery/route-authorization.ts",
        ),
        "raw redirect",
        patterns.rawRedirect,
      ),
    ).toEqual([]);
  });

  it("never imports local/test adapters into production code", () => {
    const defining: Record<string, string> = {
      SyntheticScopeResolver:
        "src/modules/identity-access/infrastructure/scope-resolvers.ts",
      SyntheticCandidateOwnership:
        "src/modules/identity-access/infrastructure/scope-resolvers.ts",
      NonproductionAssignmentHarness:
        "src/modules/identity-access/infrastructure/assignment-harness.ts",
      NonproductionHarnessGate:
        "src/modules/identity-access/infrastructure/staff-administration-gate.ts",
      InMemoryEmailCapture:
        "src/modules/identity-access/infrastructure/auth-email.ts",
    };
    const problems: string[] = [];
    for (const [name, home] of Object.entries(defining)) {
      for (const file of sourceFiles) {
        if (
          file !== home &&
          new RegExp(`\\b${name}\\b`).test(codeLines(read(file)).join("\n"))
        ) {
          problems.push(`${file}: ${name}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(
      scan(sourceFiles, "test fixture import", /from\s+["'][^"']*tests\//),
    ).toEqual([]);
  });

  it("never renders stored or request content as raw HTML (M2.1 content safety)", () => {
    expect(
      scan(
        sourceFiles,
        "raw HTML rendering",
        /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/,
      ),
    ).toEqual([]);
  });

  it("never spreads persistence, auth, or provider records into responses", () => {
    const layers = sourceFiles.filter(
      (f) =>
        f.startsWith("src/app/") ||
        /^src\/modules\/[a-z-]+\/(?:application|presentation|delivery|ui)\//.test(
          f,
        ),
    );
    expect(scan(layers, "record spread", patterns.recordSpread)).toEqual([]);
  });

  it("keeps secret retrieval paths unreachable", () => {
    expect(
      scan(sourceFiles, "secret retrieval", patterns.secretRetrieval),
    ).toEqual([]);
    // Backup codes appear only on the two reviewed one-time display paths.
    const holders = sourceFiles.filter((f) =>
      /\bbackupCodes\b/.test(codeLines(read(f)).join("\n")),
    );
    expect(holders).toEqual([
      "src/app/(public)/staff/staff-auth-actions.ts",
      "src/app/(staff)/staff/(account)/security/actions.ts",
      "src/modules/identity-access/application/activate-staff-account.ts",
      "src/modules/identity-access/application/manage-staff-security.ts",
      // Better Auth's encrypted two-factor storage column (never selected).
      "src/modules/identity-access/infrastructure/auth-schema.ts",
      "src/modules/identity-access/presentation/field-policy.ts",
      "src/modules/identity-access/ui/staff-auth-forms.tsx",
      "src/modules/identity-access/ui/staff-form-state.ts",
    ]);
  });

  it("adds no generic CRUD, GraphQL, or catch-all business endpoint", () => {
    const routes = listFiles("src/app").filter((f) => /\/route\.tsx?$/.test(f));
    expect(routes).toEqual(["src/app/api/auth/[...all]/route.ts"]);
    expect(listFiles("src").filter((f) => /graphql/i.test(f))).toEqual([]);
  });
});

describe("the static checks detect violations (self-check)", () => {
  it.each([
    ["persistenceImport", 'import { db } from "@/shared/database";'],
    [
      "persistenceImport",
      'import { user } from "@/modules/identity-access/infrastructure/auth-schema";',
    ],
    ["authLibraryApi", "await auth.api.getSession({ headers });"],
    [
      "clientServerImport",
      'import { authorize } from "@/modules/identity-access";',
    ],
    [
      "clientServerImport",
      'import { x } from "@/modules/identity-access/application/authorize";',
    ],
    ["roleCheck", 'if (user.role === "SYSTEM_ADMINISTRATOR") show();'],
    ["roleCheck", "const isAdmin = true;"],
    ["rawRedirect", "redirect(searchParams.next);"],
    ["recordSpread", "return { ...row, masked: true };"],
    ["recordSpread", "props={{ ...session }}"],
    ["staticRendering", 'export const dynamic = "force-static";'],
    ["secretRetrieval", "await auth.api.viewBackupCodes({ body });"],
  ] as const)("%s flags a violation", (name, line) => {
    expect(patterns[name].test(codeLines(line)[0])).toBe(true);
  });

  it.each([
    [
      "persistenceImport",
      'import { safeRedirect } from "@/modules/identity-access/delivery/route-authorization";',
    ],
    [
      "clientServerImport",
      'import { FormField } from "@/modules/identity-access/ui/form-fields";',
    ],
    ["rawRedirect", 'safeRedirect("/sign-in");'],
    ["recordSpread", "return { ...signedOut, count };"],
  ] as const)("%s allows reviewed safe code", (name, line) => {
    expect(patterns[name].test(codeLines(line)[0])).toBe(false);
  });

  it("ignores comments but honors only a reasoned same-line suppression", () => {
    expect(codeLines("/* redirect(x) */ const a = 1;")[0]).not.toMatch(
      /redirect/,
    );
    expect(codeLines("const a = 1; // redirect(x)")[0]).not.toMatch(/redirect/);
    expect(
      isSuppressed("x // authz-boundary-allow: reviewed in ADR-0011"),
    ).toBe(true);
    expect(isSuppressed("x // authz-boundary-allow:")).toBe(false);
  });

  it("reports an unclassified entry point when the manifest lacks it", () => {
    const partial = new Set(routeManifest.slice(1).map(entryKey));
    const missing = discoverEntries().filter((e) => !partial.has(entryKey(e)));
    expect(missing.map(entryKey)).toEqual([entryKey(routeManifest[0])]);
  });
});

describe("local/test harnesses in production-like configuration", () => {
  const run = promisify(execFile);
  const harnesses = routeManifest.filter((e) => e.kind === "LOCAL_HARNESS");

  it.each(harnesses.map((h) => [h.id, h.file] as const))(
    "%s refuses to run with APP_ENV=production",
    async (_id, file) => {
      const text = read(file);
      expect(text).toMatch(/process\.env\.APP_ENV/);
      const outcome = await run(
        path.join(projectRoot, "node_modules/.bin/tsx"),
        ["--conditions=react-server", file, "test.harness@example.test"],
        {
          cwd: projectRoot,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            APP_ENV: "production",
            NODE_ENV: "production",
          },
          timeout: 60_000,
        },
      ).then(
        () => ({ code: 0, output: "" }),
        (error: { code?: number; stderr?: string; stdout?: string }) => ({
          code: error.code ?? 1,
          output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
        }),
      );
      expect(outcome.code).not.toBe(0);
      expect(outcome.output).toMatch(/runs only (?:when APP_ENV|for local)/);
    },
    90_000,
  );
});
