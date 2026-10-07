import {
  dualControlHooks,
  isUuid,
  type DualControlHook,
  type Operation,
  type PermissionDomain,
  type PrincipalType,
  type RoleCode,
  type SeparationPolicyCode,
} from "./authorization-vocabulary";

// Separation-of-duties policy (packet M1.4 §13, ROLE_PERMISSION_MATRIX §9).
// Pure. Rules compare immutable account IDs, never names or role labels
// alone. Facts come from the owning domain on the server (who proposed,
// who entered a result, prior approvers); the subject of a record comes
// from the scope resolver. A named policy whose required facts are absent
// denies.

export type SeparationFacts = Readonly<{
  /** Who proposed/initiated the item being decided. */
  proposerAccountId?: string;
  /** Who entered a restricted screening result. */
  resultEnteredByAccountId?: string;
  /** Who made the compensation/offer change being approved. */
  changedByAccountIds?: readonly string[];
  /** Approvals already recorded for a dual-control decision. */
  priorApproverAccountIds?: readonly string[];
  /** Whether the evaluation being changed has been signed. */
  evaluationSigned?: boolean;
  /** Actors documented by the audit record being changed. */
  documentedActorAccountIds?: readonly string[];
}>;

export type DualControlConfiguration = Readonly<
  Record<DualControlHook, Readonly<{ required: boolean }>>
>;

/**
 * Restrictive default until the agency approves otherwise (matrix §20):
 * every configurable two-person rule is on.
 */
export const restrictiveDualControl: DualControlConfiguration = Object.freeze(
  Object.fromEntries(
    dualControlHooks.map((hook) => [hook, Object.freeze({ required: true })]),
  ) as Record<DualControlHook, { required: boolean }>,
);

export const separationRules = [
  "OWN_RECORD",
  "ADMIN_BUSINESS_DECISION",
  "BREAK_GLASS_ORDINARY_WORKFLOW",
  "CLASSIFICATION_SELF_APPROVAL",
  "CANDIDATE_SELF_VERIFICATION",
  "RESTRICTED_RESULT_ENTRANT",
  "SIGNED_EVALUATION_IMMUTABLE",
  "OFFER_SELF_APPROVAL",
  "READINESS_APPROVAL",
  "AUDIT_SELF_MODIFICATION",
  "EXPORT_APPROVAL",
  "DUAL_CONTROL",
] as const;
export type SeparationRule = (typeof separationRules)[number];

export type SeparationInput = Readonly<{
  actorAccountId: string;
  actorPrincipalType: PrincipalType;
  effectiveRoleCode: RoleCode;
  operation: Operation;
  permissionDomain: PermissionDomain;
  policy: SeparationPolicyCode | null;
  dualControlHook: DualControlHook | null;
  /**
   * Accounts whose own candidacy/worker file the resource is, from the
   * resolver. `null` only for non-record targets (a scope); a record
   * always has a list.
   */
  subjectAccountIds: readonly string[] | null;
  facts: SeparationFacts;
  elevation: "NONE" | "BREAK_GLASS";
  dualControl: DualControlConfiguration;
}>;

export type SeparationResult =
  | Readonly<{ kind: "PASS" }>
  | Readonly<{
      kind: "DENY";
      reason: "SEPARATION_CONFLICT" | "SEPARATION_FACTS_MISSING";
      rule: SeparationRule;
    }>;

export interface SeparationOfDutiesPolicy {
  evaluate(input: SeparationInput): SeparationResult;
}

const PASS: SeparationResult = Object.freeze({ kind: "PASS" });
const conflict = (rule: SeparationRule): SeparationResult =>
  Object.freeze({ kind: "DENY", reason: "SEPARATION_CONFLICT", rule });
const missing = (rule: SeparationRule): SeparationResult =>
  Object.freeze({ kind: "DENY", reason: "SEPARATION_FACTS_MISSING", rule });

const isIdList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every(isUuid);

