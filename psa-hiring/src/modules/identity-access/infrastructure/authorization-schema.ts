import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { authSchema, user } from "./auth-schema";

// Application-owned authorization tables (packet M1.4 §7–§9, §15, ADR-0005).
// They live in the identity-access `auth` schema. The runtime role gets
// SELECT only on the catalog tables (role, permission, role_permission),
// which are written solely by the reviewed catalog apply script under the
// migration role; it gets INSERT plus column-limited UPDATE on assignments
// so material authorization history (subject, role, scope, dates) can never
// be rewritten, and no DELETE anywhere.
//
// No organization, branch, team, person, candidacy, or audit-assignment
// table exists: scope references are opaque UUIDs resolved through the
// ScopeResourceResolver port (deferred referential integrity, ADR-0005).

const tz = { withTimezone: true } as const;

const timestamps = {
  createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", tz)
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

const sensitivities = `'PUBLIC', 'INTERNAL', 'CONFIDENTIAL_PERSONNEL', 'RESTRICTED_IDENTITY_FINANCIAL', 'RESTRICTED_SCREENING_MEDICAL', 'SECURITY_AUDIT_RESTRICTED'`;

/** Controlled role definitions; no admin, wildcard, or bypass column. */
export const role = authSchema.table(
  "role",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    code: varchar("code", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 100 }).notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    principalType: varchar("principal_type", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    isSystemRole: boolean("is_system_role").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    ...timestamps,
  },
  (table) => [
    // Target of the assignment composite foreign key: an assignment's
    // principal type must equal its role's principal type.
    unique("role_id_principal_type_unique").on(table.id, table.principalType),
    check("role_code_check", sql`${table.code} ~ '^[A-Z][A-Z_]{1,63}$'`),
    check(
      "role_principal_type_check",
      sql`${table.principalType} IN ('CANDIDATE', 'STAFF')`,
    ),
    check("role_status_check", sql`${table.status} IN ('ACTIVE', 'RETIRED')`),
    check("role_catalog_version_check", sql`${table.catalogVersion} >= 1`),
  ],
);

/** Narrow, sensitivity-aware permission definitions. */
export const permission = authSchema.table(
  "permission",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    code: varchar("code", { length: 128 }).notNull().unique(),
    resource: varchar("resource", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 16 }).notNull(),
    maxSensitivity: varchar("max_sensitivity", { length: 40 }).notNull(),
    permissionDomain: varchar("permission_domain", { length: 16 }).notNull(),
    description: varchar("description", { length: 500 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    requiresScope: boolean("requires_scope").notNull(),
    workflowPolicyCode: varchar("workflow_policy_code", { length: 64 }),
    recentAuthPolicy: varchar("recent_auth_policy", { length: 32 }),
    recentAuthPurpose: varchar("recent_auth_purpose", { length: 64 }),
    separationPolicyCode: varchar("separation_policy_code", { length: 64 }),
    dualControlHook: varchar("dual_control_hook", { length: 64 }),
    requiresReason: boolean("requires_reason").notNull(),
    restrictedData: boolean("restricted_data").notNull(),
    isExport: boolean("is_export").notNull(),
    highRisk: boolean("high_risk").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    ...timestamps,
  },
  (table) => [
    // No wildcard, prefix, or free-form codes: 2–4 lowercase segments.
    check(
      "permission_code_check",
      sql`${table.code} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*){1,3}$' AND ${table.code} = ${table.resource} || '.' || ${table.action}`,
    ),
    check(
      "permission_operation_check",
      sql`${table.operation} IN ('READ', 'CREATE', 'EDIT', 'REVIEW', 'APPROVE', 'DOWNLOAD', 'EXPORT', 'CONFIGURE', 'ADMINISTER')`,
    ),
    check(
      "permission_max_sensitivity_check",
      sql`${table.maxSensitivity} IN (${sql.raw(sensitivities)})`,
    ),
    check(
      "permission_domain_check",
      sql`${table.permissionDomain} IN ('BUSINESS', 'TECHNICAL', 'CANDIDATE_SELF')`,
    ),
    check(
      "permission_status_check",
      sql`${table.status} IN ('ACTIVE', 'RETIRED')`,
    ),
    check(
      "permission_workflow_policy_check",
      sql`${table.workflowPolicyCode} IS NULL OR ${table.workflowPolicyCode} IN ('CANDIDACY_WORKFLOW')`,
    ),
    check(
      "permission_recent_auth_check",
      sql`(${table.recentAuthPolicy} IS NULL) = (${table.recentAuthPurpose} IS NULL) AND (${table.recentAuthPolicy} IS NULL OR ${table.recentAuthPolicy} IN ('RECENT_STAFF_AUTH', 'RECENT_STRONG_AUTH')) AND (${table.recentAuthPurpose} IS NULL OR ${table.recentAuthPurpose} ~ '^[A-Z_]{1,64}$')`,
    ),
    check(
      "permission_separation_policy_check",
      sql`${table.separationPolicyCode} IS NULL OR ${table.separationPolicyCode} IN ('CLASSIFICATION_SELF_APPROVAL', 'CANDIDATE_SELF_VERIFICATION', 'RESTRICTED_RESULT_ENTRANT', 'SIGNED_EVALUATION_IMMUTABLE', 'OFFER_SELF_APPROVAL', 'READINESS_APPROVAL', 'AUDIT_SELF_MODIFICATION', 'EXPORT_APPROVAL')`,
    ),
    check(
      "permission_dual_control_check",
      sql`${table.dualControlHook} IS NULL OR ${table.dualControlHook} IN ('CLASSIFICATION_DECISION', 'HIGH_RISK_SCREENING_DISPOSITION', 'OFFER_COMPENSATION_THRESHOLD', 'MANUAL_COMPLIANCE_WAIVER', 'FINAL_READINESS', 'RESTRICTED_EXPORT', 'RETENTION_LEGAL_HOLD')`,
    ),
    check(
      "permission_export_check",
      sql`${table.isExport} = (${table.operation} = 'EXPORT')`,
    ),
    check(
      "permission_restricted_check",
      sql`${table.restrictedData} = (${table.maxSensitivity} IN ('RESTRICTED_IDENTITY_FINANCIAL', 'RESTRICTED_SCREENING_MEDICAL', 'SECURITY_AUDIT_RESTRICTED'))`,
    ),
    check(
      "permission_catalog_version_check",
      sql`${table.catalogVersion} >= 1`,
    ),
  ],
);

