import {
  routeManifest,
  type ManifestEntry,
} from "@/app/_security/route-manifest";
import { eventCatalog } from "@/modules/audit/application/event-catalog";
import {
  roleCodes,
  scopeTypes,
  type RoleCode,
} from "@/modules/identity-access/domain/authorization-vocabulary";
import { allowedScopeTypesByRole } from "@/modules/identity-access/domain/role-assignment";
import { selfServicePolicies } from "@/modules/identity-access/domain/self-service-policy";
import { fieldOutcomes } from "@/modules/identity-access/presentation/field-policy";
import { permissionCatalog } from "@/modules/identity-access/policy/permission-catalog";
import { grantCatalog } from "@/modules/identity-access/policy/role-permission-catalog";

// The machine-readable M1.7 authorization matrix (packet M1.7 §7). Every
// row is GENERATED from the accepted executable catalogs (role, permission,
// grant, scope, self-service, route manifest, field outcomes, event
// catalog); none is parsed from prose. tests/authorization/
// m1-matrix-coverage.test.ts fails CI when a row lacks coverage, a test
// reference is missing/renamed, or the catalog drifts from
// approved-grants.json without an approved change.

export type TestRef = Readonly<{ file: string; title: string }>;
export type TestLevel =
  | "policy"
  | "application"
  | "integration"
  | "http-action"
  | "component"
  | "e2e";

const ref = (file: string, title: string): TestRef => ({ file, title });

// ---------------------------------------------------------- role × permission

export type PairRow = Readonly<{
  id: string;
  role: RoleCode;
  permission: string;
  granted: boolean;
  condition: string | null;
  scopeTypes: readonly string[];
  operation: string;
  maxSensitivity: string;
  domain: string;
  workflowPolicy: string | null;
  separationPolicy: string | null;
  dualControlHook: string | null;
  recentAuth: string | null;
  requiresReason: boolean;
  /** Expected external decision with every other fact valid. */
  expected: "ALLOW" | "DENY:PERMISSION_MISSING";
  /** Required denial evidence when the pair is refused for a high-risk permission. */
  denialEvent: "authz.high_risk_denied" | null;
  levels: readonly TestLevel[];
  refs: readonly string[];
}>;

const grants = new Map(
  grantCatalog
    .filter((g) => g.status === "ACTIVE")
    .map((g) => [`${g.roleCode}|${g.permissionCode}`, g]),
);

export const pairRows: readonly PairRow[] = Object.freeze(
  roleCodes.flatMap((role) =>
    permissionCatalog.map((p) => {
      const grant = grants.get(`${role}|${p.code}`);
      return Object.freeze({
        id: `pair:${role}:${p.code}`,
        role,
        permission: p.code,
        granted: grant !== undefined,
        condition: grant?.condition ? grant.condition.kind : null,
        scopeTypes: grant ? allowedScopeTypesByRole[role] : [],
        operation: p.operation,
        maxSensitivity: p.maxSensitivity,
        domain: p.domain,
        workflowPolicy: p.workflowPolicy,
        separationPolicy: p.separationPolicy,
        dualControlHook: p.dualControlHook,
        recentAuth: p.recentAuth
          ? `${p.recentAuth.policy}:${p.recentAuth.purpose ?? "-"}`
          : null,
        requiresReason: p.requiresReason,
        expected: grant ? "ALLOW" : "DENY:PERMISSION_MISSING",
        denialEvent: !grant && p.highRisk ? "authz.high_risk_denied" : null,
        levels: ["policy"],
        refs: [...p.matrixRefs],
      } satisfies PairRow);
    }),
  ),
);

// ------------------------------------------------------------- scope matrix

export const scopeConditions = [
  "inside",
  "outside",
  "missing",
  "inactive",
  "expired",
  "malformed",
  "wrong-type",
  "cross-organization",
] as const;

