CREATE TABLE "auth"."authorization_subject" (
	"user_account_id" uuid PRIMARY KEY NOT NULL,
	"authorization_version" integer NOT NULL,
	"version_changed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorization_subject_version_check" CHECK ("auth"."authorization_subject"."authorization_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth"."permission" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code" varchar(128) NOT NULL,
	"resource" varchar(64) NOT NULL,
	"action" varchar(64) NOT NULL,
	"operation" varchar(16) NOT NULL,
	"max_sensitivity" varchar(40) NOT NULL,
	"permission_domain" varchar(16) NOT NULL,
	"description" varchar(500) NOT NULL,
	"status" varchar(16) NOT NULL,
	"requires_scope" boolean NOT NULL,
	"workflow_policy_code" varchar(64),
	"recent_auth_policy" varchar(32),
	"recent_auth_purpose" varchar(64),
	"separation_policy_code" varchar(64),
	"dual_control_hook" varchar(64),
	"requires_reason" boolean NOT NULL,
	"restricted_data" boolean NOT NULL,
	"is_export" boolean NOT NULL,
	"high_risk" boolean NOT NULL,
	"catalog_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_code_unique" UNIQUE("code"),
	CONSTRAINT "permission_code_check" CHECK ("auth"."permission"."code" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$' AND "auth"."permission"."code" = "auth"."permission"."resource" || '.' || "auth"."permission"."action"),
	CONSTRAINT "permission_operation_check" CHECK ("auth"."permission"."operation" IN ('READ', 'CREATE', 'EDIT', 'REVIEW', 'APPROVE', 'DOWNLOAD', 'EXPORT', 'CONFIGURE', 'ADMINISTER')),
	CONSTRAINT "permission_max_sensitivity_check" CHECK ("auth"."permission"."max_sensitivity" IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL_PERSONNEL', 'RESTRICTED_IDENTITY_FINANCIAL', 'RESTRICTED_SCREENING_MEDICAL', 'SECURITY_AUDIT_RESTRICTED')),
	CONSTRAINT "permission_domain_check" CHECK ("auth"."permission"."permission_domain" IN ('BUSINESS', 'TECHNICAL', 'CANDIDATE_SELF')),
	CONSTRAINT "permission_status_check" CHECK ("auth"."permission"."status" IN ('ACTIVE', 'RETIRED')),
	CONSTRAINT "permission_workflow_policy_check" CHECK ("auth"."permission"."workflow_policy_code" IS NULL OR "auth"."permission"."workflow_policy_code" IN ('CANDIDACY_WORKFLOW')),
	CONSTRAINT "permission_recent_auth_check" CHECK (("auth"."permission"."recent_auth_policy" IS NULL) = ("auth"."permission"."recent_auth_purpose" IS NULL) AND ("auth"."permission"."recent_auth_policy" IS NULL OR "auth"."permission"."recent_auth_policy" IN ('RECENT_STAFF_AUTH', 'RECENT_STRONG_AUTH')) AND ("auth"."permission"."recent_auth_purpose" IS NULL OR "auth"."permission"."recent_auth_purpose" ~ '^[A-Z_]{1,64}$')),
	CONSTRAINT "permission_separation_policy_check" CHECK ("auth"."permission"."separation_policy_code" IS NULL OR "auth"."permission"."separation_policy_code" IN ('CLASSIFICATION_SELF_APPROVAL', 'CANDIDATE_SELF_VERIFICATION', 'RESTRICTED_RESULT_ENTRANT', 'SIGNED_EVALUATION_IMMUTABLE', 'OFFER_SELF_APPROVAL', 'READINESS_APPROVAL', 'AUDIT_SELF_MODIFICATION', 'EXPORT_APPROVAL')),
	CONSTRAINT "permission_dual_control_check" CHECK ("auth"."permission"."dual_control_hook" IS NULL OR "auth"."permission"."dual_control_hook" IN ('CLASSIFICATION_DECISION', 'HIGH_RISK_SCREENING_DISPOSITION', 'OFFER_COMPENSATION_THRESHOLD', 'MANUAL_COMPLIANCE_WAIVER', 'FINAL_READINESS', 'RESTRICTED_EXPORT', 'RETENTION_LEGAL_HOLD')),
	CONSTRAINT "permission_export_check" CHECK ("auth"."permission"."is_export" = ("auth"."permission"."operation" = 'EXPORT')),
	CONSTRAINT "permission_restricted_check" CHECK ("auth"."permission"."restricted_data" = ("auth"."permission"."max_sensitivity" IN ('RESTRICTED_IDENTITY_FINANCIAL', 'RESTRICTED_SCREENING_MEDICAL', 'SECURITY_AUDIT_RESTRICTED'))),
	CONSTRAINT "permission_catalog_version_check" CHECK ("auth"."permission"."catalog_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth"."role" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(500) NOT NULL,
	"principal_type" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"is_system_role" boolean NOT NULL,
	"catalog_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_code_unique" UNIQUE("code"),
	CONSTRAINT "role_id_principal_type_unique" UNIQUE("id","principal_type"),
	CONSTRAINT "role_code_check" CHECK ("auth"."role"."code" ~ '^[A-Z][A-Z_]{1,63}$'),
	CONSTRAINT "role_principal_type_check" CHECK ("auth"."role"."principal_type" IN ('CANDIDATE', 'STAFF')),
	CONSTRAINT "role_status_check" CHECK ("auth"."role"."status" IN ('ACTIVE', 'RETIRED')),
	CONSTRAINT "role_catalog_version_check" CHECK ("auth"."role"."catalog_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth"."role_permission" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"condition" jsonb,
	"status" varchar(16) NOT NULL,
	"catalog_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_pk" PRIMARY KEY("role_id","permission_id"),
	CONSTRAINT "role_permission_status_check" CHECK ("auth"."role_permission"."status" IN ('ACTIVE', 'RETIRED')),
	CONSTRAINT "role_permission_condition_check" CHECK ("auth"."role_permission"."condition" IS NULL OR (jsonb_typeof("auth"."role_permission"."condition") = 'object' AND "auth"."role_permission"."condition" ->> 'v' = '1' AND "auth"."role_permission"."condition" ->> 'kind' IN ('CANDIDATE_OWNERSHIP', 'DESIGNATION', 'PARTICIPANT', 'HOLD_CATEGORY'))),
	CONSTRAINT "role_permission_catalog_version_check" CHECK ("auth"."role_permission"."catalog_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "auth"."user_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_account_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"principal_type" varchar(16) DEFAULT 'STAFF' NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_reference_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"status" varchar(16) NOT NULL,
	"reason_code" varchar(32) NOT NULL,
	"reason_reference" varchar(64),
	"created_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason_code" varchar(32),
	"replaces_assignment_id" uuid,
	"superseded_by_assignment_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_assignment_principal_type_check" CHECK ("auth"."user_role_assignment"."principal_type" = 'STAFF'),
	CONSTRAINT "user_role_assignment_scope_type_check" CHECK ("auth"."user_role_assignment"."scope_type" IN ('ASSIGNED_RECORDS', 'TEAM', 'BRANCH', 'ORGANIZATION', 'AUDIT_ASSIGNMENT')),
	CONSTRAINT "user_role_assignment_status_check" CHECK ("auth"."user_role_assignment"."status" IN ('PROPOSED', 'ACTIVE', 'REJECTED', 'REVOKED', 'SUPERSEDED')),
	CONSTRAINT "user_role_assignment_effective_check" CHECK ("auth"."user_role_assignment"."effective_to" IS NULL OR "auth"."user_role_assignment"."effective_to" > "auth"."user_role_assignment"."effective_from"),
	CONSTRAINT "user_role_assignment_reason_check" CHECK ("auth"."user_role_assignment"."reason_code" IN ('NEW_ACCESS', 'ROLE_CHANGE', 'SCOPE_CHANGE', 'EFFECTIVE_DATE_CHANGE', 'TEMPORARY_COVERAGE', 'AUDIT_ENGAGEMENT', 'ACCESS_REVIEW', 'CORRECTION')),
	CONSTRAINT "user_role_assignment_reason_reference_check" CHECK ("auth"."user_role_assignment"."reason_reference" IS NULL OR "auth"."user_role_assignment"."reason_reference" ~ '^[A-Za-z0-9._-]{1,64}$'),
	CONSTRAINT "user_role_assignment_approval_check" CHECK ((("auth"."user_role_assignment"."status" IN ('ACTIVE', 'REVOKED', 'SUPERSEDED')) = ("auth"."user_role_assignment"."approved_by_user_id" IS NOT NULL AND "auth"."user_role_assignment"."approved_at" IS NOT NULL)) AND ("auth"."user_role_assignment"."approved_by_user_id" IS NULL OR ("auth"."user_role_assignment"."approved_by_user_id" <> "auth"."user_role_assignment"."user_account_id" AND "auth"."user_role_assignment"."approved_by_user_id" <> "auth"."user_role_assignment"."created_by_user_id"))),
	CONSTRAINT "user_role_assignment_separation_check" CHECK ("auth"."user_role_assignment"."created_by_user_id" <> "auth"."user_role_assignment"."user_account_id" AND ("auth"."user_role_assignment"."revoked_by_user_id" IS NULL OR "auth"."user_role_assignment"."revoked_by_user_id" <> "auth"."user_role_assignment"."user_account_id")),
	CONSTRAINT "user_role_assignment_revoked_check" CHECK (CASE WHEN "auth"."user_role_assignment"."status" IN ('REVOKED', 'REJECTED') THEN "auth"."user_role_assignment"."revoked_at" IS NOT NULL AND "auth"."user_role_assignment"."revoked_by_user_id" IS NOT NULL AND "auth"."user_role_assignment"."revocation_reason_code" IS NOT NULL AND "auth"."user_role_assignment"."revocation_reason_code" <> 'SUPERSEDED' WHEN "auth"."user_role_assignment"."status" = 'SUPERSEDED' THEN "auth"."user_role_assignment"."revoked_at" IS NOT NULL AND "auth"."user_role_assignment"."revoked_by_user_id" IS NOT NULL AND "auth"."user_role_assignment"."revocation_reason_code" = 'SUPERSEDED' ELSE "auth"."user_role_assignment"."revoked_at" IS NULL AND "auth"."user_role_assignment"."revoked_by_user_id" IS NULL AND "auth"."user_role_assignment"."revocation_reason_code" IS NULL END),
	CONSTRAINT "user_role_assignment_revocation_reason_check" CHECK ("auth"."user_role_assignment"."revocation_reason_code" IS NULL OR "auth"."user_role_assignment"."revocation_reason_code" IN ('ACCESS_REVIEW', 'ROLE_CHANGE', 'SEPARATION', 'SECURITY_INCIDENT', 'PROPOSAL_REJECTED', 'CORRECTION', 'SUPERSEDED')),
	CONSTRAINT "user_role_assignment_superseded_check" CHECK (("auth"."user_role_assignment"."status" = 'SUPERSEDED') = ("auth"."user_role_assignment"."superseded_by_assignment_id" IS NOT NULL)),
	CONSTRAINT "user_role_assignment_version_check" CHECK ("auth"."user_role_assignment"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "auth"."authorization_subject" ADD CONSTRAINT "authorization_subject_user_account_id_user_id_fk" FOREIGN KEY ("user_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "auth"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."role_permission" ADD CONSTRAINT "role_permission_permission_id_permission_id_fk" FOREIGN KEY ("permission_id") REFERENCES "auth"."permission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_user_account_id_user_id_fk" FOREIGN KEY ("user_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_role_principal_fk" FOREIGN KEY ("role_id","principal_type") REFERENCES "auth"."role"("id","principal_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_replaces_fk" FOREIGN KEY ("replaces_assignment_id") REFERENCES "auth"."user_role_assignment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."user_role_assignment" ADD CONSTRAINT "user_role_assignment_superseded_by_fk" FOREIGN KEY ("superseded_by_assignment_id") REFERENCES "auth"."user_role_assignment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_permission_permission_idx" ON "auth"."role_permission" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "user_role_assignment_subject_idx" ON "auth"."user_role_assignment" USING btree ("user_account_id","status");--> statement-breakpoint
CREATE INDEX "user_role_assignment_role_idx" ON "auth"."user_role_assignment" USING btree ("role_id");