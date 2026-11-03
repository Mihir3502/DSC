CREATE TABLE "app"."application_draft_section" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"application_version_id" uuid NOT NULL,
	"section_code" varchar(40) NOT NULL,
	"answers" jsonb NOT NULL,
	"completion_status" varchar(16) NOT NULL,
	"version" integer NOT NULL,
	"saved_by_account_id" uuid NOT NULL,
	"saved_by_kind" varchar(16) NOT NULL,
	"assist_reason_code" varchar(64),
	"saved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_draft_section_unique" UNIQUE("application_version_id","section_code"),
	CONSTRAINT "application_draft_section_code_check" CHECK ("app"."application_draft_section"."section_code" ~ '^[a-z][a-z_]{1,39}$'),
	CONSTRAINT "application_draft_section_answers_check" CHECK (jsonb_typeof("app"."application_draft_section"."answers") = 'object' AND pg_column_size("app"."application_draft_section"."answers") <= 65536),
	CONSTRAINT "application_draft_section_completion_check" CHECK ("app"."application_draft_section"."completion_status" IN ('IN_PROGRESS', 'COMPLETE')),
	CONSTRAINT "application_draft_section_version_check" CHECK ("app"."application_draft_section"."version" >= 1),
	CONSTRAINT "application_draft_section_assist_check" CHECK (("app"."application_draft_section"."saved_by_kind" = 'CANDIDATE' AND "app"."application_draft_section"."assist_reason_code" IS NULL) OR ("app"."application_draft_section"."saved_by_kind" = 'STAFF_ASSIST' AND "app"."application_draft_section"."assist_reason_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."application_template" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_template_code_unique" UNIQUE("code"),
	CONSTRAINT "application_template_code_check" CHECK ("app"."application_template"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "app"."application_template_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"application_template_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"schema_json" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_template_version_number_unique" UNIQUE("application_template_id","version_number"),
	CONSTRAINT "application_template_version_number_check" CHECK ("app"."application_template_version"."version_number" >= 1),
	CONSTRAINT "application_template_version_schema_check" CHECK (jsonb_typeof("app"."application_template_version"."schema_json") = 'object'),
	CONSTRAINT "application_template_version_window_check" CHECK ("app"."application_template_version"."effective_to" IS NULL OR "app"."application_template_version"."effective_to" > "app"."application_template_version"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "app"."application_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_version_number_unique" UNIQUE("candidacy_id","version_number"),
	CONSTRAINT "application_version_number_check" CHECK ("app"."application_version"."version_number" >= 1),
	CONSTRAINT "application_version_status_check" CHECK ("app"."application_version"."status" = 'DRAFT')
);
--> statement-breakpoint
ALTER TABLE "app"."application_draft_section" ADD CONSTRAINT "application_draft_section_version_fk" FOREIGN KEY ("application_version_id") REFERENCES "app"."application_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_draft_section" ADD CONSTRAINT "application_draft_section_saved_by_fk" FOREIGN KEY ("saved_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_template_version" ADD CONSTRAINT "application_template_version_template_fk" FOREIGN KEY ("application_template_id") REFERENCES "app"."application_template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_template_fk" FOREIGN KEY ("template_version_id") REFERENCES "app"."application_template_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_created_by_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_version_one_draft_unique" ON "app"."application_version" USING btree ("candidacy_id") WHERE "app"."application_version"."status" = 'DRAFT';--> statement-breakpoint
CREATE INDEX "application_version_template_idx" ON "app"."application_version" USING btree ("template_version_id");--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.4 §6, §9; DATA_MODEL §7).
-- Reviewed: fixed search_path, schema-qualified references, no dynamic SQL,
-- owner = migration role, no PUBLIC access. Error class CN as in 0006:
-- CN004 immutable reference, CN005 invalid transition.
-- ------------------------------------------------------------------------
CREATE TRIGGER "application_template_append_only" BEFORE UPDATE OR DELETE ON "app"."application_template" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_template_no_truncate" BEFORE TRUNCATE ON "app"."application_template" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_template_version_append_only" BEFORE UPDATE OR DELETE ON "app"."application_template_version" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_template_version_no_truncate" BEFORE TRUNCATE ON "app"."application_template_version" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_version_no_delete" BEFORE DELETE ON "app"."application_version" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "application_version_no_truncate" BEFORE TRUNCATE ON "app"."application_version" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "application_draft_section_no_delete" BEFORE DELETE ON "app"."application_draft_section" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "application_draft_section_no_truncate" BEFORE TRUNCATE ON "app"."application_draft_section" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
-- A draft stays on its candidacy, template version, and version number.
CREATE FUNCTION "app"."application_version_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.candidacy_id, NEW.template_version_id, NEW.version_number, NEW.created_by_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.candidacy_id, OLD.template_version_id, OLD.version_number, OLD.created_by_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'application version references are immutable' USING ERRCODE = 'CN004';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "application_version_guard" BEFORE UPDATE ON "app"."application_version" FOR EACH ROW EXECUTE FUNCTION "app"."application_version_guard"();--> statement-breakpoint
-- A section belongs to one DRAFT forever, and each write adds one version.
CREATE FUNCTION "app"."application_draft_section_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "app"."application_version" v
     WHERE v.id = NEW.application_version_id AND v.status = 'DRAFT')
  THEN
    RAISE EXCEPTION 'only a draft can change' USING ERRCODE = 'CN005';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'a section starts at version 1' USING ERRCODE = 'CN005';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.application_version_id, NEW.section_code, NEW.created_at)
     IS DISTINCT FROM (OLD.application_version_id, OLD.section_code, OLD.created_at) THEN
    RAISE EXCEPTION 'section references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a section write adds one version' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "application_draft_section_guard" BEFORE INSERT OR UPDATE ON "app"."application_draft_section" FOR EACH ROW EXECUTE FUNCTION "app"."application_draft_section_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."application_version_guard"(), "app"."application_draft_section_guard"() FROM PUBLIC;--> statement-breakpoint
-- Template version 1. The wording is a draft for business review (M2.4
-- decision: neutral sections only; no eligibility or disclosure questions,
-- date of birth, or SSN). Any change ships as a new immutable version.
INSERT INTO "app"."application_template" ("code", "name") VALUES ('CANDIDATE_APPLICATION', 'Candidate application');--> statement-breakpoint
INSERT INTO "app"."application_template_version" ("application_template_id", "version_number", "schema_json", "published_at", "effective_from")
SELECT t.id, 1, $v1${"sections":[{"code":"availability","title":"Availability","description":"Tell us when you could work and how you would get to work.","fields":[{"code":"available_days","label":"Which days can you work?","type":"multi_choice","required":true,"options":[{"value":"monday","label":"Monday"},{"value":"tuesday","label":"Tuesday"},{"value":"wednesday","label":"Wednesday"},{"value":"thursday","label":"Thursday"},{"value":"friday","label":"Friday"},{"value":"saturday","label":"Saturday"},{"value":"sunday","label":"Sunday"}]},{"code":"available_shifts","label":"Which shifts can you work?","type":"multi_choice","required":true,"options":[{"value":"morning","label":"Morning"},{"value":"afternoon","label":"Afternoon"},{"value":"evening","label":"Evening"},{"value":"overnight","label":"Overnight"}]},{"code":"hours_preference","label":"Which hours would you prefer?","type":"single_choice","required":true,"options":[{"value":"full_time","label":"Full time"},{"value":"part_time","label":"Part time"},{"value":"either","label":"Either"}]},{"code":"earliest_start_date","label":"What is the earliest date you could start?","type":"date","required":true},{"code":"reliable_transportation","label":"Do you have reliable transportation to work locations?","type":"single_choice","required":false,"options":[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]},{"code":"availability_notes","label":"Anything else about your availability?","hint":"Please don't include Social Security numbers, ID numbers, or medical information.","type":"long_text","required":false}]},{"code":"experience","title":"Employment and experience","description":"Tell us about your caregiving experience and recent jobs.","fields":[{"code":"caregiving_experience","label":"How much caregiving experience do you have?","type":"single_choice","required":true,"options":[{"value":"none","label":"None yet"},{"value":"under_one_year","label":"Less than 1 year"},{"value":"one_to_three_years","label":"1 to 3 years"},{"value":"over_three_years","label":"More than 3 years"}]},{"code":"experience_summary","label":"Describe your relevant experience","hint":"Please don't include Social Security numbers, ID numbers, or medical information.","type":"long_text","required":false},{"code":"recent_employer","label":"Most recent employer","type":"short_text","required":false},{"code":"recent_job_title","label":"Most recent job title","type":"short_text","required":false},{"code":"recent_start_date","label":"Most recent job: start date","type":"date","required":false},{"code":"recent_end_date","label":"Most recent job: end date","hint":"Leave blank if you still work there.","type":"date","required":false},{"code":"previous_employer","label":"Previous employer","type":"short_text","required":false},{"code":"previous_job_title","label":"Previous job title","type":"short_text","required":false}]},{"code":"education","title":"Education, licenses, and certifications","description":"Tell us about your education and any credentials you hold.","fields":[{"code":"highest_education","label":"What is your highest level of education?","type":"single_choice","required":true,"options":[{"value":"no_diploma","label":"No high school diploma"},{"value":"high_school","label":"High school diploma or equivalent"},{"value":"some_college","label":"Some college or vocational training"},{"value":"associate","label":"Associate degree"},{"value":"bachelor_or_higher","label":"Bachelor's degree or higher"}]},{"code":"credentials_summary","label":"List any licenses or certifications you hold","hint":"Give the name of each credential. Please don't include Social Security numbers, ID numbers, or medical information.","type":"long_text","required":false}]},{"code":"references","title":"References","description":"Tell us who can speak about your work. Please let them know we may contact them.","fields":[{"code":"reference_1_name","label":"Reference 1: full name","type":"short_text","required":true},{"code":"reference_1_relationship","label":"Reference 1: how you know them","type":"short_text","required":true},{"code":"reference_1_phone","label":"Reference 1: phone number","type":"phone","required":true},{"code":"reference_1_email","label":"Reference 1: email address","type":"email","required":false},{"code":"reference_2_name","label":"Reference 2: full name","type":"short_text","required":false},{"code":"reference_2_relationship","label":"Reference 2: how you know them","type":"short_text","required":false},{"code":"reference_2_phone","label":"Reference 2: phone number","type":"phone","required":false},{"code":"reference_2_email","label":"Reference 2: email address","type":"email","required":false}]}]}$v1$::jsonb, TIMESTAMPTZ '2026-11-03 00:00:00+00', TIMESTAMPTZ '2026-11-03 00:00:00+00'
  FROM "app"."application_template" t WHERE t.code = 'CANDIDATE_APPLICATION';