export const scopeRows = Object.freeze(
  scopeTypes.flatMap((type) =>
    scopeConditions.map((condition) => ({
      id: `scope:${type}:${condition}`,
      type,
      condition,
    })),
  ),
);

// ------------------------------------------------------ self-service policy

export const selfServiceRows = Object.freeze(
  selfServicePolicies.map((p) => ({
    id: `self:${p.code}`,
    policy: p.code,
    audience: p.audience,
    operation: p.operation,
    recentAuth: p.recentAuth,
    highRisk: p.highRisk,
  })),
);

// ----------------------------------------------------- field / projection

export const fieldRows = Object.freeze(
  fieldOutcomes.map((outcome) => ({ id: `field:${outcome}`, outcome })),
);

// ---------------------------------------------------- route / action rows

export const routeScenarios = [
  "classified",
  "public-or-authenticated",
  "wrong-principal",
  "inactive-or-stale",
  "direct-invocation",
  "unsupported-method",
  "csrf-origin",
  "exact-input",
  "safe-redirect",
  "private-cache",
  "step-up",
  "audit-evidence",
  "production-refusal",
] as const;
export type RouteScenario = (typeof routeScenarios)[number];

/** Which scenarios each manifest entry must be covered for (packet §16). */
export function requiredScenarios(entry: ManifestEntry): RouteScenario[] {
  const s: RouteScenario[] = ["classified"];
  if (entry.kind === "LOCAL_HARNESS") return [...s, "production-refusal"];
  if (
    ["PAGE", "LAYOUT", "SERVER_ACTION", "ROUTE_HANDLER"].includes(entry.kind)
  ) {
    s.push("public-or-authenticated", "direct-invocation");
  }
  if (entry.audience === "CANDIDATE" || entry.audience === "STAFF") {
    s.push("wrong-principal", "inactive-or-stale");
  }
  if (entry.kind === "ROUTE_HANDLER") s.push("unsupported-method");
  if (entry.kind === "SERVER_ACTION") s.push("csrf-origin", "exact-input");
  if (
    entry.output === "REDIRECT_ONLY" ||
    entry.route === "/sign-in" ||
    entry.route === "/staff/reauthenticate"
  ) {
    s.push("safe-redirect");
  }
  if (entry.cache === "PRIVATE_NO_STORE" && entry.kind !== "SERVER_ACTION") {
    s.push("private-cache");
  }
  if (entry.recentAuth !== "NONE") s.push("step-up");
  if (entry.futureAudit !== "NONE") s.push("audit-evidence");
  return s;
}

const E2E_ROUTE = "tests/e2e/route-field-authorization.spec.ts";
const E2E_GATE = "tests/e2e/authorization/m1-gate.spec.ts";
const GUARD = "tests/guards/authorization-boundaries.test.ts";
const ROF = "tests/integration/authorization/route-object-field.test.ts";

/** Tests that prove each scenario, for every entry that requires it. */
export const scenarioCoverage: Readonly<
  Record<RouteScenario, readonly TestRef[]>
