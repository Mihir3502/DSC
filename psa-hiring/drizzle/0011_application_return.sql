CREATE TABLE "app"."application_return" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"application_version_id" uuid NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"instructions" varchar(1000) NOT NULL,
	"reopened" jsonb NOT NULL,
	"attachments_reopened" boolean NOT NULL,
	"returned_by_account_id" uuid NOT NULL,
	"returned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_return_version_unique" UNIQUE("application_version_id"),
	CONSTRAINT "application_return_reason_check" CHECK ("app"."application_return"."reason_code" IN ('INCOMPLETE_INFORMATION', 'INCORRECT_INFORMATION', 'UNCLEAR_ANSWER', 'ATTACHMENT_PROBLEM', 'OTHER')),
	CONSTRAINT "application_return_instructions_check" CHECK (char_length("app"."application_return"."instructions") BETWEEN 1 AND 1000),
	CONSTRAINT "application_return_reopened_check" CHECK (jsonb_typeof("app"."application_return"."reopened") = 'object' AND ("app"."application_return"."reopened" <> '{}'::jsonb OR "app"."application_return"."attachments_reopened"))
);
--> statement-breakpoint
ALTER TABLE "app"."application_version" DROP CONSTRAINT "application_version_status_check";--> statement-breakpoint
ALTER TABLE "app"."outbox_event" DROP CONSTRAINT "outbox_event_type_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" DROP CONSTRAINT "candidacy_stage_history_command_check";--> statement-breakpoint
ALTER TABLE "app"."work_item" DROP CONSTRAINT "work_item_type_check";--> statement-breakpoint
ALTER TABLE "app"."work_item" DROP CONSTRAINT "work_item_target_check";--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."application_return" ADD CONSTRAINT "application_return_version_fk" FOREIGN KEY ("application_version_id") REFERENCES "app"."application_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_return" ADD CONSTRAINT "application_return_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_return" ADD CONSTRAINT "application_return_actor_fk" FOREIGN KEY ("returned_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_return_candidacy_idx" ON "app"."application_return" USING btree ("candidacy_id");--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_supersedes_fk" FOREIGN KEY ("supersedes_id") REFERENCES "app"."application_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_supersedes_unique" UNIQUE("supersedes_id");--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_status_check" CHECK ("app"."application_version"."status" IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'SUPERSEDED'));--> statement-breakpoint
ALTER TABLE "app"."outbox_event" ADD CONSTRAINT "outbox_event_type_check" CHECK ("app"."outbox_event"."event_type" IN ('APPLICATION_RECEIVED_EMAIL', 'APPLICATION_RETURNED_EMAIL'));--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" ADD CONSTRAINT "candidacy_stage_history_command_check" CHECK ("app"."candidacy_stage_history"."command_code" IN ('create_prospect', 'start_application', 'start_application_from_prospect', 'close_prospect', 'submit_application', 'return_application'));--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_type_check" CHECK ("app"."work_item"."work_type_code" IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION', 'REVIEW_SUBMITTED_APPLICATION'));--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_target_check" CHECK ("app"."work_item"."target_record_type" = 'CANDIDACY' AND "app"."work_item"."target_record_id" = "app"."work_item"."candidacy_id" AND "app"."work_item"."candidate_action_required" = ("app"."work_item"."work_type_code" IN ('COMPLETE_APPLICATION', 'CORRECT_APPLICATION')));--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.7 §6, §9; DATA_MODEL §7).
-- Reviewed: fixed search_path, schema-qualified references, no dynamic SQL.
-- Error class CN as in 0006: CN002 append-only, CN004 immutable reference,
-- CN005 invalid transition.
-- ------------------------------------------------------------------------
CREATE TRIGGER "application_return_append_only" BEFORE UPDATE OR DELETE ON "app"."application_return" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_return_no_truncate" BEFORE TRUNCATE ON "app"."application_return" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
-- Only a submitted version of this candidacy can be returned.
CREATE FUNCTION "app"."application_return_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "app"."application_version" v
     WHERE v.id = NEW.application_version_id AND v.candidacy_id = NEW.candidacy_id AND v.status = 'SUBMITTED')
  THEN
    RAISE EXCEPTION 'only a submitted version can be returned' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "application_return_guard" BEFORE INSERT ON "app"."application_return" FOR EACH ROW EXECUTE FUNCTION "app"."application_return_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."application_return_guard"() FROM PUBLIC;--> statement-breakpoint
-- The version lifecycle: DRAFT -> SUBMITTED (with its frozen record) ->
-- RETURNED (with its return) -> SUPERSEDED (once a correction is submitted).
CREATE OR REPLACE FUNCTION "app"."application_version_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.candidacy_id, NEW.template_version_id, NEW.version_number, NEW.supersedes_id, NEW.created_by_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.candidacy_id, OLD.template_version_id, OLD.version_number, OLD.supersedes_id, OLD.created_by_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'application version references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' AND EXISTS (
    SELECT 1 FROM "app"."application_submission" s WHERE s.application_version_id = NEW.id)
  THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status = 'RETURNED' AND EXISTS (
    SELECT 1 FROM "app"."application_return" r WHERE r.application_version_id = NEW.id)
  THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'RETURNED' AND NEW.status = 'SUPERSEDED' AND EXISTS (
    SELECT 1 FROM "app"."application_version" v
      JOIN "app"."application_submission" s ON s.application_version_id = v.id
     WHERE v.supersedes_id = NEW.id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid application version transition' USING ERRCODE = 'CN005';
END
$$;
