import {
  isSensitivityLevel,
  type SensitivityLevel,
} from "../domain/authorization-vocabulary";

// Typed field-level authorization (packet M1.5 §12, ADR-0011). Pure.
//
// Every field of a response contract declares a rule. The outcome for one
// request depends only on server-owned facts: the audience of the
// principal, the projection purpose, and the set of permissions the M1.4
// service ALLOWED for this exact resource and purpose (computed by
// application/authorize-fields.ts). Request input never selects fields,
// outcomes, permissions, or projections.
//
//   INCLUDE        the approved value
//   MASK           a server-generated, nonreversible representation
//   STATUS_ONLY    an approved state/summary, never the underlying value
//   OMIT           the key is absent from the response
//   DENY_RESOURCE  the whole representation is refused
//
// Unknown or malformed rules never include: they deny the resource.

export const fieldOutcomes = [
  "INCLUDE",
  "MASK",
  "STATUS_ONLY",
  "OMIT",
  "DENY_RESOURCE",
] as const;
export type FieldOutcome = (typeof fieldOutcomes)[number];

export const projectionAudiences = ["CANDIDATE", "STAFF", "SERVICE"] as const;
export type ProjectionAudience = (typeof projectionAudiences)[number];

export const projectionPurposes = [
  "LIST",
  "DETAIL",
  "EDIT",
  "REVIEW",
  "STATUS",
  "SECURITY",
] as const;
export type ProjectionPurpose = (typeof projectionPurposes)[number];

export type FieldRule = Readonly<{
  /** Classification of the full value. */
  sensitivity: SensitivityLevel;
  /**
   * Classification of the masked / status representations, when lower than
   * the full value (matrix R3: a status read is INTERNAL, never content).
   * Defaults: masked = `sensitivity`; status = INTERNAL.
   */
  maskedSensitivity?: SensitivityLevel;
  statusSensitivity?: SensitivityLevel;
  /**
   * The full value is returned only when this permission was ALLOWED for
   * the resource. Absent: the field has no full-value path.
   */
  includeWith?: string;
  /** The masked form is returned when this permission was ALLOWED. */
  maskWith?: string;
  /** The status form is returned when this permission was ALLOWED. */
  statusWith?: string;
  /** What happens when no permission above was allowed. */
  otherwise: FieldOutcome;
}>;

export type FieldPolicyContext = Readonly<{
  audience: ProjectionAudience;
  purpose: ProjectionPurpose;
  /** Permission codes the M1.4 service allowed for this resource. */
  allowed: ReadonlySet<string>;
}>;

const restricted: readonly SensitivityLevel[] = [
  "RESTRICTED_IDENTITY_FINANCIAL",
  "RESTRICTED_SCREENING_MEDICAL",
  "SECURITY_AUDIT_RESTRICTED",
];

export function isRestrictedSensitivity(level: SensitivityLevel): boolean {
  return restricted.includes(level);
}

/**
 * Structural validation of a rule. Restricted data can never be included
 * without an explicit permission, and a rule must use known vocabulary.
 */
export function isValidFieldRule(rule: unknown): rule is FieldRule {
  if (typeof rule !== "object" || rule === null) return false;
  const r = rule as Record<string, unknown>;
  const allowedKeys = new Set([
    "sensitivity",
    "maskedSensitivity",
    "statusSensitivity",
    "includeWith",
    "maskWith",
    "statusWith",
    "otherwise",
  ]);
  if (!Object.keys(r).every((k) => allowedKeys.has(k))) return false;
  if (!isSensitivityLevel(r.sensitivity)) return false;
  for (const key of ["maskedSensitivity", "statusSensitivity"] as const) {
    if (r[key] !== undefined && !isSensitivityLevel(r[key])) return false;
  }
  if (!(fieldOutcomes as readonly unknown[]).includes(r.otherwise)) {
    return false;
  }
  for (const key of ["includeWith", "maskWith", "statusWith"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string") return false;
  }
  if (
    r.otherwise === "INCLUDE" &&
    isRestrictedSensitivity(r.sensitivity as SensitivityLevel)
  ) {
    return false;
  }
  return true;
}

/** Decides one field's outcome; malformed rules deny the resource. */
export function evaluateFieldRule(
  rule: unknown,
  context: FieldPolicyContext,
): FieldOutcome {
  if (!isValidFieldRule(rule)) return "DENY_RESOURCE";
  if (rule.includeWith && context.allowed.has(rule.includeWith)) {
    return "INCLUDE";
  }
  if (rule.maskWith && context.allowed.has(rule.maskWith)) return "MASK";
  if (rule.statusWith && context.allowed.has(rule.statusWith)) {
    return "STATUS_ONLY";
  }
  return rule.otherwise;
}

/**
 * The classification at which a permission is evaluated for a rule: the
 * classification of the representation that permission unlocks.
 */
export function sensitivityForPermission(
  rule: FieldRule,
  permission: string,
): SensitivityLevel | null {
  if (rule.includeWith === permission) return rule.sensitivity;
  if (rule.maskWith === permission) {
    return rule.maskedSensitivity ?? rule.sensitivity;
  }
  if (rule.statusWith === permission) {
    return rule.statusSensitivity ?? "INTERNAL";
  }
  return null;
}

/** The distinct permissions a set of rules may consult. */
export function permissionsReferenced(
  rules: readonly FieldRule[],
): readonly string[] {
  const codes = new Set<string>();
  for (const rule of rules) {
    for (const code of [rule.includeWith, rule.maskWith, rule.statusWith]) {
      if (code) codes.add(code);
    }
  }
  return [...codes].sort();
}

/**
 * Keys that ordinary application responses never contain, for any role
 * (packet §12.3). The projector refuses an output carrying any of them at
 * any depth, and no rule can make them includable. The only sanctioned
 * secret display is the one-time enrollment/regeneration result of M1.3,
 * which never passes through a projection contract.
 */
export const neverReturnKeys: readonly string[] = Object.freeze([
  "password",
  "passwordHash",
  "hash",
  "salt",
  "token",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "idToken",
  "verificationToken",
  "resetToken",
  "invitationToken",
  "capability",
  "secret",
  "totpSecret",
  "twoFactorSecret",
  "mfaSecret",
  "backupCodes",
  "recoveryCodes",
  "encryptionKey",
  "blindIndex",
  "storageKey",
  "objectUrl",
  "signedUrl",
  "providerCredential",
  "apiKey",
  "cookie",
  "authorization",
  "ipAddress",
  "userAgent",
  "sessionId",
  "accountId",
  "userId",
  "assignmentId",
  "effectiveAssignmentId",
  "scopeReferenceId",
  "effectiveScopeReferenceId",
  "reasonReference",
  "condition",
  "policyContext",
  "stack",
  "sql",
  "cause",
]);

const neverReturn = new Set(neverReturnKeys.map((k) => k.toLowerCase()));

/** Every never-return key found at any depth (names only, never values). */
export function findNeverReturnKeys(value: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (v: unknown) => {
    if (typeof v !== "object" || v === null || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Date) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(v)) {
      if (neverReturn.has(key.toLowerCase())) found.add(key);
      visit(child);
    }
  };
  visit(value);
  return [...found].sort();
}
