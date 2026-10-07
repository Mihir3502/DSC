import type { SensitivityLevel } from "@/modules/identity-access/domain/authorization-vocabulary";
import { SyntheticScopeResolver } from "@/modules/identity-access/infrastructure/scope-resolvers";

// Deterministic synthetic scope hierarchy for the M1.7 matrix (packet
// M1.7 §11). M2 organization/branch/team/candidacy tables do not exist,
// so every scope and record is a synthetic authorization envelope served
// by the accepted M1.4 SyntheticScopeResolver (APP_ENV=test only). IDs are
// nonsequential-looking synthetic UUIDs; no real data.

export const u = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const s = (n: number) => u("5c09e000", n);

export const NOW = new Date("2026-10-06T12:00:00.000Z");
export const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

export const scope = {
  ORG: s(1),
  ORG2: s(2),
  BRANCH: s(3),
  BRANCH2: s(4),
  ORG2_BRANCH: s(5),
  TEAM: s(6),
  TEAM2: s(7),
  SET: s(8),
  SET_ORG2: s(9),
  INACTIVE_BRANCH: s(10),
  INACTIVE_TEAM: s(11),
  AUDIT: s(20),
  AUDIT_EXPIRED: s(21),
  AUDIT_FUTURE: s(22),
  AUDIT_OTHER_AUDITOR: s(23),
  AUDIT_NARROW: s(24),
  GROUP: s(30),
  GROUP2: s(31),
  MISSING: s(99),
} as const;

export const record = {
  /** ORG › BRANCH › TEAM, in SET and GROUP, subject Candidate A. */
  IN_TEAM: s(100),
  /** ORG › BRANCH (no team), subject Candidate B. */
  IN_BRANCH: s(101),
  /** ORG › BRANCH2 › TEAM2. */
  SIBLING_BRANCH: s(102),
  /** ORG2 › ORG2_BRANCH, in SET_ORG2. */
  OTHER_ORG: s(103),
  /** Under an inactive branch. */
  INACTIVE_PARENT: s(104),
  /** The staff persona's own worker/candidate file. */
  OWN_FILE: s(105),
  /** In GROUP but recorded outside the audit window. */
  OUT_OF_WINDOW: s(106),
  /** In GROUP2 only. */
  OTHER_GROUP: s(107),
  /** Not registered anywhere. */
  NONEXISTENT: s(198),
} as const;

export const ALL_SENSITIVITIES: readonly SensitivityLevel[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL_PERSONNEL",
  "RESTRICTED_IDENTITY_FINANCIAL",
  "RESTRICTED_SCREENING_MEDICAL",
  "SECURITY_AUDIT_RESTRICTED",
];

export const AUDIT_RECORDS_FROM = new Date("2026-01-01T00:00:00.000Z");
export const AUDIT_RECORDS_TO = new Date("2026-07-01T00:00:00.000Z");