const approvalOperations: readonly Operation[] = ["APPROVE", "REVIEW"];

// ---- Mandatory rules (matrix §9.1), exported for direct testing. ----

/** Rule 8: a staff member never acts on their own candidacy/worker file. */
export function ownRecordRule(input: SeparationInput): SeparationResult {
  // `null` is a non-record target (a scope); records always carry a
  // resolver-supplied list, possibly empty.
  if (input.subjectAccountIds === null) return PASS;
  if (!isIdList(input.subjectAccountIds)) return missing("OWN_RECORD");
  return input.subjectAccountIds.includes(input.actorAccountId)
    ? conflict("OWN_RECORD")
    : PASS;
}

/** Rule 5: technical administration never converts to business authority. */
export function administratorBusinessRule(
  input: SeparationInput,
): SeparationResult {
  return input.effectiveRoleCode === "SYSTEM_ADMINISTRATOR" &&
    input.permissionDomain !== "TECHNICAL"
    ? conflict("ADMIN_BUSINESS_DECISION")
    : PASS;
}

/** Rule 10: break-glass access never performs ordinary workflow actions. */
export function breakGlassRule(input: SeparationInput): SeparationResult {
  return input.elevation === "BREAK_GLASS" &&
    (input.permissionDomain !== "TECHNICAL" ||
      approvalOperations.includes(input.operation))
    ? conflict("BREAK_GLASS_ORDINARY_WORKFLOW")
    : PASS;
}

/** Rule 1: nobody approves their own worker-classification proposal. */
export function classificationSelfApprovalRule(
  input: SeparationInput,
): SeparationResult {
  const proposer = input.facts.proposerAccountId;
  if (!isUuid(proposer)) return missing("CLASSIFICATION_SELF_APPROVAL");
  return proposer === input.actorAccountId
    ? conflict("CLASSIFICATION_SELF_APPROVAL")
    : PASS;
}

/**
 * Rule 2: a candidate never approves/verifies their own screening,
 * onboarding, training, competency, or readiness result.
 */
export function candidateSelfVerificationRule(
  input: SeparationInput,
): SeparationResult {
  if (input.actorPrincipalType !== "STAFF") {
    return conflict("CANDIDATE_SELF_VERIFICATION");
  }
  if (!isIdList(input.subjectAccountIds)) {
    return missing("CANDIDATE_SELF_VERIFICATION");
  }
  return input.subjectAccountIds.includes(input.actorAccountId)
    ? conflict("CANDIDATE_SELF_VERIFICATION")
    : PASS;
}

/** Rule 3: the restricted-result entrant does not make the final disposition. */
export function restrictedResultEntrantRule(
  input: SeparationInput,
): SeparationResult {
  if (!input.dualControl.HIGH_RISK_SCREENING_DISPOSITION.required) return PASS;
  const entrant = input.facts.resultEnteredByAccountId;
  if (!isUuid(entrant)) return missing("RESTRICTED_RESULT_ENTRANT");
  return entrant === input.actorAccountId
    ? conflict("RESTRICTED_RESULT_ENTRANT")
    : PASS;
}

/** Rule 4: a signed evaluation is never edited in place. */
export function signedEvaluationRule(input: SeparationInput): SeparationResult {
  if (typeof input.facts.evaluationSigned !== "boolean") {
    return missing("SIGNED_EVALUATION_IMMUTABLE");
  }
  return input.facts.evaluationSigned && input.operation === "EDIT"
    ? conflict("SIGNED_EVALUATION_IMMUTABLE")
    : PASS;
}

/** Rule 6: nobody approves a compensation/offer change they made. */
export function offerSelfApprovalRule(
  input: SeparationInput,
): SeparationResult {
  if (!input.dualControl.OFFER_COMPENSATION_THRESHOLD.required) return PASS;
  const changers = input.facts.changedByAccountIds;
  if (!isIdList(changers) || changers.length === 0) {
    return missing("OFFER_SELF_APPROVAL");
  }
  return changers.includes(input.actorAccountId)
    ? conflict("OFFER_SELF_APPROVAL")
    : PASS;
}