/** Role-permission grants with optional closed, declarative conditions. */
export const rolePermission = authSchema.table(
  "role_permission",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permission.id),
    /** Closed condition document (v1); validated in code, never executed. */
    condition: jsonb("condition"),
    status: varchar("status", { length: 16 }).notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: "role_permission_pk",
      columns: [table.roleId, table.permissionId],
    }),
    index("role_permission_permission_idx").on(table.permissionId),
    check(
      "role_permission_status_check",
      sql`${table.status} IN ('ACTIVE', 'RETIRED')`,
    ),
    check(
      "role_permission_condition_check",
      sql`${table.condition} IS NULL OR (jsonb_typeof(${table.condition}) = 'object' AND ${table.condition} ->> 'v' = '1' AND ${table.condition} ->> 'kind' IN ('CANDIDATE_OWNERSHIP', 'DESIGNATION', 'PARTICIPANT', 'HOLD_CATEGORY'))`,
    ),
    check(
      "role_permission_catalog_version_check",
      sql`${table.catalogVersion} >= 1`,
    ),
  ],
);

/**
 * Effective-dated, scoped staff role assignment. Changes to role, scope, or
 * dates create a new row and supersede/revoke the old one; revoked rows
 * never become active again.
 */
export const userRoleAssignment = authSchema.table(
  "user_role_assignment",
  {
    id: uuid("id")
      .default(sql`pg_catalog.gen_random_uuid()`)
      .primaryKey(),
    userAccountId: uuid("user_account_id")
      .notNull()
      .references(() => user.id),
    roleId: uuid("role_id").notNull(),
    /** Always STAFF; part of the composite FK to role(id, principal_type). */
    principalType: varchar("principal_type", { length: 16 })
      .default("STAFF")
      .notNull(),
    scopeType: varchar("scope_type", { length: 32 }).notNull(),
    scopeReferenceId: uuid("scope_reference_id").notNull(),
    /** Inclusive. */
    effectiveFrom: timestamp("effective_from", tz).notNull(),
    /** Exclusive; null means open-ended. */
    effectiveTo: timestamp("effective_to", tz),
    status: varchar("status", { length: 16 }).notNull(),
    reasonCode: varchar("reason_code", { length: 32 }).notNull(),
    /** Opaque ticket/case reference; never free text. */
    reasonReference: varchar("reason_reference", { length: 64 }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => user.id),
    approvedByUserId: uuid("approved_by_user_id").references(() => user.id),
    approvedAt: timestamp("approved_at", tz),
    revokedAt: timestamp("revoked_at", tz),
    revokedByUserId: uuid("revoked_by_user_id").references(() => user.id),
    revocationReasonCode: varchar("revocation_reason_code", { length: 32 }),
    replacesAssignmentId: uuid("replaces_assignment_id"),
    supersededByAssignmentId: uuid("superseded_by_assignment_id"),
    version: integer("version").default(1).notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "user_role_assignment_role_principal_fk",
      columns: [table.roleId, table.principalType],
      foreignColumns: [role.id, role.principalType],
    }),
    // Explicit names: the generated ones exceed PostgreSQL's 63-byte limit.
    foreignKey({
      name: "user_role_assignment_replaces_fk",
      columns: [table.replacesAssignmentId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: "user_role_assignment_superseded_by_fk",
      columns: [table.supersededByAssignmentId],
      foreignColumns: [table.id],
    }),
    index("user_role_assignment_subject_idx").on(
      table.userAccountId,
      table.status,
    ),
    index("user_role_assignment_role_idx").on(table.roleId),
    check(
      "user_role_assignment_principal_type_check",
      sql`${table.principalType} = 'STAFF'`,
    ),
    check(
      "user_role_assignment_scope_type_check",
      sql`${table.scopeType} IN ('ASSIGNED_RECORDS', 'TEAM', 'BRANCH', 'ORGANIZATION', 'AUDIT_ASSIGNMENT')`,
    ),
    check(
      "user_role_assignment_status_check",
      sql`${table.status} IN ('PROPOSED', 'ACTIVE', 'REJECTED', 'REVOKED', 'SUPERSEDED')`,
    ),
    check(
      "user_role_assignment_effective_check",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      "user_role_assignment_reason_check",
      sql`${table.reasonCode} IN ('NEW_ACCESS', 'ROLE_CHANGE', 'SCOPE_CHANGE', 'EFFECTIVE_DATE_CHANGE', 'TEMPORARY_COVERAGE', 'AUDIT_ENGAGEMENT', 'ACCESS_REVIEW', 'CORRECTION')`,
    ),
    check(
      "user_role_assignment_reason_reference_check",
      sql`${table.reasonReference} IS NULL OR ${table.reasonReference} ~ '^[A-Za-z0-9._-]{1,64}$'`,
    ),
    // Approval evidence exists exactly for approved states, and the
    // approver is neither the subject nor the requester (dual control).
    check(
      "user_role_assignment_approval_check",
      sql`((${table.status} IN ('ACTIVE', 'REVOKED', 'SUPERSEDED')) = (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)) AND (${table.approvedByUserId} IS NULL OR (${table.approvedByUserId} <> ${table.userAccountId} AND ${table.approvedByUserId} <> ${table.createdByUserId}))`,
    ),
    check(
      "user_role_assignment_separation_check",
      sql`${table.createdByUserId} <> ${table.userAccountId} AND (${table.revokedByUserId} IS NULL OR ${table.revokedByUserId} <> ${table.userAccountId})`,
    ),
    // Revocation evidence exists exactly for ended states; supersession is
    // recorded as a revocation with the SUPERSEDED reason.
    check(
      "user_role_assignment_revoked_check",
      sql`CASE WHEN ${table.status} IN ('REVOKED', 'REJECTED') THEN ${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL AND ${table.revocationReasonCode} IS NOT NULL AND ${table.revocationReasonCode} <> 'SUPERSEDED' WHEN ${table.status} = 'SUPERSEDED' THEN ${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL AND ${table.revocationReasonCode} = 'SUPERSEDED' ELSE ${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL AND ${table.revocationReasonCode} IS NULL END`,
    ),
    check(
      "user_role_assignment_revocation_reason_check",
      sql`${table.revocationReasonCode} IS NULL OR ${table.revocationReasonCode} IN ('ACCESS_REVIEW', 'ROLE_CHANGE', 'SEPARATION', 'SECURITY_INCIDENT', 'PROPOSAL_REJECTED', 'CORRECTION', 'SUPERSEDED')`,
    ),
    check(
      "user_role_assignment_superseded_check",
      sql`(${table.status} = 'SUPERSEDED') = (${table.supersededByAssignmentId} IS NOT NULL)`,
    ),
    check("user_role_assignment_version_check", sql`${table.version} >= 1`),
  ],
);

/**
 * One-to-one authorization epoch per account. Incremented in the same
 * transaction as every assignment change that affects the subject.
 */
export const authorizationSubject = authSchema.table(
  "authorization_subject",
  {
    userAccountId: uuid("user_account_id")
      .primaryKey()
      .references(() => user.id),
    authorizationVersion: integer("authorization_version").notNull(),
    versionChangedAt: timestamp("version_changed_at", tz).notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "authorization_subject_version_check",
      sql`${table.authorizationVersion} >= 1`,
    ),
  ],
);
