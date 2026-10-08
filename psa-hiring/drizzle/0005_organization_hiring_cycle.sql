CREATE TABLE "app"."branch" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"public_location_label" varchar(120) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"activated_at" timestamp with time zone,
	"inactivated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	CONSTRAINT "branch_organization_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "branch_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "branch_code_check" CHECK ("app"."branch"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "branch_name_check" CHECK (char_length("app"."branch"."name") BETWEEN 1 AND 120),
	CONSTRAINT "branch_public_location_label_check" CHECK (char_length("app"."branch"."public_location_label") BETWEEN 1 AND 120),
	CONSTRAINT "branch_timezone_check" CHECK (char_length("app"."branch"."timezone") BETWEEN 1 AND 64),
	CONSTRAINT "branch_status_check" CHECK ("app"."branch"."status" IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
	CONSTRAINT "branch_lifecycle_check" CHECK (("app"."branch"."status" = 'DRAFT') = ("app"."branch"."activated_at" IS NULL)),
	CONSTRAINT "branch_version_check" CHECK ("app"."branch"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."hiring_cycle" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"public_reference" varchar(12) NOT NULL,
	"organization_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"team_id" uuid,
	"code" varchar(32) NOT NULL,
	"internal_label" varchar(120) NOT NULL,
	"public_label" varchar(120),
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone,
	"open_ended" boolean DEFAULT false NOT NULL,
	"display_timezone" varchar(64) NOT NULL,
	"job_description_version_id" uuid,
	"worker_paths_snapshot" varchar(32),
	"public_title_snapshot" varchar(120),
	"location_label_snapshot" varchar(120),
	"published_at" timestamp with time zone,
	"published_by_account_id" uuid,
	"opened_at" timestamp with time zone,
	"opened_by_account_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_account_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_account_id" uuid,
	"archived_at" timestamp with time zone,
	"archived_by_account_id" uuid,
	"end_reason_code" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	CONSTRAINT "hiring_cycle_public_reference_unique" UNIQUE("public_reference"),
	CONSTRAINT "hiring_cycle_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "hiring_cycle_public_reference_check" CHECK ("app"."hiring_cycle"."public_reference" ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
	CONSTRAINT "hiring_cycle_code_check" CHECK ("app"."hiring_cycle"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "hiring_cycle_internal_label_check" CHECK (char_length("app"."hiring_cycle"."internal_label") BETWEEN 1 AND 120),
	CONSTRAINT "hiring_cycle_public_label_check" CHECK ("app"."hiring_cycle"."public_label" IS NULL OR char_length("app"."hiring_cycle"."public_label") BETWEEN 1 AND 120),
	CONSTRAINT "hiring_cycle_status_check" CHECK ("app"."hiring_cycle"."status" IN ('DRAFT', 'PUBLISHED', 'OPEN', 'CLOSED', 'CANCELLED', 'ARCHIVED')),
	CONSTRAINT "hiring_cycle_window_check" CHECK ((("app"."hiring_cycle"."closes_at" IS NULL) = "app"."hiring_cycle"."open_ended") AND ("app"."hiring_cycle"."closes_at" IS NULL OR "app"."hiring_cycle"."closes_at" > "app"."hiring_cycle"."opens_at")),
	CONSTRAINT "hiring_cycle_timezone_check" CHECK (char_length("app"."hiring_cycle"."display_timezone") BETWEEN 1 AND 64),
	CONSTRAINT "hiring_cycle_worker_paths_check" CHECK ("app"."hiring_cycle"."worker_paths_snapshot" IS NULL OR "app"."hiring_cycle"."worker_paths_snapshot" IN ('W2_ONLY', 'CONTRACTOR_ELIGIBLE_ONLY', 'W2_AND_CONTRACTOR_ELIGIBLE')),
	CONSTRAINT "hiring_cycle_snapshot_check" CHECK (("app"."hiring_cycle"."published_at" IS NULL) = ("app"."hiring_cycle"."published_by_account_id" IS NULL) AND ("app"."hiring_cycle"."published_at" IS NULL OR ("app"."hiring_cycle"."job_description_version_id" IS NOT NULL AND "app"."hiring_cycle"."worker_paths_snapshot" IS NOT NULL AND "app"."hiring_cycle"."public_title_snapshot" IS NOT NULL AND "app"."hiring_cycle"."location_label_snapshot" IS NOT NULL))),
	CONSTRAINT "hiring_cycle_lifecycle_check" CHECK (("app"."hiring_cycle"."status" <> 'DRAFT' OR ("app"."hiring_cycle"."published_at" IS NULL AND "app"."hiring_cycle"."cancelled_at" IS NULL)) AND ("app"."hiring_cycle"."status" NOT IN ('PUBLISHED', 'OPEN', 'CLOSED') OR "app"."hiring_cycle"."published_at" IS NOT NULL) AND (("app"."hiring_cycle"."opened_at" IS NULL) = ("app"."hiring_cycle"."opened_by_account_id" IS NULL)) AND ("app"."hiring_cycle"."status" <> 'OPEN' OR "app"."hiring_cycle"."opened_at" IS NOT NULL) AND (("app"."hiring_cycle"."closed_at" IS NULL) = ("app"."hiring_cycle"."closed_by_account_id" IS NULL)) AND (("app"."hiring_cycle"."status" = 'CLOSED') <= ("app"."hiring_cycle"."closed_at" IS NOT NULL)) AND (("app"."hiring_cycle"."cancelled_at" IS NULL) = ("app"."hiring_cycle"."cancelled_by_account_id" IS NULL)) AND (("app"."hiring_cycle"."status" = 'CANCELLED') <= ("app"."hiring_cycle"."cancelled_at" IS NOT NULL)) AND (("app"."hiring_cycle"."archived_at" IS NULL) = ("app"."hiring_cycle"."archived_by_account_id" IS NULL)) AND (("app"."hiring_cycle"."status" = 'ARCHIVED') = ("app"."hiring_cycle"."archived_at" IS NOT NULL)) AND (("app"."hiring_cycle"."closed_at" IS NOT NULL OR "app"."hiring_cycle"."cancelled_at" IS NOT NULL) = ("app"."hiring_cycle"."end_reason_code" IS NOT NULL)) AND NOT ("app"."hiring_cycle"."closed_at" IS NOT NULL AND "app"."hiring_cycle"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "hiring_cycle_reason_check" CHECK ("app"."hiring_cycle"."end_reason_code" IS NULL OR "app"."hiring_cycle"."end_reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "hiring_cycle_version_check" CHECK ("app"."hiring_cycle"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."job_description_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"public_title" varchar(120) NOT NULL,
	"summary" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"content_format" varchar(32) DEFAULT 'PLAIN_TEXT_V1' NOT NULL,
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_account_id" uuid,
	"superseded_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	CONSTRAINT "job_description_version_position_id_unique" UNIQUE("position_id","id"),
	CONSTRAINT "job_description_version_number_unique" UNIQUE("position_id","version_number"),
	CONSTRAINT "job_description_version_number_check" CHECK ("app"."job_description_version"."version_number" >= 1),
	CONSTRAINT "job_description_version_public_title_check" CHECK (char_length("app"."job_description_version"."public_title") BETWEEN 1 AND 120),
	CONSTRAINT "job_description_version_summary_check" CHECK (char_length("app"."job_description_version"."summary") BETWEEN 1 AND 500),
	CONSTRAINT "job_description_version_body_check" CHECK (char_length("app"."job_description_version"."body") BETWEEN 1 AND 8000),
	CONSTRAINT "job_description_version_format_check" CHECK ("app"."job_description_version"."content_format" = 'PLAIN_TEXT_V1'),
	CONSTRAINT "job_description_version_status_check" CHECK ("app"."job_description_version"."status" IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'RETIRED')),
	CONSTRAINT "job_description_version_lifecycle_check" CHECK ((("app"."job_description_version"."status" IN ('PUBLISHED', 'SUPERSEDED')) = ("app"."job_description_version"."published_at" IS NOT NULL AND "app"."job_description_version"."published_by_account_id" IS NOT NULL)) AND (("app"."job_description_version"."status" = 'SUPERSEDED') = ("app"."job_description_version"."superseded_at" IS NOT NULL))),
	CONSTRAINT "job_description_version_version_check" CHECK ("app"."job_description_version"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."organization" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"activated_at" timestamp with time zone,
	"inactivated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	CONSTRAINT "organization_code_unique" UNIQUE("code"),
	CONSTRAINT "organization_code_check" CHECK ("app"."organization"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "organization_legal_name_check" CHECK (char_length("app"."organization"."legal_name") BETWEEN 1 AND 200),
	CONSTRAINT "organization_display_name_check" CHECK (char_length("app"."organization"."display_name") BETWEEN 1 AND 120),
	CONSTRAINT "organization_timezone_check" CHECK (char_length("app"."organization"."timezone") BETWEEN 1 AND 64),
	CONSTRAINT "organization_status_check" CHECK ("app"."organization"."status" IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
	CONSTRAINT "organization_lifecycle_check" CHECK (("app"."organization"."status" = 'DRAFT') = ("app"."organization"."activated_at" IS NULL)),
	CONSTRAINT "organization_version_check" CHECK ("app"."organization"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."organization_command_receipt" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"command_key" uuid NOT NULL,
	"command_name" varchar(64) NOT NULL,
	"target_id" uuid NOT NULL,
	"result_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_command_receipt_key_unique" UNIQUE("actor_account_id","command_key"),
	CONSTRAINT "organization_command_receipt_name_check" CHECK ("app"."organization_command_receipt"."command_name" ~ '^[a-z][a-z_]{1,63}$'),
	CONSTRAINT "organization_command_receipt_version_check" CHECK ("app"."organization_command_receipt"."result_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."position" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"internal_title" varchar(120) NOT NULL,
	"public_title" varchar(120) NOT NULL,
	"worker_paths_allowed" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	CONSTRAINT "position_organization_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "position_code_unique" UNIQUE("organization_id","code"),
	CONSTRAINT "position_code_check" CHECK ("app"."position"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "position_internal_title_check" CHECK (char_length("app"."position"."internal_title") BETWEEN 1 AND 120),
	CONSTRAINT "position_public_title_check" CHECK (char_length("app"."position"."public_title") BETWEEN 1 AND 120),
	CONSTRAINT "position_worker_paths_check" CHECK ("app"."position"."worker_paths_allowed" IN ('W2_ONLY', 'CONTRACTOR_ELIGIBLE_ONLY', 'W2_AND_CONTRACTOR_ELIGIBLE')),
	CONSTRAINT "position_status_check" CHECK ("app"."position"."status" IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'RETIRED')),
	CONSTRAINT "position_lifecycle_check" CHECK (("app"."position"."status" <> 'DRAFT' OR "app"."position"."activated_at" IS NULL) AND ("app"."position"."status" NOT IN ('ACTIVE', 'INACTIVE') OR "app"."position"."activated_at" IS NOT NULL) AND (("app"."position"."status" = 'RETIRED') = ("app"."position"."retired_at" IS NOT NULL))),
	CONSTRAINT "position_version_check" CHECK ("app"."position"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."team" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(120) NOT NULL,
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"activated_at" timestamp with time zone,
	"inactivated_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	CONSTRAINT "team_branch_id_unique" UNIQUE("branch_id","id"),
	CONSTRAINT "team_code_unique" UNIQUE("branch_id","code"),
	CONSTRAINT "team_code_check" CHECK ("app"."team"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "team_name_check" CHECK (char_length("app"."team"."name") BETWEEN 1 AND 120),
	CONSTRAINT "team_status_check" CHECK ("app"."team"."status" IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
	CONSTRAINT "team_lifecycle_check" CHECK (("app"."team"."status" = 'DRAFT') = ("app"."team"."activated_at" IS NULL)),
	CONSTRAINT "team_version_check" CHECK ("app"."team"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "audit"."audit_event" DROP CONSTRAINT "audit_event_target_check";--> statement-breakpoint
ALTER TABLE "app"."branch" ADD CONSTRAINT "branch_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."branch" ADD CONSTRAINT "branch_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."branch" ADD CONSTRAINT "branch_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_position_fk" FOREIGN KEY ("organization_id","position_id") REFERENCES "app"."position"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "app"."branch"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_team_fk" FOREIGN KEY ("branch_id","team_id") REFERENCES "app"."team"("branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_description_fk" FOREIGN KEY ("position_id","job_description_version_id") REFERENCES "app"."job_description_version"("position_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_published_by_fk" FOREIGN KEY ("published_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_opened_by_fk" FOREIGN KEY ("opened_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_closed_by_fk" FOREIGN KEY ("closed_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_cancelled_by_fk" FOREIGN KEY ("cancelled_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_archived_by_fk" FOREIGN KEY ("archived_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."hiring_cycle" ADD CONSTRAINT "hiring_cycle_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_description_version" ADD CONSTRAINT "job_description_version_position_fk" FOREIGN KEY ("organization_id","position_id") REFERENCES "app"."position"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_description_version" ADD CONSTRAINT "job_description_version_published_by_fk" FOREIGN KEY ("published_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_description_version" ADD CONSTRAINT "job_description_version_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_description_version" ADD CONSTRAINT "job_description_version_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization" ADD CONSTRAINT "organization_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization" ADD CONSTRAINT "organization_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_command_receipt" ADD CONSTRAINT "organization_command_receipt_actor_fk" FOREIGN KEY ("actor_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."position" ADD CONSTRAINT "position_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."position" ADD CONSTRAINT "position_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."position" ADD CONSTRAINT "position_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."team" ADD CONSTRAINT "team_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "app"."branch"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."team" ADD CONSTRAINT "team_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."team" ADD CONSTRAINT "team_updated_by_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branch_scope_idx" ON "app"."branch" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "hiring_cycle_public_open_idx" ON "app"."hiring_cycle" USING btree ("opens_at","closes_at","id") WHERE "app"."hiring_cycle"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "hiring_cycle_scope_idx" ON "app"."hiring_cycle" USING btree ("organization_id","branch_id","team_id","status");--> statement-breakpoint
CREATE INDEX "hiring_cycle_position_idx" ON "app"."hiring_cycle" USING btree ("position_id","branch_id","status","opens_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_description_version_one_draft" ON "app"."job_description_version" USING btree ("position_id") WHERE "app"."job_description_version"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "job_description_version_one_published" ON "app"."job_description_version" USING btree ("position_id") WHERE "app"."job_description_version"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE INDEX "position_scope_idx" ON "app"."position" USING btree ("organization_id","status","code");--> statement-breakpoint
CREATE INDEX "team_scope_idx" ON "app"."team" USING btree ("organization_id","branch_id","status");--> statement-breakpoint
ALTER TABLE "audit"."audit_event" ADD CONSTRAINT "audit_event_target_check" CHECK ((target_type IS NOT NULL OR target_id IS NULL) AND (target_type IS NULL OR target_type IN ('USER_ACCOUNT', 'STAFF_INVITATION', 'STAFF_RECOVERY_CASE', 'ROLE_ASSIGNMENT', 'AUTHORIZATION_CATALOG', 'PROTECTED_RESOURCE', 'AUDIT_LOG', 'ORGANIZATION', 'BRANCH', 'TEAM', 'POSITION', 'JOB_DESCRIPTION_VERSION', 'HIRING_CYCLE')) AND (target_id IS NOT NULL OR target_type IS NULL OR target_type IN ('AUTHORIZATION_CATALOG', 'AUDIT_LOG')));--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.1 §8.3, §11.3, §12.2–§12.3,
-- §13, §22; DATA_MODEL §5). Reviewed: fixed search_path, schema-qualified
-- references, no dynamic SQL, owner = migration role, no PUBLIC access.
-- Error class OG: OG001 delete refused, OG002 reparent/reference change,
-- OG003 code change after activation/publication, OG004 published
-- content or snapshot change, OG005 lifecycle transition refused.
-- ------------------------------------------------------------------------
CREATE FUNCTION "app"."organization_reject_delete"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'organization configuration history is never deleted' USING ERRCODE = 'OG001';
END
$$;--> statement-breakpoint
CREATE TRIGGER "organization_no_delete" BEFORE DELETE ON "app"."organization" FOR EACH ROW EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "organization_no_truncate" BEFORE TRUNCATE ON "app"."organization" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "branch_no_delete" BEFORE DELETE ON "app"."branch" FOR EACH ROW EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "branch_no_truncate" BEFORE TRUNCATE ON "app"."branch" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "team_no_delete" BEFORE DELETE ON "app"."team" FOR EACH ROW EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "team_no_truncate" BEFORE TRUNCATE ON "app"."team" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "position_no_delete" BEFORE DELETE ON "app"."position" FOR EACH ROW EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "position_no_truncate" BEFORE TRUNCATE ON "app"."position" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "job_description_version_no_delete" BEFORE DELETE ON "app"."job_description_version" FOR EACH ROW EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "job_description_version_no_truncate" BEFORE TRUNCATE ON "app"."job_description_version" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "hiring_cycle_no_delete" BEFORE DELETE ON "app"."hiring_cycle" FOR EACH ROW EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "hiring_cycle_no_truncate" BEFORE TRUNCATE ON "app"."hiring_cycle" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_reject_delete"();--> statement-breakpoint
CREATE FUNCTION "app"."organization_command_receipt_append_only"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'command receipts are append-only' USING ERRCODE = 'OG001';
END
$$;--> statement-breakpoint
CREATE TRIGGER "organization_command_receipt_append_only" BEFORE UPDATE OR DELETE ON "app"."organization_command_receipt" FOR EACH ROW EXECUTE FUNCTION "app"."organization_command_receipt_append_only"();--> statement-breakpoint
CREATE TRIGGER "organization_command_receipt_no_truncate" BEFORE TRUNCATE ON "app"."organization_command_receipt" FOR EACH STATEMENT EXECUTE FUNCTION "app"."organization_command_receipt_append_only"();--> statement-breakpoint
-- Hierarchy rows: parents never change; codes freeze at first activation.
CREATE FUNCTION "app"."organization_hierarchy_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF (old_row -> 'organization_id') IS DISTINCT FROM (new_row -> 'organization_id')
     OR (old_row -> 'branch_id') IS DISTINCT FROM (new_row -> 'branch_id') THEN
    RAISE EXCEPTION 'configuration parents are immutable' USING ERRCODE = 'OG002';
  END IF;
  IF OLD.code IS DISTINCT FROM NEW.code AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'codes are stable after activation' USING ERRCODE = 'OG003';
  END IF;
  IF OLD.status IN ('ARCHIVED', 'RETIRED') THEN
    RAISE EXCEPTION 'terminal configuration cannot change' USING ERRCODE = 'OG005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "organization_guard" BEFORE UPDATE ON "app"."organization" FOR EACH ROW EXECUTE FUNCTION "app"."organization_hierarchy_guard"();--> statement-breakpoint
CREATE TRIGGER "branch_guard" BEFORE UPDATE ON "app"."branch" FOR EACH ROW EXECUTE FUNCTION "app"."organization_hierarchy_guard"();--> statement-breakpoint
CREATE TRIGGER "team_guard" BEFORE UPDATE ON "app"."team" FOR EACH ROW EXECUTE FUNCTION "app"."organization_hierarchy_guard"();--> statement-breakpoint
CREATE TRIGGER "position_guard" BEFORE UPDATE ON "app"."position" FOR EACH ROW EXECUTE FUNCTION "app"."organization_hierarchy_guard"();--> statement-breakpoint
-- Job-description versions: published content is immutable; the only
-- change after publication is PUBLISHED -> SUPERSEDED/RETIRED.
CREATE FUNCTION "app"."job_description_version_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.organization_id, NEW.position_id, NEW.version_number, NEW.created_at, NEW.created_by_account_id)
     IS DISTINCT FROM (OLD.organization_id, OLD.position_id, OLD.version_number, OLD.created_at, OLD.created_by_account_id) THEN
    RAISE EXCEPTION 'description identity is immutable' USING ERRCODE = 'OG002';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'PUBLISHED') THEN
      RAISE EXCEPTION 'invalid description transition' USING ERRCODE = 'OG005';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'PUBLISHED' AND NEW.status IN ('SUPERSEDED', 'RETIRED')
     AND (NEW.public_title, NEW.summary, NEW.body, NEW.content_format, NEW.published_at, NEW.published_by_account_id)
         IS NOT DISTINCT FROM (OLD.public_title, OLD.summary, OLD.body, OLD.content_format, OLD.published_at, OLD.published_by_account_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published descriptions are immutable' USING ERRCODE = 'OG004';
END
$$;--> statement-breakpoint
CREATE TRIGGER "job_description_version_guard" BEFORE UPDATE ON "app"."job_description_version" FOR EACH ROW EXECUTE FUNCTION "app"."job_description_version_guard"();--> statement-breakpoint
-- Hiring cycles: references never change (OG002); after DRAFT the code,
-- labels, window, snapshot, and recorded history are frozen (OG004); only
-- forward transitions are allowed (OG005).
CREATE FUNCTION "app"."hiring_cycle_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.public_reference, NEW.organization_id, NEW.position_id, NEW.branch_id, NEW.team_id, NEW.created_at, NEW.created_by_account_id)
     IS DISTINCT FROM (OLD.public_reference, OLD.organization_id, OLD.position_id, OLD.branch_id, OLD.team_id, OLD.created_at, OLD.created_by_account_id) THEN
    RAISE EXCEPTION 'hiring-cycle references are immutable' USING ERRCODE = 'OG002';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
    (NEW.code, NEW.internal_label, NEW.public_label, NEW.opens_at, NEW.closes_at, NEW.open_ended, NEW.display_timezone,
     NEW.job_description_version_id, NEW.worker_paths_snapshot, NEW.public_title_snapshot, NEW.location_label_snapshot,
     NEW.published_at, NEW.published_by_account_id)
    IS DISTINCT FROM
    (OLD.code, OLD.internal_label, OLD.public_label, OLD.opens_at, OLD.closes_at, OLD.open_ended, OLD.display_timezone,
     OLD.job_description_version_id, OLD.worker_paths_snapshot, OLD.public_title_snapshot, OLD.location_label_snapshot,
     OLD.published_at, OLD.published_by_account_id)
  ) THEN
    RAISE EXCEPTION 'published hiring cycles are immutable' USING ERRCODE = 'OG004';
  END IF;
  IF (OLD.opened_at IS NOT NULL AND (NEW.opened_at, NEW.opened_by_account_id) IS DISTINCT FROM (OLD.opened_at, OLD.opened_by_account_id))
     OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at, NEW.closed_by_account_id) IS DISTINCT FROM (OLD.closed_at, OLD.closed_by_account_id))
     OR (OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at, NEW.cancelled_by_account_id) IS DISTINCT FROM (OLD.cancelled_at, OLD.cancelled_by_account_id))
     OR (OLD.end_reason_code IS NOT NULL AND NEW.end_reason_code IS DISTINCT FROM OLD.end_reason_code) THEN
    RAISE EXCEPTION 'hiring-cycle history is immutable' USING ERRCODE = 'OG004';
  END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'PUBLISHED', 'CANCELLED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('OPEN', 'CLOSED', 'CANCELLED'))
    OR (OLD.status = 'OPEN' AND NEW.status IN ('CLOSED', 'CANCELLED'))
    OR (OLD.status IN ('CLOSED', 'CANCELLED') AND NEW.status = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'invalid hiring-cycle transition' USING ERRCODE = 'OG005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "hiring_cycle_guard" BEFORE UPDATE ON "app"."hiring_cycle" FOR EACH ROW EXECUTE FUNCTION "app"."hiring_cycle_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."organization_reject_delete"(), "app"."organization_command_receipt_append_only"(), "app"."organization_hierarchy_guard"(), "app"."job_description_version_guard"(), "app"."hiring_cycle_guard"() FROM PUBLIC;
