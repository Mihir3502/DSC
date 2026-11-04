CREATE TABLE "app"."application_certification_version" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"version_number" integer NOT NULL,
	"statement" varchar(2000) NOT NULL,
	"review_status" varchar(32) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_certification_version_number_unique" UNIQUE("version_number"),
	CONSTRAINT "application_certification_version_number_check" CHECK ("app"."application_certification_version"."version_number" >= 1),
	CONSTRAINT "application_certification_review_check" CHECK ("app"."application_certification_version"."review_status" IN ('DRAFT_UNREVIEWED', 'APPROVED'))
);
--> statement-breakpoint
CREATE TABLE "app"."application_submission" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"application_version_id" uuid NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"template_version_id" uuid NOT NULL,
	"certification_version_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"certified_name" varchar(200) NOT NULL,
	"receipt_number" varchar(10) NOT NULL,
	"submitted_by_account_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_submission_version_unique" UNIQUE("application_version_id"),
	CONSTRAINT "application_submission_receipt_unique" UNIQUE("receipt_number"),
	CONSTRAINT "application_submission_answers_check" CHECK (jsonb_typeof("app"."application_submission"."answers") = 'object'),
	CONSTRAINT "application_submission_hash_check" CHECK ("app"."application_submission"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "application_submission_receipt_check" CHECK ("app"."application_submission"."receipt_number" ~ '^R-[0-9A-HJKMNP-TV-Z]{8}$'),
	CONSTRAINT "application_submission_name_check" CHECK (char_length("app"."application_submission"."certified_name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "app"."application_submission_attachment" (
	"submission_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	CONSTRAINT "application_submission_attachment_pk" PRIMARY KEY("submission_id","document_version_id")
);
--> statement-breakpoint
CREATE TABLE "app"."outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"aggregate_type" varchar(32) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_version" integer NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "outbox_event_source_unique" UNIQUE("event_type","aggregate_id","aggregate_version"),
	CONSTRAINT "outbox_event_type_check" CHECK ("app"."outbox_event"."event_type" = 'APPLICATION_RECEIVED_EMAIL'),
	CONSTRAINT "outbox_event_aggregate_check" CHECK ("app"."outbox_event"."aggregate_type" = 'CANDIDACY'),
	CONSTRAINT "outbox_event_status_check" CHECK ("app"."outbox_event"."status" IN ('PENDING', 'SENT', 'FAILED')),
	CONSTRAINT "outbox_event_processed_check" CHECK (("app"."outbox_event"."status" = 'PENDING') = ("app"."outbox_event"."processed_at" IS NULL)),
	CONSTRAINT "outbox_event_attempt_check" CHECK ("app"."outbox_event"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."application_version" DROP CONSTRAINT "application_version_status_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy" DROP CONSTRAINT "candidacy_stage_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy" DROP CONSTRAINT "candidacy_visible_status_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy" DROP CONSTRAINT "candidacy_lifecycle_check";--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" DROP CONSTRAINT "candidacy_stage_history_command_check";--> statement-breakpoint
ALTER TABLE "app"."work_item" DROP CONSTRAINT "work_item_type_check";--> statement-breakpoint
ALTER TABLE "app"."work_item" DROP CONSTRAINT "work_item_target_check";--> statement-breakpoint
ALTER TABLE "app"."application_submission" ADD CONSTRAINT "application_submission_version_fk" FOREIGN KEY ("application_version_id") REFERENCES "app"."application_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_submission" ADD CONSTRAINT "application_submission_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_submission" ADD CONSTRAINT "application_submission_template_fk" FOREIGN KEY ("template_version_id") REFERENCES "app"."application_template_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_submission" ADD CONSTRAINT "application_submission_certification_fk" FOREIGN KEY ("certification_version_id") REFERENCES "app"."application_certification_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_submission" ADD CONSTRAINT "application_submission_actor_fk" FOREIGN KEY ("submitted_by_account_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_submission_attachment" ADD CONSTRAINT "application_submission_attachment_submission_fk" FOREIGN KEY ("submission_id") REFERENCES "app"."application_submission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."application_submission_attachment" ADD CONSTRAINT "application_submission_attachment_version_fk" FOREIGN KEY ("document_version_id") REFERENCES "app"."document_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_submission_candidacy_idx" ON "app"."application_submission" USING btree ("candidacy_id");--> statement-breakpoint
CREATE INDEX "outbox_event_pending_idx" ON "app"."outbox_event" USING btree ("available_at") WHERE "app"."outbox_event"."status" = 'PENDING';--> statement-breakpoint
ALTER TABLE "app"."application_version" ADD CONSTRAINT "application_version_status_check" CHECK ("app"."application_version"."status" IN ('DRAFT', 'SUBMITTED'));--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_stage_check" CHECK ("app"."candidacy"."current_stage" IN ('PROSPECT', 'APPLICATION_INCOMPLETE', 'APPLICATION_SUBMITTED'));--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_visible_status_check" CHECK ("app"."candidacy"."candidate_visible_status" = CASE WHEN "app"."candidacy"."status" <> 'ACTIVE' THEN 'CLOSED' WHEN "app"."candidacy"."current_stage" = 'APPLICATION_INCOMPLETE' THEN 'APPLICATION_STARTED' WHEN "app"."candidacy"."current_stage" = 'APPLICATION_SUBMITTED' THEN 'APPLICATION_SUBMITTED' ELSE 'NOT_STARTED' END);--> statement-breakpoint
ALTER TABLE "app"."candidacy" ADD CONSTRAINT "candidacy_lifecycle_check" CHECK ((("app"."candidacy"."current_stage" <> 'PROSPECT') = ("app"."candidacy"."started_at" IS NOT NULL)) AND (("app"."candidacy"."status" = 'TERMINAL') = ("app"."candidacy"."closed_at" IS NOT NULL)) AND (("app"."candidacy"."closed_at" IS NULL) = ("app"."candidacy"."closure_reason_code" IS NULL)) AND ("app"."candidacy"."closure_reason_code" IS NULL OR "app"."candidacy"."closure_reason_code" ~ '^[A-Z][A-Z0-9_]{1,63}$'));--> statement-breakpoint
ALTER TABLE "app"."candidacy_stage_history" ADD CONSTRAINT "candidacy_stage_history_command_check" CHECK ("app"."candidacy_stage_history"."command_code" IN ('create_prospect', 'start_application', 'start_application_from_prospect', 'close_prospect', 'submit_application'));--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_type_check" CHECK ("app"."work_item"."work_type_code" IN ('COMPLETE_APPLICATION', 'REVIEW_SUBMITTED_APPLICATION'));--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_target_check" CHECK ("app"."work_item"."target_record_type" = 'CANDIDACY' AND "app"."work_item"."target_record_id" = "app"."work_item"."candidacy_id" AND "app"."work_item"."candidate_action_required" = ("app"."work_item"."work_type_code" = 'COMPLETE_APPLICATION'));--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.6 §6, §9; DATA_MODEL §7, §19.3).
-- Reviewed: fixed search_path, schema-qualified references, no dynamic SQL.
-- Error class CN as in 0006: CN002 append-only, CN004 immutable reference,
-- CN005 invalid transition.
-- ------------------------------------------------------------------------
CREATE TRIGGER "application_certification_version_append_only" BEFORE UPDATE OR DELETE ON "app"."application_certification_version" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_certification_version_no_truncate" BEFORE TRUNCATE ON "app"."application_certification_version" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_submission_append_only" BEFORE UPDATE OR DELETE ON "app"."application_submission" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_submission_no_truncate" BEFORE TRUNCATE ON "app"."application_submission" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_submission_attachment_append_only" BEFORE UPDATE OR DELETE ON "app"."application_submission_attachment" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "application_submission_attachment_no_truncate" BEFORE TRUNCATE ON "app"."application_submission_attachment" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_append_only"();--> statement-breakpoint
CREATE TRIGGER "outbox_event_no_delete" BEFORE DELETE ON "app"."outbox_event" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "outbox_event_no_truncate" BEFORE TRUNCATE ON "app"."outbox_event" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
-- A draft becomes submitted once, only with its frozen record, and never goes
-- back here. M2.7 will define return and correction.
CREATE OR REPLACE FUNCTION "app"."application_version_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.candidacy_id, NEW.template_version_id, NEW.version_number, NEW.created_by_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.candidacy_id, OLD.template_version_id, OLD.version_number, OLD.created_by_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'application version references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF OLD.status = 'SUBMITTED' AND NEW.status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'a submitted version stays submitted' USING ERRCODE = 'CN005';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'SUBMITTED' AND NOT EXISTS (
    SELECT 1 FROM "app"."application_submission" s WHERE s.application_version_id = NEW.id)
  THEN
    RAISE EXCEPTION 'a version is submitted only with its frozen record' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
-- A frozen record matches its own version and candidacy, and only clean
-- attachment versions of that candidacy can be frozen.
CREATE FUNCTION "app"."application_submission_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "app"."application_version" v
     WHERE v.id = NEW.application_version_id AND v.status = 'DRAFT'
       AND v.candidacy_id = NEW.candidacy_id
       AND v.template_version_id = NEW.template_version_id)
  THEN
    RAISE EXCEPTION 'a submission must match its draft' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "application_submission_guard" BEFORE INSERT ON "app"."application_submission" FOR EACH ROW EXECUTE FUNCTION "app"."application_submission_guard"();--> statement-breakpoint
CREATE FUNCTION "app"."application_submission_attachment_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "app"."application_submission" s
      JOIN "app"."document" d ON d.candidacy_id = s.candidacy_id
      JOIN "app"."document_version" v ON v.document_id = d.id
     WHERE s.id = NEW.submission_id AND v.id = NEW.document_version_id AND v.scan_status = 'CLEAN')
  THEN
    RAISE EXCEPTION 'only a clean version of this candidacy can be frozen' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "application_submission_attachment_guard" BEFORE INSERT ON "app"."application_submission_attachment" FOR EACH ROW EXECUTE FUNCTION "app"."application_submission_attachment_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."application_submission_guard"(), "app"."application_submission_attachment_guard"() FROM PUBLIC;--> statement-breakpoint
-- Certification version 1. The wording is a DRAFT awaiting counsel's review
-- (M2.6 owner decision). Approved text ships as a new immutable version, and
-- past submissions keep the version they accepted.
INSERT INTO "app"."application_certification_version" ("version_number", "statement", "review_status", "effective_from")
VALUES (1, 'I certify that the information in this application is true and complete to the best of my knowledge.', 'DRAFT_UNREVIEWED', TIMESTAMPTZ '2026-11-03 00:00:00+00');