> = {
  classified: [
    ref(GUARD, "classifies every server entry point found in the source tree"),
    ref(GUARD, "has no stale, duplicate, or mis-kinded entries"),
  ],
  "public-or-authenticated": [
    ref(
      GUARD,
      "binds every protected entry to the application authorization boundary",
    ),
    ref(
      E2E_ROUTE,
      "anonymous direct requests to protected pages go to the right sign-in, privately",
    ),
  ],
  "wrong-principal": [
    ref(ROF, "keeps candidates out of every staff query and command"),
    ref(ROF, "keeps staff out of every candidate query and command"),
    ref(
      E2E_GATE,
      "staff routes refuse candidate, service, and password-only principals",
    ),
  ],
  "inactive-or-stale": [
    ref(
      ROF,
      "rejects anonymous, restricted, and stale principals on the next call",
    ),
    ref(
      "tests/integration/authentication/account-state.matrix.test.ts",
      "resolves a principal only for eligible account, MFA, and session states",
    ),
  ],
  "direct-invocation": [
    ref(
      E2E_ROUTE,
      "anonymous direct requests to protected pages go to the right sign-in, privately",
    ),
    ref(E2E_ROUTE, "an unknown route and a hidden route look the same"),
  ],
  "unsupported-method": [
    ref(
      E2E_GATE,
      "refuses unsupported methods on the auth surface and protected pages",
    ),
    ref(
      GUARD,
      "requires origin-checked POST for every state change and no state change on GET",
    ),
  ],
  "csrf-origin": [
    ref(
      E2E_GATE,
      "refuses a cross-origin submission for every server action page",
    ),
    ref(
      GUARD,
      "requires origin-checked POST for every state change and no state change on GET",
    ),
  ],
  "exact-input": [
    ref(
      GUARD,
      "gives every Server Action an exact reviewed input schema it actually parses",
    ),
    ref(
      E2E_ROUTE,
      "injected server-owned fields reject the whole submission with no state change",
    ),
  ],
  "safe-redirect": [
    ref(
      GUARD,
      "routes every redirect through the registered-destination helper",
    ),
    ref(
      E2E_ROUTE,
      "malicious continuation values never reach the page or the redirect",
    ),
  ],
  "private-cache": [
    ref(
      GUARD,
      "marks every personal, capability, or protected route private/no-store and dynamic",
    ),
    ref("src/proxy.test.ts", "marks protected path %s private no-store"),
  ],
  "step-up": [
    ref(
      ROF,
      "re-runs the whole decision after reauthentication (no cached allow)",
    ),
    ref(
      "tests/integration/auth/staff-authentication.test.ts",
      "requires recent auth for password change, then ends every session",
    ),
  ],
  "audit-evidence": [
    ref(
      "tests/integration/audit/event-coverage.test.ts",
      "records exactly one classified event",
    ),
  ],
  "production-refusal": [ref(GUARD, "refuses to run with APP_ENV=production")],
};

export const routeRows = Object.freeze(
  routeManifest.map((entry) => ({
    id: `route:${entry.id}`,
    entry,
    scenarios: requiredScenarios(entry),
  })),
);

// -------------------------------------------------------------- event rows

export const eventRows = Object.freeze(
  eventCatalog.map((d) => ({
    id: `event:${d.name}@${d.version}`,
    name: d.name,
    stream: d.stream,
    atomicity: d.atomicity,
  })),
);

// ------------------------------------------------------------ section map

/** Packet sections to the matrix suites that execute them. */
export const sectionSuites: Readonly<Record<string, readonly TestRef[]>> = {
  "§9 authentication": [
    ref(
      "tests/integration/authentication/account-state.matrix.test.ts",
      "resolves a principal only for eligible account, MFA, and session states",
    ),
  ],
  "§10 role-permission": [
    ref("tests/authorization/role-permission.matrix.test.ts", "%s"),
  ],
  "§11 scope": [ref("tests/authorization/scope.matrix.test.ts", "%s")],
  "§12 cross-record": [
    ref(
      "tests/authorization/candidate-cross-record.matrix.test.ts",
      "Candidate A",
    ),
  ],
  "§13 field": [
    ref("tests/authorization/field.matrix.test.ts", "field outcome"),
  ],
  "§14-15 state and separation": [
    ref(
      "tests/authorization/state-separation-recent-auth.matrix.test.ts",
      "workflow state",
    ),
    ref(
      "tests/authorization/state-separation-recent-auth.matrix.test.ts",
      "separation rule",
    ),
  ],
  "§9.4 recent auth": [
    ref(
      "tests/authorization/state-separation-recent-auth.matrix.test.ts",
      "recent authentication",
    ),
  ],
  "§18 revocation": [
    ref(
      "tests/integration/authorization/revocation.matrix.test.ts",
      "revocation",
    ),
  ],
  "§19 administrator/auditor": [
    ref("tests/authorization/admin-auditor.matrix.test.ts", "administrator"),
    ref("tests/authorization/admin-auditor.matrix.test.ts", "auditor"),
  ],
  "§20 leakage": [
    ref("tests/security/production-configuration.test.ts", "refuses"),
  ],
  "§22 decision branches": [
    ref(
      "tests/authorization/decision-branches.matrix.test.ts",
      "denies a query request with %s as invalid context",
    ),
    ref(
      "tests/authorization/decision-branches.matrix.test.ts",
      "ignores a stored grant row that the reviewed manifest does not contain",
    ),
    ref(
      "tests/authorization/decision-branches-catalog-drift.test.ts",
      "denies a permission whose definition is no longer active",
    ),
    ref(
      "tests/integration/authorization/route-object-field.test.ts",
      "drops and counts an out-of-scope row a defective repository returns",
    ),
  ],
};

