import type { AccountStatus, AccountType } from "./account-types";
import {
  evaluateAssurance,
  type AssuranceEvidence,
  type AssurancePolicy,
  type ReauthenticationPurpose,
} from "./authentication-assurance";
import type { DenialReason } from "./authorization-vocabulary";

// Account self-service authorization (packet M1.5 §7.1, §11, ADR-0011).
// Pure and framework-neutral.
//
// A principal's own account security (masked account summary, own
// sessions, own password, own MFA backup codes, own reauthentication) is
// not a business resource and is not in the M1.4 permission catalog.
// Candidates hold no staff assignment, and their catalog grants deny until
// M2 ownership exists; staff may hold no role at all. These operations are
// therefore governed by this closed registry of narrow self-service
// policies, whose subject is always the server-resolved principal's own
// account. A policy never names another account, a resource ID, a role, a
// scope, or a field selection, so it cannot widen any catalog authority.
//
// The decision is made from the same current server-owned facts the M1.4
// service reads (account type/status re-read, session assurance, the
// account version) on every call; nothing comes from the browser.

export const SELF_SERVICE_POLICY_VERSION = "self-p1";

export type SelfServiceAudience = Extract<AccountType, "CANDIDATE" | "STAFF">;

/** How a missing recent authentication is satisfied. */
export type StepUp =
  /** Redirect to the allowlisted reauthentication page for this key. */
  | Readonly<{ kind: "PAGE"; purpose: "CHANGE_PASSWORD" | "STAFF_SECURITY" }>
  /** The command performs a bound inline step-up, then re-authorizes. */
  | Readonly<{ kind: "INLINE" }>;

export type SelfServicePolicyDefinition = Readonly<{
  code: string;
  audience: SelfServiceAudience;
  operation: "READ" | "EDIT";
  description: string;
  /** Candidate policies require a verified email (M1.2 rule). */
  requiresVerifiedEmail: boolean;
  recentAuth: Readonly<{
    policy: Exclude<AssurancePolicy, "NORMAL_STAFF_SESSION">;
    purpose?: ReauthenticationPurpose;
    stepUp: StepUp;
  }> | null;
  /** Security-relevant change: allow/deny context is future-audit-ready. */
  highRisk: boolean;
}>;

function policy(
  code: string,
  audience: SelfServiceAudience,
  operation: "READ" | "EDIT",
  description: string,
  options: Partial<
    Pick<SelfServicePolicyDefinition, "recentAuth" | "highRisk">
  > = {},
): SelfServicePolicyDefinition {
  return Object.freeze({
    code,
    audience,
    operation,
    description,
    requiresVerifiedEmail: audience === "CANDIDATE",
    recentAuth: options.recentAuth ?? null,
    highRisk: options.highRisk ?? operation === "EDIT",
  });
}

/** The reviewed registry. Codes are stable; never derived from input. */
export const selfServicePolicies: readonly SelfServicePolicyDefinition[] =
  Object.freeze([
    policy(
      "CANDIDATE_SECURITY_READ",
      "CANDIDATE",
      "READ",
      "Read own masked account security summary and own sessions",
    ),
    policy(
      "CANDIDATE_SESSION_REVOKE",
      "CANDIDATE",
      "EDIT",
      "Sign out one own session by opaque reference",
    ),
    policy(
      "CANDIDATE_SESSIONS_REVOKE_OTHERS",
      "CANDIDATE",
      "EDIT",
      "Sign out every own session except this one",
    ),
    policy(
      "CANDIDATE_SESSIONS_END_ALL",
      "CANDIDATE",
      "EDIT",
      "Sign out every own session",
    ),
    policy(
      "CANDIDATE_PASSWORD_CHANGE",
      "CANDIDATE",
      "EDIT",
      "Change own password with the current password",
    ),
    policy(
      "STAFF_SECURITY_READ",
      "STAFF",
      "READ",
      "Read own masked staff security summary and own sessions",
    ),
    policy(
      "STAFF_SESSION_REVOKE",
      "STAFF",
      "EDIT",
      "Sign out one own session by opaque reference",
    ),
    policy(
      "STAFF_SESSIONS_REVOKE_OTHERS",
      "STAFF",
      "EDIT",
      "Sign out every own session except this one",
    ),
    policy(
      "STAFF_SESSIONS_END_ALL",
      "STAFF",
      "EDIT",
      "Sign out every own session",
    ),
    policy(
      "STAFF_PASSWORD_CHANGE",
      "STAFF",
      "EDIT",
      "Change own password after recent MFA authentication",
      {
        recentAuth: {
          policy: "RECENT_STAFF_AUTH",
          stepUp: { kind: "PAGE", purpose: "CHANGE_PASSWORD" },
        },
      },
    ),
    policy(
      "STAFF_BACKUP_CODES_REGENERATE",
      "STAFF",
      "EDIT",
      "Regenerate own backup codes after an inline password + TOTP step-up",
      {
        recentAuth: {
          policy: "RECENT_STRONG_AUTH",
          purpose: "REGENERATE_BACKUP_CODES",
          stepUp: { kind: "INLINE" },
        },
      },
    ),
    policy(
      "STAFF_REAUTHENTICATE",
      "STAFF",
      "EDIT",
      "Confirm own identity for this session (password + TOTP)",
      { highRisk: false },
    ),
  ]);