/** Builds the full synthetic hierarchy for the given personas. */
export function syntheticHierarchy(accounts: {
  auditor: string;
  otherAuditor: string;
  ownFileSubject: string;
  candidateA: string;
  candidateB: string;
}) {
  const audit = (
    id: string,
    auditor: string,
    window: { startsAt: Date; endsAt: Date },
    categories: readonly SensitivityLevel[] = ALL_SENSITIVITIES,
  ) => ({
    organizationId: scope.ORG,
    auditorAccountId: auditor,
    categories,
    recordGroupIds: [scope.GROUP],
    recordsFrom: AUDIT_RECORDS_FROM,
    recordsTo: AUDIT_RECORDS_TO,
    ...window,
  });
  const live = { startsAt: at(-86_400), endsAt: at(86_400) };
  return new SyntheticScopeResolver("test")
    .addOrganization(scope.ORG)
    .addOrganization(scope.ORG2)
    .addBranch(scope.BRANCH, scope.ORG)
    .addBranch(scope.BRANCH2, scope.ORG)
    .addBranch(scope.ORG2_BRANCH, scope.ORG2)
    .addBranch(scope.INACTIVE_BRANCH, scope.ORG)
    .addTeam(scope.TEAM, scope.BRANCH)
    .addTeam(scope.TEAM2, scope.BRANCH2)
    .addTeam(scope.INACTIVE_TEAM, scope.INACTIVE_BRANCH)
    .addAssignmentSet(scope.SET, scope.ORG)
    .addAssignmentSet(scope.SET_ORG2, scope.ORG2)
    .addAuditAssignment(scope.AUDIT, audit(scope.AUDIT, accounts.auditor, live))
    .addAuditAssignment(
      scope.AUDIT_EXPIRED,
      audit(scope.AUDIT_EXPIRED, accounts.auditor, {
        startsAt: at(-172_800),
        endsAt: at(-86_400),
      }),
    )
    .addAuditAssignment(
      scope.AUDIT_FUTURE,
      audit(scope.AUDIT_FUTURE, accounts.auditor, {
        startsAt: at(86_400),
        endsAt: at(172_800),
      }),
    )
    .addAuditAssignment(
      scope.AUDIT_OTHER_AUDITOR,
      audit(scope.AUDIT_OTHER_AUDITOR, accounts.otherAuditor, live),
    )
    .addAuditAssignment(
      scope.AUDIT_NARROW,
      audit(scope.AUDIT_NARROW, accounts.auditor, live, [
        "CONFIDENTIAL_PERSONNEL",
      ]),
    )
    .addRecord(record.IN_TEAM, {
      organizationId: scope.ORG,
      branchId: scope.BRANCH,
      teamId: scope.TEAM,
      assignmentSetIds: [scope.SET],
      recordGroupIds: [scope.GROUP],
      recordedAt: new Date("2026-03-01T00:00:00.000Z"),
      subjectAccountIds: [accounts.candidateA],
    })
    .addRecord(record.IN_BRANCH, {
      organizationId: scope.ORG,
      branchId: scope.BRANCH,
      subjectAccountIds: [accounts.candidateB],
    })
    .addRecord(record.SIBLING_BRANCH, {
      organizationId: scope.ORG,
      branchId: scope.BRANCH2,
      teamId: scope.TEAM2,
      subjectAccountIds: [],
    })
    .addRecord(record.OTHER_ORG, {
      organizationId: scope.ORG2,
      branchId: scope.ORG2_BRANCH,
      assignmentSetIds: [scope.SET_ORG2],
      recordGroupIds: [scope.GROUP],
      recordedAt: new Date("2026-03-01T00:00:00.000Z"),
      subjectAccountIds: [],
    })
    .addRecord(record.INACTIVE_PARENT, {
      organizationId: scope.ORG,
      branchId: scope.INACTIVE_BRANCH,
      teamId: scope.INACTIVE_TEAM,
      subjectAccountIds: [],
    })
    .addRecord(record.OWN_FILE, {
      organizationId: scope.ORG,
      branchId: scope.BRANCH,
      teamId: scope.TEAM,
      assignmentSetIds: [scope.SET],
      recordGroupIds: [scope.GROUP],
      recordedAt: new Date("2026-03-01T00:00:00.000Z"),
      subjectAccountIds: [accounts.ownFileSubject],
    })
    .addRecord(record.OUT_OF_WINDOW, {
      organizationId: scope.ORG,
      branchId: scope.BRANCH,
      recordGroupIds: [scope.GROUP],
      recordedAt: new Date("2026-08-01T00:00:00.000Z"),
      subjectAccountIds: [],
    })
    .addRecord(record.OTHER_GROUP, {
      organizationId: scope.ORG,
      branchId: scope.BRANCH,
      recordGroupIds: [scope.GROUP2],
      recordedAt: new Date("2026-03-01T00:00:00.000Z"),
      subjectAccountIds: [],
    })
    .deactivate(scope.INACTIVE_BRANCH);
}
