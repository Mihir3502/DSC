import "server-only";
import {
  evaluateAssurance,
  isReauthenticationPurpose,
  reauthenticationDestination,
  type AssuranceDecision,
  type AssurancePolicy,
  type ReauthenticationPurpose,
} from "../domain/authentication-assurance";
import {
  claimTotpCode,
  readSessionAssurance,
  recordReauthentication,
} from "../infrastructure/better-auth-mfa-adapter";
import { formString } from "./candidate-auth-support";
import { resolveCurrentAccount, type Principal } from "./current-account";
import {
  defaultStaffDependencies,
  normalizeTotpCode,
  staffAuthHeaders,
  type StaffAuthDependencies,
} from "./staff-auth-support";

// Recent-authentication primitive for staff (packet M1.3 §13, AC-M1.3-09).
//
// evaluateStaffAssurance is what later commands call: it loads server-owned
// evidence for the caller's own session and applies a named policy. It
// never reads a client-submitted time, method, or flag.
//
// reauthenticateStaff verifies the current password and a TOTP code
// (backup codes are not accepted here) through Better Auth, then records
// purpose-bound evidence on the current session without extending it.

/** The current principal only when it is an MFA-complete staff session. */
export async function resolveCurrentStaff(
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<Principal | null> {
  const principal = await resolveCurrentAccount(headers, deps);
  return principal?.accountType === "STAFF" ? principal : null;
}

export async function evaluateStaffAssurance(
  principal: Principal,
  policy: AssurancePolicy,
  options: Readonly<{ purpose?: ReauthenticationPurpose; now?: Date }> = {},
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<AssuranceDecision> {
  const evidence = await readSessionAssurance(
    deps.db,
    principal.accountId,
    principal.sessionId,
  );
  return evaluateAssurance(evidence, {
    policy,
    accountId: principal.accountId,
    sessionId: principal.sessionId,
    purpose: options.purpose,
    now: options.now ?? new Date(),
    recentWindowSeconds: deps.env.AUTH_STAFF_RECENT_AUTH_SECONDS,
  });
}

export type ReauthenticateResult =
  | Readonly<{ kind: "REAUTHENTICATED"; destination: string }>
  /** One generic failure for a wrong password or code. */
  | Readonly<{ kind: "INVALID" }>
  | Readonly<{ kind: "RATE_LIMITED" }>
  | Readonly<{ kind: "UNAUTHENTICATED" }>;

/**
 * Verifies password + TOTP for the signed-in staff member and records
 * reauthentication evidence bound to this session, account, and purpose.
 * Exported for the inline backup-code regeneration step as well.
 */
export async function verifyStaffStepUp(
  principal: Principal,
  input: Readonly<{ password: unknown; code: unknown }>,
  purpose: ReauthenticationPurpose,
  headers: Headers,
  deps: StaffAuthDependencies,
): Promise<"OK" | "INVALID" | "RATE_LIMITED"> {
  if (!deps.limiter.consume("staffReauthPerAccount", principal.accountId)) {
    deps.events.record({
      code: "auth.rate_limited",
      category: "rate_limited",
      accountRef: principal.accountId,
    });
    return "RATE_LIMITED";
  }
  const fail = (
    category: "invalid_credentials" | "invalid_code" | "replayed",
  ) => {
    deps.events.record({
      code: "staff.reauth_failed",
      category,
      accountRef: principal.accountId,
    });
    return "INVALID" as const;
  };
  const password = formString(input.password, 4096);
  const code = normalizeTotpCode(input.code);
  const authHeaders = staffAuthHeaders(deps, headers);
  const passwordCheck = password
    ? await deps.auth.api.verifyPassword({
        body: { password },
        headers: authHeaders,
        asResponse: true,
      })
    : null;
  if (!passwordCheck?.ok) return fail("invalid_credentials");
  if (!code) return fail("invalid_code");
  if (
    !(await claimTotpCode(
      deps.db,
      deps.env.BETTER_AUTH_SECRET,
      principal.accountId,
      code,
    ))
  ) {
    return fail("replayed");
  }
  const totp = await deps.auth.api.verifyTOTP({
    body: { code },
    headers: authHeaders,
    asResponse: true,
  });
  if (!totp.ok) return fail("invalid_code");
  const recorded = await recordReauthentication(
    deps.db,
    principal.accountId,
    principal.sessionId,
    purpose,
    new Date(),
  );
  if (!recorded) return fail("invalid_credentials");
  deps.events.record({
    code: "staff.reauth_succeeded",
    accountRef: principal.accountId,
  });
  return "OK";
}

export async function reauthenticateStaff(
  input: Readonly<{ password: unknown; code: unknown; purpose: unknown }>,
  headers: Headers,
  deps: StaffAuthDependencies = defaultStaffDependencies(),
): Promise<ReauthenticateResult> {
  const principal = await resolveCurrentStaff(headers, deps);
  if (!principal) return { kind: "UNAUTHENTICATED" };
  // Closed purpose registry; anything else (URLs, actions, the inline-only
  // backup-code purpose) falls back to the general security purpose.
  const purpose: ReauthenticationPurpose =
    isReauthenticationPurpose(input.purpose) &&
    input.purpose !== "REGENERATE_BACKUP_CODES"
      ? input.purpose
      : "STAFF_SECURITY";
  const outcome = await verifyStaffStepUp(
    principal,
    input,
    purpose,
    headers,
    deps,
  );
  if (outcome === "RATE_LIMITED") return { kind: "RATE_LIMITED" };
  if (outcome === "INVALID") return { kind: "INVALID" };
  return {
    kind: "REAUTHENTICATED",
    destination: reauthenticationDestination(purpose),
  };
}
