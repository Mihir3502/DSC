CREATE TABLE "app"."work_item" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"candidacy_id" uuid NOT NULL,
	"work_type_code" varchar(64) NOT NULL,
	"target_record_type" varchar(32) NOT NULL,
	"target_record_id" uuid NOT NULL,
	"candidate_action_required" boolean NOT NULL,
	"status" varchar(16) DEFAULT 'OPEN' NOT NULL,
	"priority" varchar(16) DEFAULT 'NORMAL' NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"source_code" varchar(32) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_type_check" CHECK ("app"."work_item"."work_type_code" = 'COMPLETE_APPLICATION'),
	CONSTRAINT "work_item_target_check" CHECK ("app"."work_item"."target_record_type" = 'CANDIDACY' AND "app"."work_item"."target_record_id" = "app"."work_item"."candidacy_id" AND "app"."work_item"."candidate_action_required"),
	CONSTRAINT "work_item_status_check" CHECK ("app"."work_item"."status" IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELED')),
	CONSTRAINT "work_item_priority_check" CHECK ("app"."work_item"."priority" IN ('NORMAL', 'HIGH')),
	CONSTRAINT "work_item_completed_check" CHECK (("app"."work_item"."status" = 'COMPLETED') = ("app"."work_item"."completed_at" IS NOT NULL)),
	CONSTRAINT "work_item_source_check" CHECK ("app"."work_item"."source_code" IN ('CANDIDACY_TRANSITION', 'BACKFILL', 'RECONCILIATION')),
	CONSTRAINT "work_item_version_check" CHECK ("app"."work_item"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."work_item" ADD CONSTRAINT "work_item_candidacy_fk" FOREIGN KEY ("candidacy_id") REFERENCES "app"."candidacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_active_unique" ON "app"."work_item" USING btree ("candidacy_id","work_type_code","target_record_type","target_record_id") WHERE "app"."work_item"."status" IN ('OPEN', 'IN_PROGRESS', 'BLOCKED');--> statement-breakpoint
CREATE INDEX "work_item_candidate_task_idx" ON "app"."work_item" USING btree ("candidacy_id","candidate_action_required","status","due_at","priority","created_at","id");--> statement-breakpoint
CREATE INDEX "work_item_source_idx" ON "app"."work_item" USING btree ("source_code","work_type_code");--> statement-breakpoint
-- ------------------------------------------------------------------------
-- Hand-written integrity controls (packet M2.3 §10, §23; DATA_MODEL §17.1).
-- Reviewed: fixed search_path, schema-qualified references, no dynamic SQL.
-- Error class CN as in 0006: CN004 immutable reference, CN005 invalid
-- transition.
-- ------------------------------------------------------------------------
CREATE TRIGGER "work_item_no_delete" BEFORE DELETE ON "app"."work_item" FOR EACH ROW EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "work_item_no_truncate" BEFORE TRUNCATE ON "app"."work_item" FOR EACH STATEMENT EXECUTE FUNCTION "app"."candidates_reject_delete"();--> statement-breakpoint
-- A task keeps its identity, and a finished task is history.
CREATE FUNCTION "app"."work_item_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.candidacy_id, NEW.work_type_code, NEW.target_record_type, NEW.target_record_id, NEW.source_code, NEW.created_at)
     IS DISTINCT FROM
     (OLD.candidacy_id, OLD.work_type_code, OLD.target_record_type, OLD.target_record_id, OLD.source_code, OLD.created_at) THEN
    RAISE EXCEPTION 'work item references are immutable' USING ERRCODE = 'CN004';
  END IF;
  IF OLD.status IN ('COMPLETED', 'CANCELED') THEN
    RAISE EXCEPTION 'a finished work item is history' USING ERRCODE = 'CN005';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a work item update adds one version' USING ERRCODE = 'CN005';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "work_item_guard" BEFORE UPDATE ON "app"."work_item" FOR EACH ROW EXECUTE FUNCTION "app"."work_item_guard"();--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."work_item_guard"() FROM PUBLIC;--> statement-breakpoint
-- Backfill: every owned, active APPLICATION_INCOMPLETE candidacy gets its one
-- task. It invents no actor, and only rows that exist at migration time qualify.
INSERT INTO "app"."work_item" ("candidacy_id", "work_type_code", "target_record_type", "target_record_id", "candidate_action_required", "source_code")
SELECT c.id, 'COMPLETE_APPLICATION', 'CANDIDACY', c.id, true, 'BACKFILL'
  FROM "app"."candidacy" c
  JOIN "app"."person" p ON p.id = c.person_id
 WHERE c.status = 'ACTIVE' AND c.current_stage = 'APPLICATION_INCOMPLETE'
   AND p.candidate_account_id IS NOT NULL
ON CONFLICT DO NOTHING;
