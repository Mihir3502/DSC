CREATE TABLE "app"."prescreen_checklist_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"version_number" integer NOT NULL,
	"items" jsonb NOT NULL,
	"review_status" varchar(32) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescreen_checklist_version_number_unique" UNIQUE("version_number"),
	CONSTRAINT "prescreen_checklist_version_number_check" CHECK ("app"."prescreen_checklist_version"."version_number" >= 1),
	CONSTRAINT "prescreen_checklist_review_check" CHECK ("app"."prescreen_checklist_version"."review_status" IN ('DRAFT_UNREVIEWED', 'APPROVED')),
	CONSTRAINT "prescreen_checklist_items_check" CHECK (jsonb_typeof("app"."prescreen_checklist_version"."items") = 'array')
);
--> statement-breakpoint
CREATE TABLE "app"."prescreen_review" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"application_version_id" uuid NOT NULL,
	"checklist_version_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'IN_PROGRESS' NOT NULL,
	"responses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"responses_version" integer DEFAULT 0 NOT NULL,
	"internal_notes" varchar(2000),
	"accepted_by_account_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"reviewer_account_id" uuid,
	"exception_reason_code" varchar(64),
	"exception_by_account_id" uuid,
	"exception_at" timestamp with time zone,
	"exception_responses_version" integer,
	"decided_by_account_id" uuid,
	"decided_at" timestamp with time zone,
	"not_selected_reason_code" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "prescreen_review_version_unique" UNIQUE("application_version_id"),
	CONSTRAINT "prescreen_review_status_check" CHECK ("app"."prescreen_review"."status" IN ('IN_PROGRESS', 'PASSED', 'NOT_SELECTED', 'RETURNED')),
	CONSTRAINT "prescreen_review_decided_check" CHECK ((("app"."prescreen_review"."status" IN ('PASSED', 'NOT_SELECTED')) = ("app"."prescreen_review"."decided_at" IS NOT NULL)) AND (("app"."prescreen_review"."decided_at" IS NULL) = ("app"."prescreen_review"."decided_by_account_id" IS NULL))),
	CONSTRAINT "prescreen_review_not_selected_check" CHECK (("app"."prescreen_review"."status" = 'NOT_SELECTED') = ("app"."prescreen_review"."not_selected_reason_code" IS NOT NULL)),
	CONSTRAINT "prescreen_review_exception_check" CHECK ((("app"."prescreen_review"."exception_reason_code" IS NULL) = ("app"."prescreen_review"."exception_by_account_id" IS NULL)) AND (("app"."prescreen_review"."exception_reason_code" IS NULL) = ("app"."prescreen_review"."exception_at" IS NULL)) AND (("app"."prescreen_review"."exception_reason_code" IS NULL) = ("app"."prescreen_review"."exception_responses_version" IS NULL))),
	CONSTRAINT "prescreen_review_exception_separation_check" CHECK ("app"."prescreen_review"."exception_by_account_id" IS NULL OR "app"."prescreen_review"."exception_by_account_id" <> "app"."prescreen_review"."reviewer_account_id"),
	CONSTRAINT "prescreen_review_responses_check" CHECK (jsonb_typeof("app"."prescreen_review"."responses") = 'object' AND "app"."prescreen_review"."responses_version" >= 0),
	CONSTRAINT "prescreen_review_version_check" CHECK ("app"."prescreen_review"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."candidacy_hold" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"category_code" varchar(64) NOT NULL,
	"internal_reason" varchar(1000) NOT NULL,
	"review_at" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"placed_by_account_id" uuid NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"removed_by_account_id" uuid,
	"removed_at" timestamp with time zone,
	"removal_reason_code" varchar(64),
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "candidacy_hold_category_check" CHECK ("app"."candidacy_hold"."category_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "candidacy_hold_status_check" CHECK ("app"."candidacy_hold"."status" IN ('ACTIVE', 'REMOVED')),
	CONSTRAINT "candidacy_hold_removal_check" CHECK ((("app"."candidacy_hold"."status" = 'REMOVED') = ("app"."candidacy_hold"."removed_at" IS NOT NULL)) AND (("app"."candidacy_hold"."removed_at" IS NULL) = ("app"."candidacy_hold"."removed_by_account_id" IS NULL)) AND (("app"."candidacy_hold"."removed_at" IS NULL) = ("app"."candidacy_hold"."removal_reason_code" IS NULL))),
	CONSTRAINT "candidacy_hold_reason_check" CHECK (char_length("app"."candidacy_hold"."internal_reason") >= 1),
	CONSTRAINT "candidacy_hold_version_check" CHECK ("app"."candidacy_hold"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."candidacy" DROP CONSTRAINT "candidacy_stage_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy" DROP CONSTRAINT "candidacy_visible_status_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" DROP CONSTRAINT "candidacy_stage_history_command_check";--> statement-breakpoint
ALTER TABLE "app"."work_item" DROP CONSTRAINT "work_item_type_check";--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_id_candidacy_unique" UNIQUE("id","candidacy_id");--> statement-breakpoint
ALTER TABLE "app"."prescreen_review" ADD CONSTRAINT "prescreen_review_version_fk" FOREIGN KEY ("application_version_id","candidacy_id") REFERENCES "app"."application_version"("id","candidacy_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prescreen_review" ADD CONSTRAINT "prescreen_review_checklist_fk" FOREIGN KEY ("checklist_version_id") REFERENCES "app"."prescreen_checklist_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prescreen_review" ADD CONSTRAINT "prescreen_review_accepted_by_fk" FOREIGN KEY ("accepted_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prescreen_review" ADD CONSTRAINT "prescreen_review_reviewer_fk" FOREIGN KEY ("reviewer_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prescreen_review" ADD CONSTRAINT "prescreen_review_exception_by_fk" FOREIGN KEY ("exception_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."prescreen_review" ADD CONSTRAINT "prescreen_review_decided_by_fk" FOREIGN KEY ("decided_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy_hold" ADD CONSTRAINT "candidacy_hold_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy_hold" ADD CONSTRAINT "candidacy_hold_placed_by_fk" FOREIGN KEY ("placed_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."candidacy_hold" ADD CONSTRAINT "candidacy_hold_removed_by_fk" FOREIGN KEY ("removed_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prescreen_review_one_open_unique" ON "app"."prescreen_review" USING btree ("candidacy_id") WHERE "app"."prescreen_review"."status" = 'IN_PROGRESS';--> statement-breakpoint
CREATE INDEX "prescreen_review_candidacy_idx" ON "app"."prescreen_review" USING btree ("candidacy_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidacy_hold_one_active_unique" ON "app"."candidacy_hold" USING btree ("candidacy_id") WHERE "app"."candidacy_hold"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "candidacy_hold_candidacy_idx" ON "app"."candidacy_hold" USING btree ("candidacy_id","placed_at");--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_stage_check" CHECK ("app"."candidacy"."current_stage" IN ('PROSPECT', 'APPLICATION_INCOMPLETE', 'APPLICATION_SUBMITTED', 'PRESCREEN_REVIEW', 'INTERVIEW'));--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_visible_status_check" CHECK ("app"."candidacy"."candidate_visible_status" = CASE WHEN "app"."candidacy"."status" <> 'ACTIVE' THEN 'CLOSED' WHEN "app"."candidacy"."current_stage" = 'APPLICATION_INCOMPLETE' THEN 'APPLICATION_STARTED' WHEN "app"."candidacy"."current_stage" = 'APPLICATION_SUBMITTED' THEN 'APPLICATION_SUBMITTED' WHEN "app"."candidacy"."current_stage" = 'PRESCREEN_REVIEW' THEN 'UNDER_REVIEW' WHEN "app"."candidacy"."current_stage" = 'INTERVIEW' THEN 'INTERVIEW_STEP' ELSE 'NOT_STARTED' END);--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" ADD CONSTRAINT "candidacy_stage_history_command_check" CHECK ("app"."candidacy_stage_history"."command_code" IN ('create_prospect', 'start_application', 'start_application_from_prospect', 'close_prospect', 'submit_application', 'return_application', 'accept_for_prescreen', 'pass_prescreen', 'not_select_prescreen'));--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_type_check" CHECK ("app"."work_item"."work_type_code" IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION', 'REVIEW_SUBMITTED_APPLICATION', 'COMPLETE_PRESCREEN'));--> statement-breakpoint
-- Hand-written tail (packet M3.3 §6).
CREATE TRIGGER "prescreen_checklist_version_append_only" BEFORE UPDATE OR DELETE ON "app"."prescreen_checklist_version" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "prescreen_checklist_version_no_truncate" BEFORE TRUNCATE ON "app"."prescreen_checklist_version" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "prescreen_review_no_delete" BEFORE DELETE ON "app"."prescreen_review" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "prescreen_review_no_truncate" BEFORE TRUNCATE ON "app"."prescreen_review" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "candidacy_hold_no_delete" BEFORE DELETE ON "app"."candidacy_hold" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "candidacy_hold_no_truncate" BEFORE TRUNCATE ON "app"."candidacy_hold" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE FUNCTION "app"."prescreen_review_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.candidacy_id, NEW.application_version_id, NEW.checklist_version_id, NEW.accepted_by_account_id, NEW.accepted_at)
     IS DISTINCT FROM
     (OLD.candidacy_id, OLD.application_version_id, OLD.checklist_version_id, OLD.accepted_by_account_id, OLD.accepted_at) THEN
    RAISE EXCEPTION 'prescreen references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF OLD.status <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'a finished prescreen is history' USING ERRCODE = 'CN005';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a prescreen update adds one version' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "prescreen_review_guard" BEFORE UPDATE ON "app"."prescreen_review" FOR EACH ROW EXECUTE FUNCTION "app"."prescreen_review_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."prescreen_review_guard"() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION "app"."candidacy_hold_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.candidacy_id, NEW.category_code, NEW.internal_reason, NEW.review_at, NEW.placed_by_account_id, NEW.placed_at)
     IS DISTINCT FROM
     (OLD.candidacy_id, OLD.category_code, OLD.internal_reason, OLD.review_at, OLD.placed_by_account_id, OLD.placed_at) THEN
    RAISE EXCEPTION 'a hold record is immutable' USING ERRCODE = 'CN004';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REMOVED' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a hold can only be removed once' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "candidacy_hold_guard" BEFORE UPDATE ON "app"."candidacy_hold" FOR EACH ROW EXECUTE FUNCTION "app"."candidacy_hold_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."candidacy_hold_guard"() FROM PUBLIC;--> statement-breakpoint
INSERT INTO "app"."prescreen_checklist_version" ("version_number", "items", "review_status", "effective_from")
VALUES (1, '[{"code":"availability_fit","label":"Availability fits this opening"},{"code":"experience_reviewed","label":"Experience reviewed against the position description"},{"code":"references_provided","label":"References provided"},{"code":"contact_confirmed","label":"Contact details confirmed"}]'::jsonb, 'DRAFT_UNREVIEWED', '2026-01-01T00:00:00Z');