// -------------------------------------------------------- revocation rows

const RV = "tests/integration/authorization/revocation.matrix.test.ts";
const CONC = "tests/integration/authorization/concurrency.test.ts";
const SVC = "tests/integration/authorization/authorization-service.test.ts";

/** Packet §18 rows → the deterministic test that proves each. */
export const revocationRows: Readonly<Record<string, readonly TestRef[]>> = {
  "account disable during a protected read/action": [
    ref(RV, "revocation: an account disabled while a protected command waits"),
    ref(ROF, "rechecks at the command transaction boundary"),
  ],
  "role revocation during authorization/command commit": [
    ref(
      CONC,
      "serializes revocation behind a protected command that authorized first",
    ),
    ref(
      CONC,
      "never commits on authority revoked before the protected boundary",
    ),
  ],
  "assignment expiry exactly at the controlled boundary": [
    ref(
      SVC,
      "expires exactly at the exclusive effective_to boundary on the server clock",
    ),
  ],
  "scope supersession during a query/action": [
    ref(
      RV,
      "revocation: scope supersession takes effect on the very next query",
    ),
  ],
  "session revocation during a second request": [
    ref(
      RV,
      "revocation: a session revoked by another request has no authority",
    ),
  ],
  "password reset/MFA reset while other sessions/challenges exist": [
    ref(
      RV,
      "revocation: a password change ends every other session and any pending MFA challenge",
    ),
    ref(
      "tests/integration/auth/candidate-registration.test.ts",
      "resets once, revokes every session",
    ),
    ref(
      "tests/integration/auth/staff-authentication.test.ts",
      "enforces separation of duties and completes with full reset effects",
    ),
  ],
  "invitation acceptance concurrently/replayed": [
    ref(
      "tests/integration/auth/staff-authentication.test.ts",
      "one account and one activation",
    ),
  ],
  "backup code concurrently/replayed": [
    ref(
      RV,
      "revocation: one backup code replayed concurrently yields exactly one session",
    ),
  ],
  "duplicate role grant/approval": [
    ref(
      CONC,
      "lets exactly one of two concurrent approvals activate an assignment",
    ),
    ref(CONC, "lets at most one of two concurrent equivalent proposals exist"),
  ],
  "same-chain audit appends and forced audit failure": [
    ref(
      "tests/integration/audit/persistence.test.ts",
      "serializes same-partition appends into a contiguous chain without forks",
    ),
    ref(
      "tests/integration/audit/persistence.test.ts",
      "rolls the mutation back when audit validation, integrity, or append fails",
    ),
  ],
  "reauthentication followed by privilege/resource change": [
    ref(
      ROF,
      "re-runs the whole decision after reauthentication (no cached allow)",
    ),
    ref(
      "tests/authorization/state-separation-recent-auth.matrix.test.ts",
      "recent authentication followed by a role or account change reauthorizes completely",
    ),
  ],
};