/**
 * Rule 7: final readiness is never approved by the candidate or by a
 * recruiter acting only in the recruiter role.
 */
export function readinessApprovalRule(
  input: SeparationInput,
): SeparationResult {
  if (input.actorPrincipalType !== "STAFF") {
    return conflict("READINESS_APPROVAL");
  }
  return input.effectiveRoleCode === "RECRUITER"
    ? conflict("READINESS_APPROVAL")
    : PASS;
}

/** Rule 9: nobody modifies audit records that document their own actions. */
export function auditSelfModificationRule(
  input: SeparationInput,
): SeparationResult {
  const documented = input.facts.documentedActorAccountIds;
  if (!isIdList(documented)) return missing("AUDIT_SELF_MODIFICATION");
  return documented.includes(input.actorAccountId)
    ? conflict("AUDIT_SELF_MODIFICATION")
    : PASS;
}

/** Exports need a recorded approval by another person (matrix §13). */
export function exportApprovalRule(input: SeparationInput): SeparationResult {
  const approvers = input.facts.priorApproverAccountIds;
  if (!isIdList(approvers) || approvers.length === 0) {
    return missing("EXPORT_APPROVAL");
  }
  return approvers.includes(input.actorAccountId)
    ? conflict("EXPORT_APPROVAL")
    : PASS;
}

/**
 * Configurable two-person approval (matrix §9.2): when required, the actor
 * must differ from every prior approver and from the proposer/changer.
 * Prior approvers must be stated explicitly (an empty list means "first
 * approval"); an absent list denies.
 */
export function dualControlRule(input: SeparationInput): SeparationResult {
  const hook = input.dualControlHook;
  if (!hook || !input.dualControl[hook].required) return PASS;
  const prior = input.facts.priorApproverAccountIds;
  if (!isIdList(prior)) return missing("DUAL_CONTROL");
  const others = [
    ...prior,
    ...(isUuid(input.facts.proposerAccountId)
      ? [input.facts.proposerAccountId]
      : []),
    ...(isIdList(input.facts.changedByAccountIds)
      ? input.facts.changedByAccountIds
      : []),
  ];
  return others.includes(input.actorAccountId)
    ? conflict("DUAL_CONTROL")
    : PASS;
}

const namedRules: Readonly<
  Record<SeparationPolicyCode, (input: SeparationInput) => SeparationResult>
> = {
  CLASSIFICATION_SELF_APPROVAL: classificationSelfApprovalRule,
  CANDIDATE_SELF_VERIFICATION: candidateSelfVerificationRule,
  RESTRICTED_RESULT_ENTRANT: restrictedResultEntrantRule,
  SIGNED_EVALUATION_IMMUTABLE: signedEvaluationRule,
  OFFER_SELF_APPROVAL: offerSelfApprovalRule,
  READINESS_APPROVAL: readinessApprovalRule,
  AUDIT_SELF_MODIFICATION: auditSelfModificationRule,
  EXPORT_APPROVAL: exportApprovalRule,
};

/**
 * The mandatory policy: generic rules for every staff decision, then the
 * permission's named rule, then its dual-control hook. First failure wins.
 */
export class MandatorySeparationOfDutiesPolicy implements SeparationOfDutiesPolicy {
  evaluate(input: SeparationInput): SeparationResult {
    const rules = [
      breakGlassRule,
      administratorBusinessRule,
      ownRecordRule,
      ...(input.policy ? [namedRules[input.policy]] : []),
      dualControlRule,
    ];
    for (const rule of rules) {
      if (typeof rule !== "function") return missing("DUAL_CONTROL");
      const result = rule(input);
      if (result.kind === "DENY") return result;
    }
    return PASS;
  }
}
