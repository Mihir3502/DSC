import type {
  CatalogStatus,
  PrincipalType,
  RoleCode,
} from "../domain/authorization-vocabulary";

// Controlled Release 1 role definitions (packet M1.4 §7). Codes are stable
// identifiers; names may change without changing codes. There is no admin,
// wildcard, superuser, or bypass flag: every role holds only its explicit
// grants in role-permission-catalog.ts.

export type RoleDefinition = Readonly<{
  code: RoleCode;
  name: string;
  description: string;
  principalType: PrincipalType;
  status: CatalogStatus;
  isSystemRole: boolean;
}>;

const role = (
  code: RoleCode,
  name: string,
  principalType: PrincipalType,
  description: string,
): RoleDefinition =>
  Object.freeze({
    code,
    name,
    description,
    principalType,
    status: "ACTIVE",
    isSystemRole: true,
  });

export const roleCatalog: readonly RoleDefinition[] = Object.freeze([
  role(
    "CANDIDATE",
    "Candidate",
    "CANDIDATE",
    "Candidate self-service only; entitlement is relationship-based, never a staff assignment",
  ),
  role(
    "RECRUITER",
    "Recruiter",
    "STAFF",
    "Recruiting operations within granted record scope",
  ),
  role(
    "HR_SPECIALIST",
    "HR Specialist",
    "STAFF",
    "HR application, offer, and onboarding operations within scope",
  ),
  role(
    "CLASSIFICATION_REVIEWER",
    "Classification Reviewer",
    "STAFF",
    "W-2/1099 classification review within scope",
  ),
  role(
    "COMPLIANCE_REVIEWER",
    "Compliance Reviewer",
    "STAFF",
    "Screening, compliance, holds, and readiness within restricted scope",
  ),
  role(
    "TRAINER_EVALUATOR",
    "Trainer/Evaluator",
    "STAFF",
    "Training and competency work within scope",
  ),
  role(
    "PSA_MANAGER",
    "PSA Manager",
    "STAFF",
    "Designated management and approval functions within scope",
  ),
  role(
    "SYSTEM_ADMINISTRATOR",
    "System Administrator",
    "STAFF",
    "Technical configuration and access administration only",
  ),
  role(
    "AUDITOR_READ_ONLY",
    "Auditor/Read Only",
    "STAFF",
    "Read/export only within an approved audit assignment",
  ),
]);

const byCode = new Map(roleCatalog.map((r) => [r.code, r]));

export function findRole(code: unknown): RoleDefinition | null {
  return typeof code === "string"
    ? (byCode.get(code as RoleCode) ?? null)
    : null;
}