export type SelfServicePolicyCode =
  | "CANDIDATE_SECURITY_READ"
  | "CANDIDATE_SESSION_REVOKE"
  | "CANDIDATE_SESSIONS_REVOKE_OTHERS"
  | "CANDIDATE_SESSIONS_END_ALL"
  | "CANDIDATE_PASSWORD_CHANGE"
  | "STAFF_SECURITY_READ"
  | "STAFF_SESSION_REVOKE"
  | "STAFF_SESSIONS_REVOKE_OTHERS"
  | "STAFF_SESSIONS_END_ALL"
  | "STAFF_PASSWORD_CHANGE"
  | "STAFF_BACKUP_CODES_REGENERATE"
  | "STAFF_REAUTHENTICATE";

const byCode = new Map(selfServicePolicies.map((p) => [p.code, p]));

export function findSelfServicePolicy(
  code: unknown,
): SelfServicePolicyDefinition | null {
  return typeof code === "string" ? (byCode.get(code) ?? null) : null;
}

export type SelfServiceAllow = Readonly<{
  decision: "ALLOW";
  policy: SelfServicePolicyCode;
  audience: SelfServiceAudience;
  policyVersion: string;
  reasonCode: "ALLOWED";
}>;

export type SelfServiceDeny = Readonly<{
  decision: "DENY";
  /** The requested code if it is a registry code, otherwise "unknown". */
  policy: string;
  policyVersion: string;
  reasonCode: DenialReason;
  /** Present with RECENT_AUTH_REQUIRED: how the caller may step up. */
  stepUp?: StepUp;
}>;

export type SelfServiceDecision = SelfServiceAllow | SelfServiceDeny;

/** The server-resolved principal (from resolveCurrentAccount). */
export type SelfServicePrincipal = Readonly<{
  accountId: string;
  accountType: string;
  sessionId: string;
}>;

/** Current account facts, re-read for this decision. */
export type SelfServiceAccountFacts = Readonly<{
  id: string;
  accountType: AccountType;
  status: AccountStatus;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}>;

export type SelfServiceInput = Readonly<{
  policy: unknown;
  principal: SelfServicePrincipal | null;
  account: SelfServiceAccountFacts | null;
  /** Server-side evidence of the principal's own session. */
  evidence: AssuranceEvidence | null;
  now: Date;
  recentWindowSeconds: number;
}>;

function deny(
  policyCode: string,
  reasonCode: DenialReason,
  stepUp?: StepUp,
): SelfServiceDeny {
  return Object.freeze({
    decision: "DENY",
    policy: policyCode,
    policyVersion: SELF_SERVICE_POLICY_VERSION,
    reasonCode,
    ...(stepUp ? { stepUp } : {}),
  });
}

/**
 * Deny-by-default evaluation, in the M1.4 order: policy → principal →
 * current account (type, status, verification, MFA) → session validity →
 * recent authentication. The subject is always the principal itself.
 */
export function evaluateSelfService(
  input: SelfServiceInput,
): SelfServiceDecision {
  const definition = findSelfServicePolicy(input.policy);
  if (!definition) return deny("unknown", "PERMISSION_UNKNOWN");
  const code = definition.code;
  const principal = input.principal;
  if (!principal) return deny(code, "UNAUTHENTICATED");

  const account = input.account;
  if (
    !account ||
    account.id !== principal.accountId ||
    account.accountType !== principal.accountType ||
    account.status !== "ACTIVE"
  ) {
    return deny(code, "ACCOUNT_INACTIVE");
  }
  // Wrong audience (candidate on a staff policy, staff or service on a
  // candidate policy). Service accounts never hold interactive policies.
  if (account.accountType !== definition.audience) {
    return deny(code, "PERMISSION_MISSING");
  }
  if (definition.requiresVerifiedEmail && !account.emailVerified) {
    return deny(code, "ACCOUNT_INACTIVE");
  }

  const evidence = input.evidence;
  if (definition.audience === "STAFF") {
    const base = evaluateAssurance(evidence, {
      policy: "NORMAL_STAFF_SESSION",
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      now: input.now,
      recentWindowSeconds: 1,
    });
    if (base.kind !== "ALLOW" || !account.twoFactorEnabled) {
      return deny(code, "UNAUTHENTICATED");
    }
  } else if (
    !evidence ||
    evidence.accountId !== principal.accountId ||
    evidence.sessionId !== principal.sessionId ||
    (evidence.sessionPurpose !== null && evidence.sessionPurpose !== "STANDARD")
  ) {
    return deny(code, "UNAUTHENTICATED");
  }

  if (definition.recentAuth) {
    const assurance = evaluateAssurance(evidence, {
      policy: definition.recentAuth.policy,
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      purpose: definition.recentAuth.purpose,
      now: input.now,
      recentWindowSeconds: input.recentWindowSeconds,
    });
    if (assurance.kind === "CHALLENGE") {
      return deny(code, "RECENT_AUTH_REQUIRED", definition.recentAuth.stepUp);
    }
    if (assurance.kind !== "ALLOW") return deny(code, "UNAUTHENTICATED");
  }

  return Object.freeze({
    decision: "ALLOW",
    policy: code as SelfServicePolicyCode,
    audience: definition.audience,
    policyVersion: SELF_SERVICE_POLICY_VERSION,
    reasonCode: "ALLOWED",
  });
}
